// Simplified seller flow: pick Category > Subcategory > Generic Product
// from the admin-curated catalog, then submit Product Name, Brand Name,
// Price, MOQ, Unit, Lead Time, and one image. Goes to
// seller_product_submissions as review_status='pending_review'.

import { supabase } from "../config/supabase.js";

const PICKER_LIMIT = 20;

export const ALLOWED_UNITS = [
    "Pieces", "Kg", "Grams", "Litres", "Millilitres", "Meters",
    "Boxes", "Dozen", "Tons", "Pack", "Bundle", "Set", "Units",
];

export async function listApprovedCategories(req, res) {
    const { q = "" } = req.query;
    let query = supabase.from("hs_categories").select("id, name, slug, image").eq("review_status", "approved").order("name").limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

export async function listApprovedSubcategories(req, res) {
    const { categoryId, q = "" } = req.query;
    if (!categoryId) return res.status(400).json({ success: false, message: "categoryId is required." });
    let query = supabase.from("hs_subcategories").select("id, name, slug, image, category_id").eq("category_id", categoryId).eq("review_status", "approved").order("name").limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/seller/catalog/generic-products?subcategoryId=&q=
export async function listApprovedGenericProducts(req, res) {
    const { subcategoryId, q = "" } = req.query;
    if (!subcategoryId) return res.status(400).json({ success: false, message: "subcategoryId is required." });
    let query = supabase.from("hs_generic_products").select("id, name, slug, image, subcategory_id").eq("subcategory_id", subcategoryId).eq("review_status", "approved").order("name").limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

function validateSubmission(body) {
    const missing = [];
    const { productName, brandName, price, moq, unit, leadTime, image } = body;
    if (!productName?.trim()) missing.push("Product name");
    if (!brandName?.trim()) missing.push("Brand name");
    if (!(Number(price) > 0)) missing.push("Price");
    if (!(Number(moq) > 0)) missing.push("MOQ");
    if (!unit || !ALLOWED_UNITS.includes(unit)) missing.push("Unit");
    if (!leadTime?.trim()) missing.push("Lead time");
    if (!image) missing.push("Product image");
    return missing;
}

// POST /api/seller/catalog/submissions
export async function createSubmission(req, res) {
    const sellerId = req.sellerId;
    const { genericProductId, productName, brandName, price, moq, unit, leadTime, image } = req.body || {};

    if (!genericProductId) return res.status(400).json({ success: false, message: "Please choose a product from the catalog." });
    const missing = validateSubmission(req.body || {});
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    const { data: generic, error: genericErr } = await supabase
        .from("hs_generic_products")
        .select("id, name, review_status, subcategory:hs_subcategories(id, category:hs_categories(id))")
        .eq("id", genericProductId)
        .maybeSingle();
    if (genericErr) return res.status(500).json({ success: false, message: genericErr.message });
    if (!generic) return res.status(400).json({ success: false, message: "Selected product wasn't found." });
    if (generic.review_status !== "approved") return res.status(400).json({ success: false, message: "This product isn't available to list under yet." });
    if (!generic.subcategory?.id || !generic.subcategory?.category?.id) {
        return res.status(400).json({ success: false, message: "This product is missing category information — please contact support." });
    }

    const { data: inserted, error } = await supabase
        .from("seller_product_submissions")
        .insert({
            seller_id: sellerId,
            generic_product_id: generic.id,
            subcategory_id: generic.subcategory.id,
            category_id: generic.subcategory.category.id,
            product_name: productName.trim(),
            brand_name: brandName.trim(),
            price: Number(price),
            moq: Number(moq),
            unit,
            lead_time: leadTime.trim(),
            image,
        })
        .select("id, created_at")
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({ success: true, submission: inserted, message: "Submitted for review. We'll notify you once it's approved." });
}

// GET /api/seller/catalog/submissions?status=
export async function listMySubmissions(req, res) {
    const sellerId = req.sellerId;
    const { status } = req.query;
    let query = supabase
        .from("seller_product_submissions")
        .select("id, product_name, brand_name, price, moq, unit, lead_time, image, review_status, rejection_reason, created_at, generic_product:hs_generic_products(id, name)")
        .eq("seller_id", sellerId)
        .order("created_at", { ascending: false });
    if (status) query = query.eq("review_status", status);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}