// Simplified seller flow: pick Category > Subcategory > Generic Product
// from the admin-curated catalog, then submit Product Name, Brand Name,
// Price, MOQ, Unit, Lead Time, and one image. Goes to
// seller_product_submissions as review_status='pending_review'.

import { supabase } from "../config/supabase.js";
import { slugify } from "../services/slugify.js"
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
        .select("id, review_status")
        .eq("id", genericProductId)
        .maybeSingle();
    if (genericErr) return res.status(500).json({ success: false, message: genericErr.message });
    if (!generic) return res.status(400).json({ success: false, message: "Selected product wasn't found." });
    if (generic.review_status !== "approved") return res.status(400).json({ success: false, message: "This product isn't available to list under yet." });

    // Find or create the canonical brand item so future sellers can find
    // and claim it via "I want to sell this" instead of duplicating it.
    const trimmedName = productName.trim();
    const trimmedBrand = brandName.trim();
    let { data: brand } = await supabase
        .from("hs_generic_product_brands")
        .select("id")
        .eq("generic_product_id", generic.id)
        .ilike("name", trimmedName)
        .ilike("brand_name", trimmedBrand)
        .maybeSingle();

    if (!brand) {
        const { data: newBrand, error: createErr } = await supabase
            .from("hs_generic_product_brands")
            .insert({
                generic_product_id: generic.id,
                name: trimmedName,
                brand_name: trimmedBrand,
                slug: slugify(`${trimmedName}-${trimmedBrand}`),
                image,
                is_ai_generated: false,
                review_status: "pending_review", // stays gated behind admin approval, same as before
            })
            .select("id")
            .single();
        if (createErr && createErr.code !== "23505") return res.status(500).json({ success: false, message: createErr.message });
        if (createErr) {
            // Lost a race with another seller creating it simultaneously — reselect
            const { data: raced } = await supabase.from("hs_generic_product_brands").select("id")
                .eq("generic_product_id", generic.id).ilike("name", trimmedName).ilike("brand_name", trimmedBrand).maybeSingle();
            brand = raced;
        } else {
            brand = newBrand;
        }
    }

    const { data: inserted, error } = await supabase
        .from("seller_product_submissions")
        .insert({
            seller_id: sellerId,
            generic_product_brand_id: brand.id,
            price: Number(price), moq: Number(moq), unit, lead_time: leadTime.trim(), image,
        })
        .select("id, created_at")
        .single();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You're already listing this item." });
        return res.status(500).json({ success: false, message: error.message });
    }

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

// POST /api/seller/catalog/listings   { genericProductBrandId, price, moq, unit, leadTime, image? }
// "I want to sell this" — seller picks an EXISTING brand item and only
// supplies commercial terms. No product/brand name/image re-entry.
export async function createListingForExistingBrand(req, res) {
    const sellerId = req.sellerId;
    const { genericProductBrandId, price, moq, unit, leadTime, image } = req.body || {};

    if (!genericProductBrandId) return res.status(400).json({ success: false, message: "Missing brand item." });
    const missing = [];
    if (!(Number(price) > 0)) missing.push("Price");
    if (!(Number(moq) > 0)) missing.push("MOQ");
    if (!unit || !ALLOWED_UNITS.includes(unit)) missing.push("Unit");
    if (!leadTime?.trim()) missing.push("Lead time");
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.` });

    const { data: brand, error: brandErr } = await supabase
        .from("hs_generic_product_brands")
        .select("id, name, review_status, generic_product_id")
        .eq("id", genericProductBrandId)
        .maybeSingle();
    if (brandErr) return res.status(500).json({ success: false, message: brandErr.message });
    if (!brand) return res.status(400).json({ success: false, message: "That item wasn't found." });
    if (brand.review_status !== "approved") return res.status(400).json({ success: false, message: "This item isn't available to list under yet." });

    const { data: inserted, error } = await supabase
        .from("seller_product_submissions")
        .insert({
            seller_id: sellerId,
            generic_product_brand_id: brand.id,
            price: Number(price),
            moq: Number(moq),
            unit,
            lead_time: leadTime.trim(),
            image: image || null,
        })
        .select("id, created_at")
        .single();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You're already listing this item." });
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true, submission: inserted, message: `You're now listing "${brand.name}". We'll notify you once it's approved.` });
}