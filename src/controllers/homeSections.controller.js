// controllers/homeSections.controller.js
// GET /api/catalog/home-sections?categoryId=<uuid>
// Per-buyer (custom prices, visibility, wallet rules) so the response is private. A tiny in-process
// cache (20 s) absorbs refresh storms; it is keyed by viewer + category so nobody sees another buyer's prices.
import { supabaseAdmin } from "../config/supabase.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 20_000;
const MAX_KEYS = 500;
const cache = new Map(); // key -> { t, body }
const inflight = new Map(); // key -> Promise

export async function getHomeSections(req, res) {
    const categoryId = String(req.query.categoryId || "").trim();
    if (categoryId && !UUID_RE.test(categoryId)) {
        return res.status(400).json({ success: false, message: "Invalid category." });
    }
    const buyerId = req.user?.id || null;
    const sellerId = req.sellerProfileId || null;
    const key = `${buyerId || "anon"}|${sellerId || ""}|${categoryId}`;

    res.set("Cache-Control", "private, max-age=0, must-revalidate");

    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < TTL_MS) return res.json(hit.body);

    try {
        let p = inflight.get(key);
        if (!p) {
            p = supabaseAdmin
                .rpc("catalog_home_sections", {
                    p_buyer_id: buyerId,
                    p_seller_id: sellerId,
                    p_category_id: categoryId || null,
                })
                .then(({ data, error }) => {
                    if (error) throw error;
                    return { success: true, shelves: data?.shelves || [], generatedAt: data?.generated_at || null };
                })
                .finally(() => inflight.delete(key));
            inflight.set(key, p);
        }
        const body = await p;
        if (cache.size >= MAX_KEYS) cache.clear();
        cache.set(key, { t: Date.now(), body });
        return res.json(body);
    } catch (e) {
        console.error("[catalog] home-sections failed:", e?.message || e);
        // The shelves are an extra: the page keeps working without them.
        return res.status(500).json({ success: false, message: "Couldn't load the home sections." });
    }
}