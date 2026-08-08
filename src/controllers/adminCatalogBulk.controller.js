import * as XLSX from "xlsx";
import { supabase } from "../config/supabase.js";
import { ALLOWED_UNITS } from "./sellerCatalogListings.controller.js";

const SIMPLE_LEVELS = {
    category: { table: "hs_categories", parentField: null, label: "Category" },
    subcategory: { table: "hs_subcategories", parentField: "category_id", label: "Subcategory" },
    generic_product: { table: "hs_generic_products", parentField: "subcategory_id", label: "Generic Product" },
};
const SIMPLE_HEADERS = ["Name", "Image Link"];
const BRAND_ITEM_HEADERS = ["Product Name", "Brand Name", "Price", "MOQ", "Unit", "Lead Time", "Image Link"];

function isUrl(v) {
    return /^https?:\/\/\S+$/i.test(v || "");
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
    console.log("Running...");

    const { level } = req.params;
    let headers, exampleRow, filename;

    if (SIMPLE_LEVELS[level]) {
        headers = SIMPLE_HEADERS;
        exampleRow = { Name: "Example Item", "Image Link": "https://example.com/image.jpg" };
        filename = `${level}-upload-template.xlsx`;
    } else if (level === "brand_item") {
        headers = BRAND_ITEM_HEADERS;
        exampleRow = {
            "Product Name": "Example Product",
            "Brand Name": "Example Brand",
            Price: 499,
            MOQ: 10,
            Unit: ALLOWED_UNITS[0],
            "Lead Time": "5-7 days",
            "Image Link": "https://example.com/image.jpg",
        };
        filename = "brand-item-upload-template.xlsx";
    } else {
        return res.status(400).json({ success: false, message: `Unknown level "${level}".` });
    }

    const ws = XLSX.utils.json_to_sheet([exampleRow], { header: headers });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    if (level === "brand_item") {
        const notesWs = XLSX.utils.aoa_to_sheet([["Allowed Unit values:"], ...ALLOWED_UNITS.map((u) => [u])]);
        XLSX.utils.book_append_sheet(wb, notesWs, "Allowed Units");
    }

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
}

async function resolveGenericProductChain(genericProductId) {
    const { data, error } = await supabase
        .from("hs_generic_products")
        .select("id, subcategory:hs_subcategories(id, category:hs_categories(id))")
        .eq("id", genericProductId)
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Selected generic product wasn't found.");
    if (!data.subcategory?.id || !data.subcategory?.category?.id) {
        throw new Error("This generic product is missing category information.");
    }
    return { subcategoryId: data.subcategory.id, categoryId: data.subcategory.category.id };
}

// POST /api/admin/catalog/:level/excel-upload   (multipart: file, parentId)
export async function bulkUploadCatalog(req, res) {
    const { level } = req.params;
    const { parentId } = req.body || {};

    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });

    const simple = SIMPLE_LEVELS[level];
    const isBrandItem = level === "brand_item";
    if (!simple && !isBrandItem) return res.status(400).json({ success: false, message: `Unknown or unsupported level "${level}".` });

    const parentField = simple ? simple.parentField : "generic_product_id";
    if (parentField && !parentId) {
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
            message: `File format doesn't match. Expected columns: ${expectedHeaders.join(", ")}. Please use the downloaded template.`,
        });
    }

    let chain = null;
    if (isBrandItem) {
        try {
            chain = await resolveGenericProductChain(parentId);
        } catch (e) {
            return res.status(400).json({ success: false, message: e.message });
        }
    }

    const table = isBrandItem ? "seller_product_submissions" : simple.table;

    // Existing keys in this exact parent scope, for dedup.
    // For brand_item, only compare against OTHER admin-added rows — real
    // seller submissions for the same product+brand are legitimate and
    // must not block this upload (matches the DB's partial unique index).
    let existingQuery = supabase.from(table).select(isBrandItem ? "product_name, brand_name" : "name");
    if (parentField) existingQuery = existingQuery.eq(parentField, parentId);
    if (isBrandItem) existingQuery = existingQuery.eq("is_admin_added", true);
    const { data: existingRows, error: existingErr } = await existingQuery;
    if (existingErr) return res.status(500).json({ success: false, message: existingErr.message });

    const existingKeys = new Set(
        (existingRows || []).map((r) => (isBrandItem ? `${r.product_name.toLowerCase()}::${r.brand_name.toLowerCase()}` : r.name.toLowerCase()))
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
            const price = Number(raw["Price"]);
            const moq = Number(raw["MOQ"]);
            const unit = String(raw["Unit"] || "").trim();
            const leadTime = String(raw["Lead Time"] || "").trim();
            const image = String(raw["Image Link"] || "").trim();
            displayName = productName || `(row ${rowNum})`;

            if (!productName || productName.length < 2) errors.push("Product Name must be at least 2 characters");
            if (!brandName) errors.push("Brand Name is required");
            if (!(price > 0)) errors.push("Price must be a positive number");
            if (!(moq > 0)) errors.push("MOQ must be a positive number");
            if (!unit || !ALLOWED_UNITS.includes(unit)) errors.push(`Unit must be one of: ${ALLOWED_UNITS.join(", ")}`);
            if (!leadTime) errors.push("Lead Time is required");
            if (!image) errors.push("Image Link is required");
            else if (!isUrl(image)) errors.push("Image Link must be a valid http(s) URL");

            dedupKey = `${productName.toLowerCase()}::${brandName.toLowerCase()}`;
            if (!errors.length) {
                insertPayload = {
                    seller_id: null,
                    generic_product_id: parentId,
                    subcategory_id: chain.subcategoryId,
                    category_id: chain.categoryId,
                    product_name: productName,
                    brand_name: brandName,
                    price, moq, unit, lead_time: leadTime, image,
                    is_admin_added: true,
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
                    slug: (await import("../services/slugify.js")).slugify(name),
                    is_ai_generated: false,
                    review_status: "approved",
                };
                if (parentField) insertPayload[parentField] = parentId;
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

        let insertedRow, insertErr;
        if (isBrandItem) {
            const r = await supabase.from(table).insert(insertPayload).select("id, product_name").single();
            insertedRow = r.data ? { id: r.data.id, name: r.data.product_name } : null;
            insertErr = r.error;
        } else {
            const r = await supabase.from(table).insert(insertPayload).select("id, name").single();
            insertedRow = r.data;
            insertErr = r.error;
        }
        if (insertErr) {
            skipped.push({ row: rowNum, name: displayName, reasons: [insertErr.code === "23505" ? "Already exists — duplicate skipped" : insertErr.message] });
            continue;
        }
        created.push(insertedRow);
    }

    res.json({ success: true, createdCount: created.length, skippedCount: skipped.length, created, skipped });
}