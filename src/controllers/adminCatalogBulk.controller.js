import * as XLSX from "xlsx";
import { supabase } from "../config/supabase.js";
import { slugify } from "../services/slugify.js";

// Every simple level uses the same lightweight template. brand_item's
// template now carries the full catalog-identity shape: Name + Brand +
// Manufacturer + Model/Part No/SKU + Grade/Variant (optional) + Image
// Links. Commercial terms (price/moq/unit/lead time/packaging/delivery/
// tax/etc.) are NOT part of this — they don't belong in the catalog
// identity anymore, and only ever get entered by a seller against an
// existing approved brand item via the seller listing flow.
const LEVELS = {
    category: { table: "hs_categories", parentField: null, label: "Category" },
    subcategory: { table: "hs_subcategories", parentField: "category_id", label: "Subcategory" },
    generic_product: { table: "hs_generic_products", parentField: "subcategory_id", label: "Generic Product" },
    brand_item: { table: "hs_generic_product_brands", parentField: "generic_product_id", label: "Brand Item" },
};

const SIMPLE_HEADERS = ["Name", "Image Link"];
const BRAND_ITEM_HEADERS = ["Product Name", "Brand Name", "Manufacturer", "Model/Part No/SKU", "Grade/Variant", "Specifications", "Image Links"];
// Columns that must be filled for every brand_item row. Grade/Variant and
// Specifications are intentionally excluded — both are optional, same as
// they are in the UI forms.
const BRAND_ITEM_REQUIRED = ["Product Name", "Brand Name", "Manufacturer", "Model/Part No/SKU"];

function isUrl(v) {
    return /^https?:\/\/\S+$/i.test(v || "");
}

