// backend/services/fileImport/runImportJob.service.js
import { supabase } from "../config/supabase.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getPageRaster, clearRasterCache } from "./pdfPageRaster.service.js";
import { classifyPageVision } from "./visionClassify.service.js";
import { resolveImportRow } from "./importResolver.service.js";
import { computeLandingDecision } from "./importLanding.service.js";
import { getShortlistsForEmbedding } from "./catalogShortlist.service.js";
import { embedTexts } from "./embeddings.service.js";
import { uploadCatalogImage } from "./catalogImageStorage.service.js";
import { convertPngToAvif } from "./cloudinaryConvert.service.js";
import { generateCatalogImage } from "./catalogImageGen.service.js";
import { categoryImagePrompt, subcategoryImagePrompt, productImagePrompt, brandImagePrompt, generateAndAttachImage } from "./catalogResolver.service.js";
import sharp from "sharp";


// Collects EVERY newly-created level on this row, not just the deepest.
// This is the actual fix: previously only the single most-specific new
// row (e.g. the brand) got image work; a product or category that was
// ALSO new on the same row silently got skipped forever.
function getNewTargetsForRow(row) {
    const targets = [];
    if (row.categoryRow?.isNew) targets.push({ level: "category", table: "hs_categories", data: row.categoryRow });
    if (row.subcategoryRow?.isNew) targets.push({ level: "subcategory", table: "hs_subcategories", data: row.subcategoryRow });
    if (row.productRow?.isNew) targets.push({ level: "product", table: "hs_products", data: row.productRow });
    if (row.brandRow?.isNew) targets.push({ level: "brand", table: "hs_product_brands", data: row.brandRow });
    return targets;
}

async function attachImageForTarget(row, target, fileBuffer, jobId) {
    // Cropping straight from the PDF was giving noticeably lower quality
    // than the AI-generated catalog images used for every other level —
    // skip the crop attempt entirely and always generate for brand items
    // too, so all four levels get the same polished, consistent look.
    // (Previous crop-first behavior is commented below in case you want
    // to A/B it again later.)
    //
    // if (target.level === "brand" && row.hasImage && row.imageBbox && row.sourcePage) {
    //     const cropped = await tryBboxCrop(row, target, fileBuffer, jobId);
    //     if (cropped) return;
    // }

    const prompt =
        target.level === "brand" ? brandImagePrompt(target.data.name, row.classification?.brand_name, row.classification?.brand_attributes, row.categoryRow?.name, row.subcategoryRow?.name)
            : target.level === "product" ? productImagePrompt(target.data.name, row.classification?.description, row.categoryRow?.name, row.subcategoryRow?.name)
                : target.level === "subcategory" ? subcategoryImagePrompt(target.data.name, row.categoryRow?.name)
                    : categoryImagePrompt(target.data.name);

    console.log(`background image gen starting for ${target.level} ${target.data.id}`);
    const url = await generateAndAttachImage(target.table, target.data.id, prompt);
    console.log(`background image gen ${url ? "done" : "failed"} for ${target.level} ${target.data.id}`);
}

async function tryBboxCrop(row, target, fileBuffer, jobId) {
    try {
        const raster = await getPageRaster(fileBuffer, row.sourcePage, jobId);
        const { width: pw, height: ph } = raster.viewport;
        const left = Math.max(0, Math.round(row.imageBbox.x * pw));
        const top = Math.max(0, Math.round(row.imageBbox.y * ph));
        const width = Math.min(pw - left, Math.round(row.imageBbox.width * pw));
        const height = Math.min(ph - top, Math.round(row.imageBbox.height * ph));
        if (width <= 20 || height <= 20) return false;

        const avifBuffer = await sharp(raster.pngBuffer).extract({ left, top, width, height }).toFormat("avif", { quality: 65 }).toBuffer();
        const publicUrl = await uploadCatalogImage(avifBuffer, `${target.table}/${target.data.id}.avif`);
        await supabase.from(target.table).update({ image: publicUrl }).eq("id", target.data.id);
        return true;
    } catch (err) {
        console.error(`bbox crop failed for ${target.table}/${target.data.id}:`, err.message);
        return false;
    }
}

