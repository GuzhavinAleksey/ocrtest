import 'dotenv/config';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
// We'll use a custom NodeCanvasFactory defined below

// -----------------------------------------------------
// 1. PDF → PNG (в памяти) → Base64
// -----------------------------------------------------
const canvasFactory = {
  create: (width: number, height: number) => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  },
  reset: (canvasAndContext: any, width: number, height: number) => {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  },
  destroy: (canvasAndContext: any) => {
    // no resources to free in @napi-rs/canvas
  },
};

async function pdfPageToBase64(pdfPath: string, pageIdx = 0): Promise<string> {
  // Load PDF data from file
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const fontsPath = path.resolve('node_modules/pdfjs-dist/standard_fonts') + '/';
  const loadingTask = pdfjsLib.getDocument({ data, standardFontDataUrl: fontsPath });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageIdx + 1);
  const viewport = page.getViewport({ scale: 2.0 }); // increase resolution
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  const renderContext: any = {
    canvasContext: context,
    viewport: viewport,
    canvasFactory: canvasFactory,
  };
  await page.render(renderContext).promise;
  // Get PNG buffer
  const pngBuffer = canvas.toBuffer('image/png');
  const outPath = path.resolve(`page-${pageIdx + 1}.png`);
  fs.writeFileSync(outPath, pngBuffer);
  console.log(`Saved → ${outPath}`);
  // Return base64 string of image
  return pngBuffer.toString('base64');
}

// пример вызова
(async () => {
  try {
    const b64 = await pdfPageToBase64('./report.pdf');
    console.log('PDF → PNG (Base64) готов');
  } catch (e) {
    console.error('Ошибка:', e);
  }
})();


// -----------------------------------------------------
// 2. Утилиты для парсинга чисел
// -----------------------------------------------------
type ParseNumber = (s: string) => number;
const parseNumber: ParseNumber = (s) => {
  // \s – обычный пробел,   – неразрывный (U+202F)
  const clean = s.replace(/\s| /g, '');
  return Number(clean);
};

interface Financials {
  non_current_assets?: number;
  current_assets?: number;
  balance?: number;
}

/**
 * Попытка достать финансовые величины из ответа модели.
 * 1) Сначала парсим как JSON.
 * 2) Если JSON‑парсинг не удался – отбираем первые три числа из текста.
 */
function extractFinancialsFromModelAnswer(answer: string): Financials {
  // Try to extract a JSON object from the answer.
  let result: Financials = {};
  try {
    // Remove possible markdown fences.
    const cleaned = answer.replace(/```json|```/g, '').trim();
    const json = JSON.parse(cleaned);
    if (json.non_current_assets !== undefined) result.non_current_assets = parseNumber(String(json.non_current_assets));
    if (json.current_assets !== undefined) result.current_assets = parseNumber(String(json.current_assets));
    if (json.balance !== undefined)
      result.balance = parseNumber(String(json.balance));
    if (Object.keys(result).length) return result;
  } catch (_) {
    // fall back to manual extraction
  }

  // Fallback: look for key‑value pairs like "assets": 12345.
  result = {};
  const keyValueRegex = /"?(non_current_assets|current_assets|balance)"?\s*[:=]\s*([\d\s\u202f.,]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = keyValueRegex.exec(answer)) !== null) {
    const key = match[1] as keyof Financials;
    const raw = match[2];
    const num = parseNumber(raw.replace(/[,]/g, ''));
    if (!isNaN(num)) result[key] = num;
  }
  if (Object.keys(result).length) return result;

  // Last resort: take the first three numbers in order.
  const numbers = answer
    .match(/[\d\s\u202f.,]+/g)
    ?.map(v => parseNumber(v.replace(/[,]/g, '')))
    ?? [];
  if (numbers[0] !== undefined) result.non_current_assets = numbers[0];
  if (numbers[1] !== undefined) result.current_assets = numbers[1];
  if (numbers[2] !== undefined) result.balance = numbers[2];
  return result;
}

// -----------------------------------------------------
// 3. Запрос к Qwen 3.8‑27B (OCR + extraction)
// -----------------------------------------------------
const extractFinancialsWithQwen = async (
  client: OpenAI,
  imgB64: string
): Promise<string> => {
  const dataURL = `data:image/png;base64,${imgB64}`;

  const systemMsg: OpenAI.Chat.ChatCompletionMessageParam = {
    role: 'system',
    content:
      'You are a financial analyst. From the given document extract ONLY the numeric values for the requested fields and output them as a JSON object without any explanations.',
  };

  const userMsg: OpenAI.Chat.ChatCompletionMessageParam = {
    role: 'user',
    content: [
      {
        type: 'image_url',
        image_url: { url: dataURL },
      },
      {
        type: 'text',
        text: `Ты — финансовый аналитик. По приведённому ниже документу (только текст) согласно коду показателя выдели **только** числовые значения На 31 декабря 2025 г. для следующих пунктов и отформатируй их как JSON‑объект без каких‑либо пояснений:
{
  "non_current_assets": <1100>,
  "current_assets": <1200>,
  "balance": <1600>
}
Если какой‑то пункт отсутствует, просто не включай его в объект.
Документ:
"""{{TEXT}}"""`,
      },
    ],
  };

  const response = await client.chat.completions.create({
    // имя модели зависит от вашего провайдера; в большинстве OpenAI‑совместимых сервисов используется:
    //   "qwen-3.8-27b-vision"
    // или аналогичный алиас, указанный в их документации.
    model: 'Qwen/Qwen3.8-27B',
    messages: [systemMsg, userMsg],
    temperature: 0.0,
    max_tokens: 1024,
  });

  if (!response.choices?.[0]?.message?.content) {
    throw new Error('Empty answer from Qwen model');
  }

  return response.choices[0].message.content?.trim() ?? '';
};

// -----------------------------------------------------
// 4. Пример полного вызова
// -----------------------------------------------------
(async () => {
  const client = new OpenAI({
    baseURL: process.env.OPENAI_API_URL, // ваш OpenAI‑совместимый endpoint
    apiKey: process.env.OPENAI_API_KEY,
  });

  const pdfPath = './report.pdf';
  const pageIdx = 10; // первая страница

  try {
    const imgB64 = await pdfPageToBase64(pdfPath, pageIdx);
    const financials = await extractFinancialsWithQwen(client, imgB64);
    const financials_final = extractFinancialsFromModelAnswer(financials);
    console.log('Ответ от модели показатели:', financials);
    console.log('Извлечённые финансовые показатели:', financials_final);
  } catch (err) {
    console.error('Ошибка:', (err as Error).message);
  }
})();