// Splits a single "Image Links" cell into individual URLs. Admins can
// separate multiple photos with a comma, semicolon, or newline (Excel
// lets a cell contain line breaks) — all three are common ways people
// naturally paste a list of links into one cell.
function parseImageLinks(raw) {
    return String(raw || "")
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

// Splits a single "Specifications" cell into { key, value } rows.
// Each spec is "Key: Value", multiple specs separated by a semicolon
// or newline — e.g. "Material: SS304; Finish: Matte; Weight: 1.2kg".
// A colon is required per spec; anything malformed (no colon, or an
// empty key/value) is silently dropped rather than failing the whole
// row, since specifications are optional.
function parseSpecifications(raw) {
    return String(raw || "")
        .split(/[;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
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

// GET /api/admin/catalog/:level/excel-template
export async function downloadCatalogTemplate(req, res) {
    const { level } = req.params;
    const meta = LEVELS[level];
    if (!meta) return res.status(400).json({ success: false, message: `Unknown level "${level}".` });

    const isBrandItem = level === "brand_item";
    const headers = isBrandItem ? BRAND_ITEM_HEADERS : SIMPLE_HEADERS;
    const exampleRow = isBrandItem
        ? {
            "Product Name": "Example Product",
            "Brand Name": "Example Brand",
            "Manufacturer": "Example Manufacturer Pvt Ltd",
            "Model/Part No/SKU": "MDL-1234",
            "Grade/Variant": "Grade A",
            "Specifications": "Material: Stainless Steel 304; Finish: Matte; Weight: 1.2kg",
            "Image Links": "https://example.com/front.jpg, https://example.com/side.jpg, https://example.com/back.jpg",
        }
        : { Name: "Example Item", "Image Link": "https://example.com/image.jpg" };
    const filename = `${level}-upload-template.xlsx`;

    const ws = XLSX.utils.json_to_sheet([exampleRow], { header: headers });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
}

// POST /api/admin/catalog/:level/excel-upload   (multipart: file, parentId)
export async function bulkUploadCatalog(req, res) {
    const { level } = req.params;
    const { parentId } = req.body || {};

    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });

    const meta = LEVELS[level];
    if (!meta) return res.status(400).json({ success: false, message: `Unknown or unsupported level "${level}".` });

    const isBrandItem = level === "brand_item";
    if (meta.parentField && !parentId) {
        return res.status(400).json({ success: false, message: "Missing parent — open this from inside the item you're uploading into." });
    }

    let rows;
    try {
        rows = parseWorkbook(req.file.buffer);
    } catch {
        return res.status(400).json({ success: false, message: "Couldn't read that file. Please upload a valid .xlsx file." });
    }
    if (!rows.length) return res.status(400).json({ success: false, message: "The file is empty." });

    const expectedHeaders = isBrandItem ? BRAND_ITEM_HEADERS : SIMPLE_HEADERS;
    if (!headersMatch(rows, expectedHeaders)) {
        return res.status(400).json({
            success: false,
            message: `File format doesn't match. Expected columns: ${expectedHeaders.join(", ")}. Please download a fresh template — Brand Items now require Manufacturer and Model/Part No/SKU (Grade/Variant and Specifications are optional).`,
        });
    }

    // Existing keys in this exact parent scope, for dedup. For brand
    // items this naturally respects the DB's own unique index on
    // (generic_product_id, lower(name), lower(brand_name)).
    let existingQuery = supabase.from(meta.table).select(isBrandItem ? "name, brand_name" : "name");
    if (meta.parentField) existingQuery = existingQuery.eq(meta.parentField, parentId);
    const { data: existingRows, error: existingErr } = await existingQuery;
    if (existingErr) return res.status(500).json({ success: false, message: existingErr.message });

    const existingKeys = new Set(
        (existingRows || []).map((r) => (isBrandItem ? `${r.name.toLowerCase()}::${r.brand_name.toLowerCase()}` : r.name.toLowerCase()))
    );
    const seenInBatch = new Set();

    const created = [];
    const skipped = [];

    for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2;
        const raw = rows[i];
        const errors = [];
        let insertPayload = null;
        let dedupKey = null;
        let displayName = "";

        if (isBrandItem) {
            const productName = String(raw["Product Name"] || "").trim();
            const brandName = String(raw["Brand Name"] || "").trim();
            const manufacturer = String(raw["Manufacturer"] || "").trim();
            const modelNo = String(raw["Model/Part No/SKU"] || "").trim();
            const gradeVariant = String(raw["Grade/Variant"] || "").trim();
            const specifications = parseSpecifications(raw["Specifications"]);
            const imageLinks = parseImageLinks(raw["Image Links"]);
            displayName = productName || `(row ${rowNum})`;

            if (!productName || productName.length < 2) errors.push("Product Name must be at least 2 characters");
            if (!brandName) errors.push("Brand Name is required");
            if (!manufacturer) errors.push("Manufacturer is required");
            if (!modelNo) errors.push("Model/Part No/SKU is required");
            if (!imageLinks.length) errors.push("At least one Image Link is required");
            else {
                const badUrls = imageLinks.filter((u) => !isUrl(u));
                if (badUrls.length) errors.push(`Image Links must all be valid http(s) URLs (bad: ${badUrls.slice(0, 2).join(", ")}${badUrls.length > 2 ? "…" : ""})`);
            }
            // If the cell wasn't blank but nothing parsed out of it, the
            // admin likely typed specs without a colon — flag it instead
            // of silently dropping their input.
            if (String(raw["Specifications"] || "").trim() && !specifications.length) {
                errors.push(`Specifications must be "Key: Value" pairs separated by ; (couldn't parse any from "${String(raw["Specifications"]).slice(0, 40)}")`);
            }

            dedupKey = `${productName.toLowerCase()}::${brandName.toLowerCase()}`;
            if (!errors.length) {
                insertPayload = {
                    generic_product_id: parentId,
                    name: productName,
                    brand_name: brandName,
                    manufacturer,
                    model_no: modelNo,
                    grade_variant: gradeVariant || null,
                    specifications,
                    slug: slugify(`${productName}-${brandName}`),
                    image: imageLinks[0],
                    images: imageLinks,
                    is_ai_generated: false,
                    review_status: "approved",
                };
            }
        } else {
            const name = String(raw["Name"] || "").trim();
            const image = String(raw["Image Link"] || "").trim();
            displayName = name || `(row ${rowNum})`;

            if (!name || name.length < 2) errors.push("Name must be at least 2 characters");
            if (!image) errors.push("Image Link is required");
            else if (!isUrl(image)) errors.push("Image Link must be a valid http(s) URL");

            dedupKey = name.toLowerCase();
            if (!errors.length) {
                insertPayload = {
                    name, image,
                    slug: slugify(name),
                    is_ai_generated: false,
                    review_status: "approved",
                };
                if (meta.parentField) insertPayload[meta.parentField] = parentId;
            }
        }

        if (errors.length) {
            skipped.push({ row: rowNum, name: displayName, reasons: errors });
            continue;
        }
        if (existingKeys.has(dedupKey) || seenInBatch.has(dedupKey)) {
            skipped.push({ row: rowNum, name: displayName, reasons: ["Already exists — duplicate skipped"] });
            continue;
        }
        seenInBatch.add(dedupKey);

        const { data: insertedRow, error: insertErr } = await supabase
            .from(meta.table)
            .insert(insertPayload)
            .select("id, name")
            .single();

        if (insertErr) {
            skipped.push({ row: rowNum, name: displayName, reasons: [insertErr.code === "23505" ? "Already exists — duplicate skipped" : insertErr.message] });
            continue;
        }
        created.push(insertedRow);
    }

    res.json({ success: true, createdCount: created.length, skippedCount: skipped.length, created, skipped });
}