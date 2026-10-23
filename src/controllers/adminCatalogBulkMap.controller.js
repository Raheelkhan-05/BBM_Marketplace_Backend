// controllers/adminCatalogBulkMap.controller.js
import { genericProductUsable, mapBrandItems } from "../services/catalogMapping.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 1000;

// POST /api/admin/catalog-bulk/map-brand-items  { ids: [brandItemId], parentId: genericProductId }
export async function bulkMapBrandItems(req, res) {
    const { ids, parentId } = req.body || {};
    if (!UUID_RE.test(String(parentId || ""))) return res.status(400).json({ success: false, message: "Pick a generic product to map under." });
    const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => UUID_RE.test(String(x))))];
    if (!unique.length || unique.length > MAX_IDS) return res.status(400).json({ success: false, message: `Select between 1 and ${MAX_IDS} catalog items.` });

    try {
        if (!(await genericProductUsable(parentId))) return res.status(400).json({ success: false, message: "Selected generic product wasn't found." });
        const updated = await mapBrandItems(unique, parentId);
        res.json({ success: true, updated, requested: unique.length });
    } catch (e) {
        console.error("[adminCatalogBulkMap]", e?.message || e);
        res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
}