export async function runImportJob(jobId, fileBuffer) {
    try {
        await updateJob(jobId, { progress: { processed: 0, total: 0, phase: "reading_pdf" } });

        const data = new Uint8Array(fileBuffer);
        const doc = await getDocument({ data }).promise;
        const numPages = doc.numPages;

        const resolvedRows = [];
        const jobCache = new Map();
        const sessionExtras = { categories: [], subcategories: [], products: [], brands: [] };
        let processed = 0;
        let rowCounter = 0;

        await updateJob(jobId, { progress: { processed: 0, total: numPages, phase: "classifying" } });

        for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
            const page = await doc.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const rawPageText = textContent.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();

            const raster = await getPageRaster(fileBuffer, pageNumber, jobId);
            const pageImagePngBase64 = raster.pngBuffer.toString("base64");

            // Rough shortlist for this page from its whole raw text — good
            // enough to steer the vision call; per-item precision still
            // comes from resolveImportRow's DB-level dedup safety nets.
            const pageEmbedding = (await embedTexts([rawPageText || `page ${pageNumber}`]))[0];
            const dbShortlists = await getShortlistsForEmbedding(pageEmbedding);

            let items;
            try {
                items = await classifyPageVision({
                    pageImagePngBase64,
                    rawPageText: rawPageText || "(no extractable text on this page)",
                    shortlists: mergeWithSessionExtras(dbShortlists, sessionExtras),
                });
            } catch (err) {
                console.error(`vision classify failed for page ${pageNumber}:`, err.message);
                items = [];
            }

            console.log(`page ${pageNumber}: vision found ${items.length} product entries`);

            for (const item of items) {
                rowCounter++;
                const rowId = `p${pageNumber}-i${rowCounter}`;

                if (!item.valid) {
                    resolvedRows.push({ rowId, resolved: false, reason: item.rejection_reason });
                    continue;
                }

                const namesToEmbed = [];
                if (item.new_category_name) namesToEmbed.push({ key: "category", text: item.new_category_name });
                if (item.new_subcategory_name) namesToEmbed.push({ key: "subcategory", text: item.new_subcategory_name });
                if (item.generic_name) namesToEmbed.push({ key: "product", text: item.generic_name });
                if (item.is_branded && item.brand_item_name) namesToEmbed.push({ key: "brand", text: item.brand_item_name });
                const embeddedValues = namesToEmbed.length ? await embedTexts(namesToEmbed.map((n) => n.text)) : [];
                const embeddingByKey = Object.fromEntries(namesToEmbed.map((n, k) => [n.key, embeddedValues[k]]));

                const liveShortlists = mergeWithSessionExtras(dbShortlists, sessionExtras);
                const result = await resolveImportRow({ classification: item, shortlists: liveShortlists, embeddingByKey, log: console, jobCache });

                resolvedRows.push({
                    rowId, ...result,
                    hasImage: item.has_image, imageBbox: item.image_bbox,
                    sourcePage: pageNumber, classification: item,
                });
                recordIntoSessionExtras(sessionExtras, result);
            }

            processed++;
            await updateJob(jobId, { progress: { processed, total: numPages, phase: "classifying" } });
        }

        // ---- image attach: crop straight from the page raster using the
        // model's own bbox — no XObject/geometry matching involved at all,
        // so the image can never be paired with the wrong item.
        await updateJob(jobId, { progress: { processed, total: numPages, phase: "attaching_images" } });

        const seenImageTargets = new Set();
        const imageTasks = [];
        for (const row of resolvedRows) {
            if (!row.resolved) continue;
            for (const target of getNewTargetsForRow(row)) {
                const key = `${target.level}:${target.data.id}`;
                if (seenImageTargets.has(key)) continue;
                seenImageTargets.add(key);
                imageTasks.push({ row, target });
            }
        }
        await Promise.all(imageTasks.map(({ row, target }) => attachImageForTarget(row, target, fileBuffer, jobId)));
        clearRasterCache(jobId);


        const landing = computeLandingDecision(resolvedRows);
        await updateJob(jobId, { status: "done", landing, summary: landing.summary });
    } catch (err) {
        console.error(`import job ${jobId} failed:`, err);
        clearRasterCache(jobId);
        await updateJob(jobId, { status: "failed", message: err.message });
    }
}

