import { supabaseAdmin } from "../config/supabase.js";

const toInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const cleanQ = (v) => String(v || "").trim().replace(/\s+/g, " ").slice(0, 100);

// GET /api/seller/catalog/picker/brands?q=&limit=&offset=
export async function listPickerBrands(req, res) {
    const limit = Math.min(Math.max(toInt(req.query.limit, 36), 1), 60);
    const offset = Math.max(toInt(req.query.offset, 0), 0);
    const { data, error } = await supabaseAdmin.rpc("seller_catalog_brands_page", {
        p_q: cleanQ(req.query.q), p_limit: limit, p_offset: offset,
    });
    if (error) {
        console.error("[picker] listPickerBrands failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load brands." });
    }
    return res.json({ success: true, brands: data?.brands || [], hasMore: !!data?.hasMore });
}

// GET /api/seller/catalog/picker/items?brand=&none=1&q=&limit=&offset=
export async function listPickerItems(req, res) {
    const none = req.query.none === "1";
    const brand = cleanQ(req.query.brand);
    if (!none && !brand) return res.status(400).json({ success: false, message: "Brand is required." });
    const limit = Math.min(Math.max(toInt(req.query.limit, 30), 1), 60);
    const offset = Math.max(toInt(req.query.offset, 0), 0);
    const { data, error } = await supabaseAdmin.rpc("seller_catalog_items_page", {
        p_brand: brand, p_no_brand: none, p_q: cleanQ(req.query.q),
        p_seller_id: req.sellerId, p_limit: limit, p_offset: offset,
    });
    if (error) {
        console.error("[picker] listPickerItems failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load products." });
    }
    return res.json({ success: true, items: data?.items || [], hasMore: !!data?.hasMore });
}