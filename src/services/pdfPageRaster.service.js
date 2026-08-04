// backend/services/fileImport/pdfPageRaster.service.js
// Shared page rasterization — used by both vision classification and
// image cropping, so a page is only rendered once per job.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { STANDARD_FONT_DATA_URL } from "./pdfStandardFonts.js";

const RENDER_SCALE = 2.5;
const rasterCache = new Map(); // `${jobId}:${pageNumber}` -> { canvas, viewport, pngBuffer }

export async function getPageRaster(fileBuffer, pageNumber, jobId) {
    const key = `${jobId}:${pageNumber}`;
    if (rasterCache.has(key)) return rasterCache.get(key);

    const data = new Uint8Array(fileBuffer);
    const doc = await getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const result = { canvas, viewport, pngBuffer: canvas.toBuffer("image/png") };
    rasterCache.set(key, result);
    return result;
}

export function clearRasterCache(jobId) {
    for (const key of [...rasterCache.keys()]) {
        if (key.startsWith(`${jobId}:`)) rasterCache.delete(key);
    }
}