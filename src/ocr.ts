import 'dotenv/config'; 
import OpenAI from 'openai';                     // OpenAI‑SDK [8]
import * as fs from 'fs';
import * as path from 'path';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, Image } from 'canvas';   // Node‑canvas – рендер PDF в PNG
import { PdfPageToBase64,
    OcrWithGLMOCR,
    ParseNumber,
    ExtractFromOCR,
    Financials} from './ocr_type';   // Node‑canvas – рендер PDF в PNG
import { Buffer } from 'buffer';

// -------------------------------------------------------------------
// 2. PDF → PNG (в памяти) → Base64
// -------------------------------------------------------------------
const pdfPageToBase64: PdfPageToBase64= async (
  pdfPath,
  pageIdx
) => {
  // 1️⃣ Указываем путь к воркеру pdfjs
  const workerPath = path.join(
    path.dirname(require.resolve('pdfjs-dist')),
    'legacy/build/pdf.worker.js'
  );
  GlobalWorkerOptions.workerSrc = workerPath;

  // 2️⃣ Загружаем PDF
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data }).promise;
  const page = await doc.getPage(pageIdx + 1); // pdfjs считает страницы от 1

  // 3️⃣ Формируем канвас (node‑canvas)
  const viewport = page.getViewport({ scale: 2.0 }); // 2× → хорошее качество
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');

  // 4️⃣ Рендерим страницу.  • Передаём оба свойства: canvasContext и canvas
  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D, // приведение типов
    // node‑canvas «Canvas» совместим с HTMLCanvasElement, но типы различаются –
    // поэтому делаем двойное приведение через unknown → any → HTMLCanvasElement
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport,
  }).promise;

  // 5️⃣ Получаем PNG‑буфер → base64
  const pngBuffer = canvas.toBuffer('image/png');
  return pngBuffer.toString('base64');
};

// -------------------------------------------------------------------
// 3. OCR‑запрос к модели glm‑ocr
// -------------------------------------------------------------------
const ocrWithGLMOCR: OcrWithGLMOCR = async (
  client,
  imgB64
) => {
  // Формируем data‑URL как требует спецификация OpenAI [4]
  const dataURL = `data:image/png;base64,${imgB64}`;

  const systemMsg: OpenAI.Chat.ChatCompletionMessageParam = {
    role: 'system',
    content: 'You are an OCR model. Return ONLY the plain text of the image, without any explanations.'
  };

  const userMsg: OpenAI.Chat.ChatCompletionMessageParam = {
    role: 'user',
    content: [
      {
        type: 'image_url',
        image_url: { url: dataURL }
      }
    ]
  };

  const response = await client.chat.completions.create({
    model: 'glm-ocr',                 // имя модели в vLLM
    messages: [systemMsg, userMsg],
    max_tokens: 2048,
    temperature: 0.0,
  });

  if (response.choices.length === 0) {
    throw new Error('empty OCR response');
  }
  return response.choices[0].message.content ?? '';
}

// -------------------------------------------------------------------
// 4. Парсинг финансовых цифр из OCR‑текста
// -------------------------------------------------------------------

// Убираем пробелы/неразрывные пробелы и переводим в число
const parseNumber: ParseNumber = (s) => {
  const clean = s.replace(/\s| /g, ''); // \s – обычный,   – неразрывный
  return Number(clean);
}

const extractFromOCR: ExtractFromOCR = (text) => {
  const result: Financials = {};

  const reAssets = /внеоборотные\s+активы[^\d]+([\d\s ]+)/i;
  const mAssets = text.match(reAssets);
  if (mAssets?.[1]) result.assets = parseNumber(mAssets[1]);

  const reProfit = /чистая\s+прибыль[^\d]+([\d\s ]+)/i;
  const mProfit = text.match(reProfit);
  if (mProfit?.[1]) result.netProfit = parseNumber(mProfit[1]);

  const reFinInv = /финансовые\s+вложения[^\d]+([\d\s ]+)/i;
  const mFinInv = text.match(reFinInv);
  if (mFinInv?.[1]) result.financialInvestments = parseNumber(mFinInv[1]);

  return result;
}

// -------------------------------------------------------------------
// 5. Пример использования
// -------------------------------------------------------------------
(async () => {
  const client = new OpenAI({ baseURL: process.env.OPENAI_API_URL, apiKey: process.env.OPENAI_API_KEY }); // инициализация клиента

  const pdfPath = './report.pdf';
  const pageIdx = 0; // первая страница

  try {
    const imgB64 = await pdfPageToBase64(pdfPath, pageIdx);
    const ocrText = await ocrWithGLMOCR(client, imgB64);
    console.log('OCR‑текст:\n', ocrText);

    const financials = extractFromOCR(ocrText);
    console.log('Извлечённые цифры:', financials);
  } catch (e) {
    console.error('Ошибка:', (e as Error).message);
  }
})();