async function attachImageFromBbox(row, fileBuffer, jobId) {
    const target = row.brandRow?.isNew ? { table: "hs_product_brands", data: row.brandRow }
        : row.productRow?.isNew ? { table: "hs_products", data: row.productRow }
            : row.subcategoryRow?.isNew ? { table: "hs_subcategories", data: row.subcategoryRow }
                : row.categoryRow?.isNew ? { table: "hs_categories", data: row.categoryRow }
                    : null;
    if (!target) return;

    if (row.hasImage && row.imageBbox && row.sourcePage) {
        try {
            const raster = await getPageRaster(fileBuffer, row.sourcePage, jobId);
            const { width: pw, height: ph } = raster.viewport;
            const left = Math.max(0, Math.round(row.imageBbox.x * pw));
            const top = Math.max(0, Math.round(row.imageBbox.y * ph));
            const width = Math.min(pw - left, Math.round(row.imageBbox.width * pw));
            const height = Math.min(ph - top, Math.round(row.imageBbox.height * ph));

            if (width > 20 && height > 20) {
                const avifBuffer = await sharp(raster.pngBuffer)
                    .extract({ left, top, width, height })
                    .toFormat("avif", { quality: 65 })
                    .toBuffer();
                const publicUrl = await uploadCatalogImage(avifBuffer, `${target.table}/${target.data.id}.avif`);
                await supabase.from(target.table).update({ image: publicUrl }).eq("id", target.data.id);
                return;
            }
        } catch (err) {
            console.error(`bbox crop failed for ${target.table}/${target.data.id}:`, err.message);
        }
    }

    // No usable extracted photo -> AI generation fallback, unchanged.
    try {
        const name = target.data.name;
        const prompt = `Product photo of "${name}" for a B2B industrial marketplace catalog, professional catalog photography, no text, no watermark, no logos, sharp focus, realistic materials and lighting, centered with generous negative space.`;
        const pngBase64 = await generateCatalogImage(prompt);
        const avifBuffer = await convertPngToAvif(pngBase64, `${target.table}-${target.data.id}`);
        const publicUrl = await uploadCatalogImage(avifBuffer, `${target.table}/${target.data.id}.avif`);
        await supabase.from(target.table).update({ image: publicUrl }).eq("id", target.data.id);
    } catch (err) {
        console.error(`AI image pipeline failed for ${target.table}/${target.data.id}:`, err.message);
    }
}

function mergeWithSessionExtras(dbShortlists, sessionExtras) {
    const combine = (key) => {
        const seen = new Map();
        for (const item of dbShortlists[key]) seen.set(item.id, item);
        for (const item of sessionExtras[key]) seen.set(item.id, item);
        return [...seen.values()];
    };
    return { categories: combine("categories"), subcategories: combine("subcategories"), products: combine("products"), brands: combine("brands") };
}

function recordIntoSessionExtras(sessionExtras, result) {
    // NOTE: similarity is intentionally OMITTED here (not set to 1).
    // These entries are still shown to the LLM as match_*_id candidates
    // (formatProductShortlist etc. only use id/name, not similarity), but
    // they must NEVER auto-satisfy a numeric dedupe-floor check like
    // `.find(p => p.similarity >= FLOOR)` just because they exist — that's
    // exactly what caused every brand/product under a shared parent to
    // collapse onto whichever one was created first in the session.
    if (result.categoryRow) {
        sessionExtras.categories.push({ id: result.categoryRow.id, name: result.categoryRow.name });
    }
    if (result.subcategoryRow) {
        sessionExtras.subcategories.push({
            id: result.subcategoryRow.id, name: result.subcategoryRow.name,
            category_id: result.categoryRow?.id, category_name: result.categoryRow?.name,
        });
    }
    if (result.productRow) {
        sessionExtras.products.push({
            id: result.productRow.id, name: result.productRow.name,
            subcategory_id: result.subcategoryRow?.id, subcategory_name: result.subcategoryRow?.name,
            category_name: result.categoryRow?.name,
        });
    }
    if (result.brandRow) {
        sessionExtras.brands.push({
            id: result.brandRow.id, name: result.brandRow.name, product_id: result.productRow?.id,
        });
    }
}

async function updateJob(jobId, patch) {
    await supabase.from("hs_import_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", jobId);
}