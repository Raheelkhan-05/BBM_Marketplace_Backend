// controllers/adsProducts.controller.js
// GET /api/ads/my-products — the seller's own live listings, for "Promote this product" and
// "banner links to this product". Two plain queries (no embedded-FK syntax), so it does not depend on
// how the relationship between seller_product_submissions and hs_generic_product_brands is named.
import { supabase } from "../config/supabase.js";

export async function getMyAdProducts(req, res) {
    try {
        const { data: subs, error } = await supabase
            .from("seller_product_submissions")
            .select("id, generic_product_brand_id, price, pack_size, unit, units_per_master_pack, gst_percent")
            .eq("seller_id", req.sellerId)
            .eq("review_status", "approved")
            .eq("is_active", true)
            .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
            .limit(500);
        if (error) throw error;

        const ids = [...new Set((subs || []).map((s) => s.generic_product_brand_id).filter(Boolean))];
        let byId = new Map();
        if (ids.length) {
            const { data: items, error: e2 } = await supabase
                .from("hs_generic_product_brands")
                .select("id, name, brand_name, image, brand_image")
                .in("id", ids);
            if (e2) throw e2;
            byId = new Map((items || []).map((b) => [b.id, b]));
        }

        const products = (subs || [])
            .map((s) => {
                const b = byId.get(s.generic_product_brand_id);
                if (!b) return null;
                return {
                    submissionId: s.id,
                    name: b.name,
                    brandName: b.brand_name || null,
                    image: b.image || b.brand_image || null,
                    price: Number(s.price) || 0,
                    unit: s.unit || null,
                    masterPackSize: s.units_per_master_pack ?? null,
                };
            })
            .filter(Boolean)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));

        res.set("Cache-Control", "private, max-age=0");
        return res.json({ success: true, products });
    } catch (e) {
        console.error("[ads] my-products failed:", e?.message || e);
        return res.status(500).json({ success: false, message: "Couldn't load your products." });
    }
}