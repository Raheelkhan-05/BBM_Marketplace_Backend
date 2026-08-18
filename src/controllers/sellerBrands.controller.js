// controllers/sellerBrands.controller.js
//
// New: brand typeahead + create, independent of any category/generic
// product context (the seller no longer picks a category before this).
// A "Not Applicable" brand is represented by brand_not_applicable=true
// with brand_name=null on the eventual hs_generic_product_brands row —
// this controller only searches/creates *named* brands; "Not Applicable"
// is a pure frontend toggle handled at submission time (see
// sellerCatalogListings.controller.js's createSubmission).

import { supabase } from "../config/supabase.js";

// GET /api/seller/catalog/brands?q=
// Distinct brand names across the whole catalog (not scoped to a
// generic product, since the seller doesn't pick one anymore).
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

    // De-dupe case-insensitively in memory (cheap at this row count;
    // move to a DISTINCT ON query if the brand table grows large).
    const seen = new Map();
    for (const row of data || []) {
        const key = row.brand_name.trim().toLowerCase();
        if (!seen.has(key)) seen.set(key, { name: row.brand_name, image: row.brand_image });
    }
    res.json({ success: true, items: [...seen.values()].slice(0, 20) });
}