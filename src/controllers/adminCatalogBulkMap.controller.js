// controllers/adminCatalogBulkMap.controller.js
// Admin-only. Map many catalog brand items to one generic product (same write as "Fix mapping", in bulk).
import { supabase } from "../config/supabase.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 1000;

// POST /api/admin/catalog-bulk/map-brand-items  { ids: [brandItemId], parentId: genericProductId }
export async function bulkMapBrandItems(req, res) {
    const { ids, parentId } = req.body || {};
    if (!UUID_RE.test(String(parentId || ""))) return res.status(400).json({ success: false, message: "Pick a generic product to map under." });
    const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => UUID_RE.test(String(x))))];
    if (!unique.length || unique.length > MAX_IDS) return res.status(400).json({ success: false, message: `Select between 1 and ${MAX_IDS} catalog items.` });

    try {
        const { data: gp, error: gpErr } = await supabase.from("hs_generic_products")
            .select("id, review_status").eq("id", parentId).is("deleted_at", null).maybeSingle();
        if (gpErr) throw gpErr;
        if (!gp || gp.review_status === "rejected") return res.status(400).json({ success: false, message: "Selected generic product wasn't found." });

        let updated = 0;
        for (let i = 0; i < unique.length; i += 100) {
            const { data, error } = await supabase.from("hs_generic_product_brands")
                .update({ generic_product_id: parentId }).in("id", unique.slice(i, i + 100)).is("deleted_at", null).select("id");
            if (error) throw error;
            updated += data?.length || 0;
        }
        res.json({ success: true, updated, requested: unique.length });
    } catch (e) {
        console.error("[adminCatalogBulkMap]", e?.message || e);
        res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
}