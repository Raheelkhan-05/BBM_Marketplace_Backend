// controllers/adminCatalogFullBulk.controller.js
//
// Lets an admin upload ONE Excel file containing brand items that span
// many different categories / subcategories / generic products at once,
// instead of having to drill into each generic product and bulk-upload
// separately. Category / Subcategory / Generic Product are resolved by
// NAME (case-insensitive) — if a node with that name already exists under
// the right parent it's reused, otherwise it's created on the fly. Only
// the leaf (brand item) requires images; the three hierarchy levels above
// it can be created from name alone.

import * as XLSX from "xlsx";
import { supabase } from "../config/supabase.js";
import { slugify } from "../services/slugify.js";
import { ALLOWED_UNITS } from "./sellerCatalogListings.controller.js";

const FULL_HEADERS = [
    "Category Name", "Category Image",
    "Subcategory Name", "Subcategory Image",
    "Generic Product Name", "Generic Product Image",
    "Product Name", "Brand Name", "Manufacturer", "Model/Part No/SKU",
    "Grade/Variant",
    "Unit", "Pack Size", "Units per Master Pack",
    "Specifications", "Image Links",
];
// Only these are non-negotiable. Category/Subcategory/Generic Product
// *Image* columns are intentionally absent from this list — the whole
// point is that the hierarchy can be created from names alone.
const REQUIRED_HEADERS = [
    "Category Name", "Subcategory Name", "Generic Product Name",
    "Product Name", "Brand Name", "Manufacturer", "Model/Part No/SKU",
    "Unit", "Pack Size", "Units per Master Pack",
    "Image Links",
];

// ---- same URL-resolution helpers used by the single-level bulk uploader ----

function driveToDirectImageUrl(url) {
    const fileIdMatch =
        url.match(/drive\.google\.com\/file\/d\/([^/]+)/) ||
        url.match(/[?&]id=([^&]+)/);
    if (fileIdMatch) return `https://drive.google.com/thumbnail?id=${fileIdMatch[1]}&sz=w1000`;
    return null;
}

async function resolveImgbbDirectUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`imgbb page returned HTTP ${res.status}`);
    const html = await res.text();
    const match = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (!match) throw new Error("couldn't find image on that imgbb page");
    return match[1];
}

async function toDirectImageUrl(rawUrl) {
    const trimmed = (rawUrl || "").trim();
    if (!trimmed) return trimmed;
    const drive = driveToDirectImageUrl(trimmed);
    if (drive) return drive;
    if (/^https?:\/\/ibb\.co\//i.test(trimmed)) {
        try { return await resolveImgbbDirectUrl(trimmed); }
        catch { return trimmed; }
    }
    return trimmed;
}

