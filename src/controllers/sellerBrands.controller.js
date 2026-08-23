import { supabase } from "../config/supabase.js";

// GET /api/seller/catalog/brands?q=  — unchanged
export async function searchBrandNames(req, res) {
    const { q = "" } = req.query;
    let query = supabase
        .from("hs_generic_product_brands")
        .select("brand_name, brand_image")
        .not("brand_name", "is", null)
        .order("brand_name")
        .limit(200);
    if (q.trim()) query = query.ilike("brand_name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const seen = new Map();
    for (const row of data || []) {
        const key = row.brand_name.trim().toLowerCase();
        if (!seen.has(key)) seen.set(key, { name: row.brand_name, image: row.brand_image });
    }
    res.json({ success: true, items: [...seen.values()].slice(0, 20) });
}

// GET /api/seller/catalog/brand-item-match?productName=&brandName=&brandNotApplicable=
//
// Looks up the exact (productName, brandName) pair against
// hs_generic_product_brands — this is what tells the listing form
// whether packaging (unit/packSize/masterPackSize) is already fixed
// by an existing catalog entry, or whether this seller is establishing
// a brand-new one and needs to supply it themselves. Matches regardless
// of review_status (pending or approved) — same lookup contract as
// findExistingBrandItem() in sellerCatalogListings.controller.js, so a
// seller typing the same product+brand another seller already submitted
// (even if still pending review) reuses that entry's packaging instead
// of being asked to re-declare it.
export async function findBrandItemMatch(req, res) {
    const { productName = "", brandName = "", brandNotApplicable } = req.query;
    const trimmedProduct = productName.trim();
    if (trimmedProduct.length < 2) return res.json({ success: true, match: null });

    const isNotApplicable = brandNotApplicable === "true";
    if (!isNotApplicable && !brandName.trim()) return res.json({ success: true, match: null });

    let query = supabase
        .from("hs_generic_product_brands")
        .select("id, name, brand_name, unit, pack_size, units_per_master_pack, review_status")
        .ilike("name", trimmedProduct);
    query = isNotApplicable ? query.is("brand_name", null) : query.ilike("brand_name", brandName.trim());

    const { data, error } = await query.maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });

    // Only a real match — with packaging actually set on it — counts.
    // (A brand item somehow missing packaging shouldn't silently lock
    // the seller into blank values.)
    if (!data || !data.unit || !(Number(data.pack_size) > 0) || !(Number(data.units_per_master_pack) > 0)) {
        return res.json({ success: true, match: null });
    }

    res.json({
        success: true,
        match: {
            id: data.id,
            unit: data.unit,
            packSize: data.pack_size,
            masterPackSize: data.units_per_master_pack,
        },
    });
}