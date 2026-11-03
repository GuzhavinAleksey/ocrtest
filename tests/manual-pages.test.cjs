require('ts-node/register');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {parsePages,convertPdfPages}=require('../src/convert');
const {extractFinancialsFromModelAnswer,mergeFinancials,processReport,extractFinancialsWithQwen}=require('../src/qwen');
const {INDICATOR_CODES}=require('../src/indicator-codes');

test('manual pages accept lists/ranges, deduplicate and reject invalid input',()=>{
  assert.deepEqual(parsePages('12,9-11,10, 15'),[9,10,11,12,15]);
  for(const value of ['', '0','-1','12-9','1,','abc','1.5','9007199254740992'])assert.throws(()=>parsePages(value));
});

test('JSON handler covers all 198 supplied indicators, preserves signs, zero, decimals and null',()=>{
  assert.equal(Object.keys(INDICATOR_CODES).length,198);
  for(const [code,name]of Object.entries(INDICATOR_CODES)){
    assert.deepEqual(extractFinancialsFromModelAnswer(JSON.stringify({[code]:'(1 234)'})),{[name]:-1234});
  }
  assert.deepEqual(extractFinancialsFromModelAnswer('```json\n{"basic_earnings_per_share":"0,48","balance":0,"current_assets":"—"}\n```'),{basic_earnings_per_share:.48,balance:0,current_assets:null});
  for(const value of ['plain text 123 456','[]','null','{"balance":true}','{"balance":"abc"}','{"unknown":1}','{"constructor":1}','{"__proto__":1}'])assert.throws(()=>extractFinancialsFromModelAnswer(value));
});

test('merge preserves known values and rejects contradictions',()=>{
  const result={balance:123};
  mergeFinancials(result,{balance:null,current_assets:0});
  assert.deepEqual(result,{balance:123,current_assets:0});
  assert.throws(()=>mergeFinancials(result,{balance:456}),/Разные значения/);
});

test('model prompt contains full mapping and truncated model replies fail',async()=>{
  let request;
  const client={chat:{completions:{create:async value=>{request=value;return{choices:[{finish_reason:'stop',message:{content:'{"balance":123}'}}]};}}}};
  assert.equal(await extractFinancialsWithQwen(client,'png-data'),'{"balance":123}');
  const text=request.messages[1].content[1].text;
  for(const [code,name]of Object.entries(INDICATOR_CODES))assert(text.includes(`"${name}": <${code}>`));
  assert.equal(request.messages[1].content[0].image_url.url,'data:image/png;base64,png-data');
  client.chat.completions.create=async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]});
  await assert.rejects(extractFinancialsWithQwen(client,'data'),/Неполный/);
});

test('selected PDF pages are rendered, sent to model and merged into a flat JSON',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'manual-pdf-'));
  let calls=0;
  const client={chat:{completions:{create:async request=>{
    assert.match(request.messages[1].content[0].image_url.url,/^data:image\/png;base64,iVBOR/);
    calls++;
    return {choices:[{finish_reason:'stop',message:{content:calls===1?'{"non_current_assets":100,"balance":150}':'{"total_equity":50,"total_equity_and_liabilities":150}'}}]};
  }}}};
  try{
    const result=await processReport(client,path.resolve(__dirname,'../report.pdf'),[11,12],dir);
    assert.equal(calls,2);
    assert.deepEqual(result,{non_current_assets:100,balance:150,total_equity:50,total_equity_and_liabilities:150});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'financials.json'),'utf8')),result);
    assert.deepEqual(fs.readdirSync(dir).sort(),['financials.json','page-11.png','page-12.png']);
    await assert.rejects(convertPdfPages(path.resolve(__dirname,'../report.pdf'),[66],dir),/65 страниц/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
