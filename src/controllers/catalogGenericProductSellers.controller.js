import { supabase } from "../config/supabase.js";

function splitParam(v) {
    if (!v) return null;
    const arr = String(v).split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : null;
}

// GET /api/catalog-search/generic-product-sellers
// Every seller across every brand under one generic product — this is
// what "Buy" opens from the product-tile level, so buyers compare
// brand+seller combinations for that product in one list.
export async function listGenericProductSellers(req, res) {
    const { genericProductId, brands, q = "", sort = "relevance", limit = 30, offset = 0 } = req.query;
    if (!genericProductId) return res.status(400).json({ success: false, message: "genericProductId is required." });

    const { data, error } = await supabase.rpc("catalog_generic_product_sellers", {
        p_generic_product_id: genericProductId,
        p_brand_names: splitParam(brands),
        p_q: q || null,
        p_sort: sort,
        p_limit: Math.min(Math.max(Number(limit) || 30, 1), 60),
        p_offset: Math.max(Number(offset) || 0, 0),
    });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, ...data });
}

// GET /api/catalog-search/listing/:id
// Public, read-only detail for ONE approved+active listing — powers the
// buyer's "view product details" action on a seller row. Deliberately
// selects only buyer-safe fields (no seller_id, no review metadata).
export async function getPublicListingDetail(req, res) {
    const { id } = req.params;
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(`
                id, price, base_price, gst_percent, moq, unit, lead_time, image, stock_quantity,
                manufacturer, model_no, grade_variant, specifications,
                rate_per_pack, rate_per_master_pack, price_validity_till,
                sample_available, sample_price, price_slabs, quantity_discounts,
                pack_size, units_per_master_pack, master_pack_size, packaging_type,
                stock_type, dispatch_time_days, production_lead_time_days,
                seller_location, dispatch_location, delivery_timeline, freight_terms,
                hsn_code, gst_registration_status, tax_invoice_available,
                payment_terms, return_policy, warranty,
                quality_certificates, tds_msds_coa, other_certifications,
                brand:hs_generic_product_brands ( id, name, brand_name, image, images ),
                seller:seller_profiles ( id, display_name, shop_slug, logo_url, city, state )
            `)
        .eq("id", id)
        .eq("review_status", "approved")
        .eq("is_active", true)
        .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Listing not found." });
    res.json({ success: true, listing: data });
}

// GET /api/catalog-search/generic-products/:id/brands
// Approved brand items already under this product — powers the "which
// brand is yours?" step when a seller taps Sell from the product tile.
export async function listApprovedBrandsForGenericProduct(req, res) {
    const { id } = req.params;
    const { q = "" } = req.query;
    let query = supabase
        .from("hs_generic_product_brands")
        .select("id, name, brand_name, image, images, manufacturer, model_no, grade_variant, specifications")
        .eq("generic_product_id", id)
        .eq("review_status", "approved")
        .order("brand_name")
        .limit(20);
    if (q.trim()) query = query.or(`name.ilike.%${q.trim()}%,brand_name.ilike.%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}