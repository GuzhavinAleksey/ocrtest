/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

// Номера страниц как в PDF-просмотрщике: с 1. Например: 9-12,15.
export function parsePages(spec: string): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('Страницы задаются списком или диапазонами: 9-12,15');
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > 100000) {
      throw new Error('Некорректный диапазон страниц');
    }
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export async function convertPdfPages(pdfPath: string, pages: number[], outputDir = 'output') {
  if (!pages.length || pages.some(page => !Number.isSafeInteger(page) || page < 1)) throw new Error('Укажите номера страниц, начиная с 1');
  const task = getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    standardFontDataUrl: path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts/'),
  });
  try {
    const pdf = await task.promise;
    if (pages.some(page => page > pdf.numPages)) throw new Error(`В PDF только ${pdf.numPages} страниц`);
    fs.mkdirSync(outputDir, { recursive: true });
    const images: { page: number; path: string; base64: string }[] = [];
    for (const number of [...new Set(pages)].sort((a, b) => a - b)) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const png = canvas.toBuffer('image/png');
      const filename = path.resolve(outputDir, `page-${number}.png`);
      fs.writeFileSync(filename, png);
      images.push({ page: number, path: filename, base64: png.toString('base64') });
      console.error(`Сохранено: ${filename}`);
      page.cleanup();
    }
    return images;
  } finally {
    await task.destroy();
  }
}

if (require.main === module) {
  const [pdfPath, pages, outputDir = 'output'] = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (!pdfPath || !pages) throw new Error('Использование: npm run convert -- report.pdf 9-12,15 output');
    return convertPdfPages(pdfPath, parsePages(pages), outputDir);
  }).catch(error => {
    console.error('Ошибка:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
