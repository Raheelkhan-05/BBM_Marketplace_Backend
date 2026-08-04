// backend/services/fileImport/pdfImageCrop.service.js
//
// Extracts an already-existing product photo straight out of the PDF for
// a given row, instead of generating one with AI. This is the actual cost
// control: only rows where this returns null fall through to AI image
// generation in importImageAttach.service.js.
//
// We rasterize the whole page once (via @napi-rs/canvas, which ships
// prebuilt binaries and works reliably in serverless environments, unlike
// node-canvas which needs native cairo bindings) and crop the bbox — we
// don't hand-decode the XObject bytes ourselves, since pdfjs already
// handles every PDF image encoding correctly during normal rendering.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { STANDARD_FONT_DATA_URL } from "./pdfStandardFonts.js";


const RENDER_SCALE = 2.5; // higher = crisper crops; tune against render time/memory

// Sanity thresholds so a stray logo, watermark, or table-border line never
// gets uploaded as if it were the product photo — false mapping is worse
// than falling back to AI, so we're conservative here on purpose.
const MIN_CROP_PX = 60;
const MAX_ASPECT_RATIO = 6;

// Per-job page raster cache so N rows on the same page only render once.
const pageRasterCache = new Map(); // `${jobId}:${pageNumber}` -> { canvas, viewport }

export async function cropRowImage(fileBuffer, pageNumber, bbox, jobId) {
    if (!bbox || bbox.width < 4 || bbox.height < 4) return null;

    const raster = await getOrRenderPage(fileBuffer, pageNumber, jobId);
    if (!raster) return null;

    const rect = pdfRectToPixels(bbox, raster.viewport);
    if (!rect) return null;
    if (rect.width < MIN_CROP_PX || rect.height < MIN_CROP_PX) return null;
    const aspect = Math.max(rect.width, rect.height) / Math.min(rect.width, rect.height);
    if (aspect > MAX_ASPECT_RATIO) return null;

    try {
        return await sharp(raster.canvas.toBuffer("image/png"))
            .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
            .toFormat("avif", { quality: 65 })
            .toBuffer();
    } catch (err) {
        console.error(`pdf image crop failed for page ${pageNumber}:`, err.message);
        return null;
    }
}

async function getOrRenderPage(fileBuffer, pageNumber, jobId) {
    const key = `${jobId}:${pageNumber}`;
    if (pageRasterCache.has(key)) return pageRasterCache.get(key);

    try {
        const data = new Uint8Array(fileBuffer);
        const doc = await getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = createCanvas(viewport.width, viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

        const result = { canvas, viewport };
        pageRasterCache.set(key, result);
        return result;
    } catch (err) {
        console.error(`pdf page raster failed for page ${pageNumber}:`, err.message);
        return null;
    }
}

// PDF space is bottom-left origin; canvas pixel space is top-left origin —
// convertToViewportPoint handles that flip + the RENDER_SCALE for us.
function pdfRectToPixels(bbox, viewport) {
    const [x1, y2] = viewport.convertToViewportPoint(bbox.x, bbox.y);
    const [x2, y1] = viewport.convertToViewportPoint(bbox.x + bbox.width, bbox.y + bbox.height);
    const left = Math.max(0, Math.round(Math.min(x1, x2)));
    const top = Math.max(0, Math.round(Math.min(y1, y2)));
    let width = Math.round(Math.abs(x2 - x1));
    let height = Math.round(Math.abs(y2 - y1));
    if (width <= 0 || height <= 0) return null;
    if (left + width > viewport.width) width = viewport.width - left;
    if (top + height > viewport.height) height = viewport.height - top;
    return { left, top, width, height };
}

// Call once per job when it finishes, so rasters don't linger in memory
// on a long-running process.
export function clearRasterCache(jobId) {
    for (const key of [...pageRasterCache.keys()]) {
        if (key.startsWith(`${jobId}:`)) pageRasterCache.delete(key);
    }
}