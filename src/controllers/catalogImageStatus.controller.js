// backend/controllers/catalogImageStatus.controller.js
import { supabase } from "../config/supabase.js";


export async function getImageStatuses(req, res) {
    const ids = String(req.query.ids || ""); // "product:12,subcategory:4,category:7"
    const groups = { product: [], subcategory: [], category: [] };
    for (const pair of ids.split(",").filter(Boolean)) {
        const [level, id] = pair.split(":");
        if (groups[level]) groups[level].push(id);
    }
    const tableFor = { product: "hs_products", subcategory: "hs_subcategories", category: "hs_categories" };
    const results = [];
    for (const [level, idList] of Object.entries(groups)) {
        if (!idList.length) continue;
        const { data } = await supabase.from(tableFor[level]).select("id, image").in("id", idList);
        (data || []).forEach((row) => results.push({ level, id: row.id, image: row.image }));
    }
    res.json({ success: true, images: results });
}
// router.get("/image-status", getImageStatuses);