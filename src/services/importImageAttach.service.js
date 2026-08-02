// backend/services/fileImport/importImageAttach.service.js
import { generateCatalogImage } from "./catalogImageGen.service.js";
import { convertPngToAvif } from "./cloudinaryConvert.service.js";
import { uploadCatalogImage } from "./catalogImageStorage.service.js";
import { supabase } from "../config/supabase.js";
import { cropRowImage } from "./pdfImageCrop.service.js";

export async function attachImageForRow(row, fileBuffer, jobId) {
    const target = row.brandRow?.isNew ? { table: "hs_product_brands", data: row.brandRow }
        : row.productRow?.isNew ? { table: "hs_products", data: row.productRow }
            : row.subcategoryRow?.isNew ? { table: "hs_subcategories", data: row.subcategoryRow }
                : row.categoryRow?.isNew ? { table: "hs_categories", data: row.categoryRow }
                    : null;
    if (!target) return; // reused an existing catalog entry — no image work at all

    // 1. Try the PDF's own photo first — zero AI cost. row.sourceImage is
    // only ever set when pdfLayout.service.js's row/page mapping was
    // trusted, so this never fires on a shaky guess.
    if (row.sourceImage && row.sourcePage) {
        const avifBuffer = await cropRowImage(fileBuffer, row.sourcePage, row.sourceImage, jobId);
        if (avifBuffer) {
            try {
                const publicUrl = await uploadCatalogImage(avifBuffer, `${target.table}/${target.data.id}.avif`);
                await supabase.from(target.table).update({ image: publicUrl }).eq("id", target.data.id);
                return; // done — no AI call for this row
            } catch (err) {
                console.error(`upload of cropped PDF image failed for ${target.table}/${target.data.id}:`, err.message);
                // fall through to AI generation below
            }
        }
    }

    // 2. No usable source photo (missing, untrusted mapping, or failed
    // sanity checks) — fall back to AI generation, same as before.
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