function isDirectImageUrl(url) {
    const trimmed = (url || "").trim();
    if (!/^https?:\/\/\S+$/i.test(trimmed)) return false;
    if (/^https?:\/\/ibb\.co\//i.test(trimmed)) return false;
    if (/drive\.google\.com\/file\/d\//i.test(trimmed) && !/\/thumbnail\?/i.test(trimmed)) return false;
    if (/drive\.google\.com\/open\?/i.test(trimmed)) return false;
    return true;
}

async function parseImageLinks(raw) {
    const urls = String(raw || "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    return Promise.all(urls.map(toDirectImageUrl));
}

function parseSpecifications(raw) {
    return String(raw || "")
        .split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)
        .map((pair) => {
            const idx = pair.indexOf(":");
            if (idx === -1) return null;
            const key = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            if (!key || !value) return null;
            return { key, value };
        })
        .filter(Boolean);
}

function parseWorkbook(buffer) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function headersMatch(rows, expected) {
    if (!rows.length) return false;
    const actual = Object.keys(rows[0]).map((h) => h.trim());
    return expected.every((h) => actual.includes(h));
}

// ---- template download -----------------------------------------------

// GET /api/admin/catalog-bulk/excel-template
export async function downloadFullCatalogTemplate(req, res) {
    const exampleRow = {
        "Category Name": "Lubricants",
        "Category Image": "",
        "Subcategory Name": "Two-wheeler engine oil",
        "Subcategory Image": "",
        "Generic Product Name": "Motorcycle engine oil 1L bottle",
        "Generic Product Image": "",
        "Product Name": "Shell Advance AX7 10W30",
        "Brand Name": "Shell",
        "Manufacturer": "Shell India Markets Pvt Ltd",
        "Model/Part No/SKU": "AX7-10W30-1L",
        "Grade/Variant": "10W-30",
        "Unit": "Litres",
        "Pack Size": "1",
        "Units per Master Pack": "12",
        "Specifications": "Volume: 1L; API Grade: SL",
        "Image Links": "https://example.com/front.jpg, https://example.com/back.jpg",
    };

    const ws = XLSX.utils.json_to_sheet([exampleRow], { header: FULL_HEADERS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="full-catalog-upload-template.xlsx"`);
    res.send(buf);
}

// ---- resolve-or-create for one hierarchy node --------------------------
//
// `cache` is a Map shared across the whole upload run so we never look up
// (or re-create) the same node twice, even if 500 rows all say "Lubricants".
// Keyed by parentId + lowercased name so the same name under two different
// parents is correctly treated as two different nodes.

async function resolveOrCreateNode({ table, name, parentCol, parentId, imageUrl, cache }) {
    const trimmedName = name.trim();
    const cacheKey = `${table}::${parentCol ? parentId : "root"}::${trimmedName.toLowerCase()}`;
    if (cache.has(cacheKey)) return { id: cache.get(cacheKey), created: false };

    let findQuery = supabase.from(table).select("id").ilike("name", trimmedName).limit(1);
    if (parentCol) findQuery = findQuery.eq(parentCol, parentId);
    const { data: foundRows, error: findErr } = await findQuery;
    if (findErr) throw new Error(findErr.message);
    if (foundRows?.[0]) {
        cache.set(cacheKey, foundRows[0].id);
        return { id: foundRows[0].id, created: false };
    }

    const insertRow = {
        name: trimmedName,
        slug: slugify(`${trimmedName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        is_ai_generated: false,
        review_status: "approved",
    };
    if (parentCol) insertRow[parentCol] = parentId;
    if (imageUrl) insertRow.image = imageUrl;

    const { data: created, error: insertErr } = await supabase
        .from(table).insert(insertRow).select("id").single();

    if (insertErr) {
        // Someone else (a concurrent row in this same batch, or another
        // request) created the same node a moment ago — reuse it instead
        // of failing the row.
        if (insertErr.code === "23505") {
            let retryQuery = supabase.from(table).select("id").ilike("name", trimmedName).limit(1);
            if (parentCol) retryQuery = retryQuery.eq(parentCol, parentId);
            const { data: retryRows } = await retryQuery;
            if (retryRows?.[0]) {
                cache.set(cacheKey, retryRows[0].id);
                return { id: retryRows[0].id, created: false };
            }
        }
        throw new Error(insertErr.message);
    }

    cache.set(cacheKey, created.id);
    return { id: created.id, created: true };
}

// ---- main upload handler ------------------------------------------------

// POST /api/admin/catalog-bulk/excel-upload   (multipart: file)
export async function bulkUploadFullCatalog(req, res) {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });

    let rows;
    try {
        rows = parseWorkbook(req.file.buffer);
    } catch {
        return res.status(400).json({ success: false, message: "Couldn't read that file. Please upload a valid .xlsx file." });
    }
    if (!rows.length) return res.status(400).json({ success: false, message: "The file is empty." });

    if (!headersMatch(rows, REQUIRED_HEADERS)) {
        return res.status(400).json({
            success: false,
            message: `File format doesn't match. Expected columns: ${FULL_HEADERS.join(", ")}. Please download a fresh template.`,
        });
    }

    const cache = new Map();               // hierarchy node resolution cache
    const stats = {
        category: { created: 0, reused: 0 },
        subcategory: { created: 0, reused: 0 },
        generic_product: { created: 0, reused: 0 },
    };
    const createdBrandItems = [];
    const skipped = [];

    // Track brand items we've already inserted in *this* batch, keyed by
    // generic_product_id + name + brand, on top of the DB dedupe check —
    // same pattern as the single-level bulk uploader.
    const seenBrandItemsInBatch = new Set();

    for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2; // header is row 1
        const raw = rows[i];
        const errors = [];

        const categoryName = String(raw["Category Name"] || "").trim();
        const categoryImageRaw = String(raw["Category Image"] || "").trim();
        const subcategoryName = String(raw["Subcategory Name"] || "").trim();
        const subcategoryImageRaw = String(raw["Subcategory Image"] || "").trim();
        const genericName = String(raw["Generic Product Name"] || "").trim();
        const genericImageRaw = String(raw["Generic Product Image"] || "").trim();

        const productName = String(raw["Product Name"] || "").trim();
        const brandName = String(raw["Brand Name"] || "").trim();
        const manufacturer = String(raw["Manufacturer"] || "").trim();
        const modelNo = String(raw["Model/Part No/SKU"] || "").trim();
        const gradeVariant = String(raw["Grade/Variant"] || "").trim();
        const unit = String(raw["Unit"] || "").trim();
        const packSize = Number(raw["Pack Size"]);
        const unitsPerMasterPack = Number(raw["Units per Master Pack"]);

        const displayName = productName || `(row ${rowNum})`;

        if (categoryName.length < 2) errors.push("Category Name must be at least 2 characters");
        if (subcategoryName.length < 2) errors.push("Subcategory Name must be at least 2 characters");
        if (genericName.length < 2) errors.push("Generic Product Name must be at least 2 characters");
        if (productName.length < 2) errors.push("Product Name must be at least 2 characters");
        if (!brandName) errors.push("Brand Name is required");
        if (!manufacturer) errors.push("Manufacturer is required");
        if (!modelNo) errors.push("Model/Part No/SKU is required");
        if (!ALLOWED_UNITS.includes(unit)) errors.push(`Unit must be one of: ${ALLOWED_UNITS.join(", ")}`);
        if (!(packSize > 0)) errors.push("Pack Size must be a positive number");
        if (!(unitsPerMasterPack > 0)) errors.push("Units per Master Pack must be a positive number");

        // Hierarchy images are OPTIONAL — only validate them if a value
        // was actually provided.
        let categoryImage = null, subcategoryImage = null, genericImage = null;
        if (categoryImageRaw) {
            categoryImage = await toDirectImageUrl(categoryImageRaw);
            if (!isDirectImageUrl(categoryImage)) errors.push("Category Image doesn't resolve to a direct image link");
        }
        if (subcategoryImageRaw) {
            subcategoryImage = await toDirectImageUrl(subcategoryImageRaw);
            if (!isDirectImageUrl(subcategoryImage)) errors.push("Subcategory Image doesn't resolve to a direct image link");
        }
        if (genericImageRaw) {
            genericImage = await toDirectImageUrl(genericImageRaw);
            if (!isDirectImageUrl(genericImage)) errors.push("Generic Product Image doesn't resolve to a direct image link");
        }

        // Brand item images stay REQUIRED, same as the existing single-level uploader.
        const specifications = parseSpecifications(raw["Specifications"]);
        const imageLinks = await parseImageLinks(raw["Image Links"]);
        if (!imageLinks.length) {
            errors.push("At least one Image Link is required for the product");
        } else {
            const badUrls = imageLinks.filter((u) => !isDirectImageUrl(u));
            if (badUrls.length) {
                errors.push(`Couldn't resolve some Image Links to a direct image (bad: ${badUrls.slice(0, 2).join(", ")}${badUrls.length > 2 ? "…" : ""})`);
            }
        }
        if (String(raw["Specifications"] || "").trim() && !specifications.length) {
            errors.push(`Specifications must be "Key: Value" pairs separated by ; (couldn't parse any from "${String(raw["Specifications"]).slice(0, 40)}")`);
        }

        if (errors.length) {
            skipped.push({ row: rowNum, name: displayName, reasons: errors });
            continue;
        }

        try {
            const category = await resolveOrCreateNode({
                table: "hs_categories", name: categoryName, parentCol: null, parentId: null,
                imageUrl: categoryImage, cache,
            });
            stats.category[category.created ? "created" : "reused"]++;

            const subcategory = await resolveOrCreateNode({
                table: "hs_subcategories", name: subcategoryName, parentCol: "category_id", parentId: category.id,
                imageUrl: subcategoryImage, cache,
            });
            stats.subcategory[subcategory.created ? "created" : "reused"]++;

            const genericProduct = await resolveOrCreateNode({
                table: "hs_generic_products", name: genericName, parentCol: "subcategory_id", parentId: subcategory.id,
                imageUrl: genericImage, cache,
            });
            stats.generic_product[genericProduct.created ? "created" : "reused"]++;

            const dedupKey = `${genericProduct.id}::${productName.toLowerCase()}::${brandName.toLowerCase()}`;

            // Check the DB for an existing brand item under this exact
            // generic product before inserting (mirrors the unique index
            // on generic_product_id + lower(name) + lower(brand_name)).
            const { data: existingBrandItemRows, error: existingErr } = await supabase
                .from("hs_generic_product_brands")
                .select("id")
                .eq("generic_product_id", genericProduct.id)
                .ilike("name", productName)
                .ilike("brand_name", brandName)
                .limit(1);
            if (existingErr) throw new Error(existingErr.message);

            if (existingBrandItemRows?.[0] || seenBrandItemsInBatch.has(dedupKey)) {
                skipped.push({ row: rowNum, name: displayName, reasons: ["Already exists — duplicate skipped"] });
                continue;
            }
            seenBrandItemsInBatch.add(dedupKey);

            const { data: insertedBrandItem, error: insertErr } = await supabase
                .from("hs_generic_product_brands")
                .insert({
                    generic_product_id: genericProduct.id,
                    name: productName,
                    brand_name: brandName,
                    manufacturer,
                    model_no: modelNo,
                    grade_variant: gradeVariant || null,
                    unit,                              // NEW
                    pack_size: packSize,               // NEW
                    units_per_master_pack: unitsPerMasterPack, // NEW
                    specifications,
                    slug: slugify(`${productName}-${brandName}`),
                    image: imageLinks[0],
                    images: imageLinks,
                    is_ai_generated: false,
                    review_status: "approved",
                })
                .select("id, name")
                .single();

            if (insertErr) {
                skipped.push({
                    row: rowNum, name: displayName,
                    reasons: [insertErr.code === "23505" ? "Already exists — duplicate skipped" : insertErr.message],
                });
                continue;
            }

            createdBrandItems.push({
                ...insertedBrandItem,
                category: categoryName, subcategory: subcategoryName, genericProduct: genericName,
            });
        } catch (e) {
            skipped.push({ row: rowNum, name: displayName, reasons: [e.message] });
        }
    }

    res.json({
        success: true,
        createdCount: createdBrandItems.length,
        skippedCount: skipped.length,
        created: createdBrandItems,
        skipped,
        hierarchyStats: stats,
    });
}