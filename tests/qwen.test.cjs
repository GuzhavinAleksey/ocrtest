require('ts-node/register');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {detectForm, parseNumber, parseModelAnswer, extractFinancialsWithQwen, processPdf} = require('../src/qwen');

test('form detection includes continuations but excludes mentions in notes', () => {
  assert.equal(detectForm('Форма по ОКУД 0710001 Наименование показателя Код показателя'), '0710001');
  assert.equal(detectForm('Форма 0710005 с.3 Н а и м е н о в а н и е Код п о к а з а т е л я'), '0710005');
  assert.equal(detectForm('Пояснения к форме 0710001'), undefined);
  assert.equal(detectForm('Форма 0710003 Наименование Код показателя'), undefined);
});

test('financial numbers preserve signs, decimals, zero and missing cells', () => {
  assert.equal(parseNumber('(1\u202f076 329 869)'), -1076329869);
  assert.equal(parseNumber('0,48'), .48);
  assert.equal(parseNumber('0'), 0);
  assert.equal(parseNumber('—'), null);
  assert.equal(parseNumber(null), null);
  for (const value of ['', '12abc', {}, true, '9007199254740992']) assert.throws(() => parseNumber(value));
});

test('strict JSON response validation rejects fabricated codes, duplicates and malformed data', () => {
  const row = {code:'2900', name:'Базовая прибыль на акцию', values:{'2025':'0,48','2024':'(45,47)'}};
  assert.deepEqual(parseModelAnswer('```json\n'+JSON.stringify({indicators:[row]})+'\n```', '0710002')[0].values, {'2025':.48,'2024':-45.47});
  for (const indicators of [[], [row,row], [{...row,code:'9999'}], [{...row,values:[]}], [{...row,values:{}}]]) {
    assert.throws(() => parseModelAnswer(JSON.stringify({indicators}), '0710002'));
  }
  assert.throws(() => parseModelAnswer('произвольные числа 123 456', '0710002'));
});

test('Qwen request sends an image, complete form code list and configured model', async () => {
  let request;
  const client = {chat:{completions:{create:async input => {
    request=input;
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({indicators:[{code:'3300',name:'На 31 декабря 2025',values:{'Уставный капитал':118367564,'Собственные акции':null,'Накопленная дооценка':null,'Добавочный капитал':205771762,'Резервный капитал':8636001,'Нераспределенная прибыль':16099447559,'Итого':16432222886}}]})}}]};
  }}}};
  const rows = await extractFinancialsWithQwen(client, Buffer.from('image'), '0710004', 16, 'local-model');
  assert.equal(request.model,'local-model');
  assert.match(request.messages[1].content[0].image_url.url,/^data:image\/png;base64,/);
  assert.match(request.messages[1].content[1].text,/3349/);
  assert.equal(Object.keys(rows[0].values).length,7);
  client.chat.completions.create=async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]});
  await assert.rejects(extractFinancialsWithQwen(client,Buffer.from('image'),'0710004',16,'local-model'), /Незавершённый/);
});

test('report.pdf converts only nine target form pages and writes a JSON manifest without API access', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocrtest-'));
  try {
    const result=await processPdf(path.resolve(__dirname,'../report.pdf'),dir,{convertOnly:true});
    assert.deepEqual(result.pages.map(p=>[p.page,p.form]), [[11,'0710001'],[12,'0710001'],[13,'0710002'],[14,'0710002'],[15,'0710004'],[16,'0710004'],[17,'0710005'],[18,'0710005'],[19,'0710005']]);
    assert.equal(fs.readdirSync(dir).filter(f=>f.endsWith('.png')).length,9);
    for(const page of result.pages) {
      const png=fs.readFileSync(path.join(dir,page.png));
      assert.equal(png.subarray(1,4).toString(),'PNG');
      assert(png.length>1000);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),result);
    assert(!fs.existsSync(path.join(dir,'financials.json')));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('complete pipeline writes extracted JSON using a mock API, with one request per selected page', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocrtest-api-'));
  const calls=[];
  const {FORM_CODES}=require('../src/qwen');
  const client={chat:{completions:{create:async input=>{
    const prompt=input.messages[1].content[1].text;
    const [,page,form]=prompt.match(/Страница PDF (\d+), форма по ОКУД (\d+)/);
    calls.push(Number(page));
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({indicators:[{code:FORM_CODES[form][0],name:'Тестовая строка API (не данные отчёта)',values:{'Тестовый столбец':'(123 456)'}}]})}}]};
  }}}};
  try {
    const result=await processPdf(path.resolve(__dirname,'../report.pdf'),dir,{client,model:'mock-vision'});
    assert.deepEqual(calls,[11,12,13,14,15,16,17,18,19]);
    assert.equal(result.status,'extracted');
    assert.equal(result.pages.length,9);
    for(const page of result.pages) assert.equal(page.indicators[0].values['Тестовый столбец'],-123456);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'financials.json'),'utf8')),result);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
