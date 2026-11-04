// controllers/sellerCatalogListAll.controller.js
//
// GET /api/seller/catalog/submissions/all
// Returns EVERY listing of the seller in ONE response (replaces ~14 paginated requests, each
// with its own exact COUNT). The serialized body is cached (Redis / memory) and sent with an
// ETag, so a repeat visit with nothing changed costs one tiny "304 Not Modified".
import crypto from "node:crypto";
import { supabase } from "../config/supabase.js";
import { cached, cacheGet, cacheSet, getVer, sellerListScope } from "../services/cache.service.js";

// Same text as CATALOG_REMOVED_REJECTION_REASON in sellerCatalogListings.controller.js
// (copied so the two files don't import each other).
const CATALOG_REMOVED = "Underlying product was removed from the catalog.";
const CACHE_TTL_SEC = 60;
const DB_PAGE = 1000;
const MAX_ROWS = 20000;

// Single source of truth for the list columns. listMySubmissions imports this too.
export const SUBMISSION_LIST_COLUMNS = `
    id, created_at, updated_at, review_status, rejection_reason,
    reviewed_at, is_active, generic_product_brand_id,
    validity_hours, valid_from, expires_at, expired_at,
    product_name, brand_name, image, price, base_price, gst_percent, moq, unit,
    pack_size, units_per_master_pack, marketing_commission_percent, marketing_services, marketing_legacy_percent,
    stock_type, stock_quantity, production_lead_time_days, dispatch_time_days, lead_time, visibility_mode,
    dispatch_district, dispatch_state, return_policy_key, warranty_key,
    hs_generic_product_brands!inner (
        id, name, brand_name, brand_image, image, images, deleted_at, model_no,
        hs_generic_products ( id, name, hs_subcategories ( id, name, hs_categories ( id, name ) ) )
    )
`;

const one = (x) => (Array.isArray(x) ? x[0] : x) || null;

// Flattens the brand > generic product > sub-category > category chain onto the listing.
export function shapeListRow({ hs_generic_product_brands, ...rest }) {
    const { hs_generic_products, ...brand } = hs_generic_product_brands || {};
    const gp = one(hs_generic_products);
    const sub = one(gp?.hs_subcategories);
    const cat = one(sub?.hs_categories);
    return {
        ...rest,
        brand: hs_generic_product_brands ? brand : null,
        generic_product_id: gp?.id ?? null, generic_product_name: gp?.name ?? null,
        subcategory_id: sub?.id ?? null, subcategory_name: sub?.name ?? null,
        category_id: cat?.id ?? null, category_name: cat?.name ?? null,
    };
}

async function loadAllRows(sellerId) {
    const items = [];
    let from = 0, total = Infinity;
    while (from < total && from < MAX_ROWS) {
        const { data, error, count } = await supabase
            .from("seller_product_submissions")
            .select(SUBMISSION_LIST_COLUMNS, from === 0 ? { count: "exact" } : undefined)
            .eq("seller_id", sellerId)
            .is("hs_generic_product_brands.deleted_at", null)
            .or(`rejection_reason.is.null,rejection_reason.neq.${CATALOG_REMOVED}`)
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })               // stable order between pages
            .range(from, from + DB_PAGE - 1);
        if (error) throw error;
        if (from === 0) total = count ?? (data || []).length;
        if (!data?.length) break;
        items.push(...data.map(shapeListRow));
        from += data.length;                                 // honours a lower max-rows setting
    }
    return items;
}

async function buildBlob(sellerId) {
    const items = await loadAllRows(sellerId);
    const body = JSON.stringify({ success: true, items, total: items.length });
    const etag = `"${crypto.createHash("md5").update(body).digest("base64url")}"`;
    return `${etag}\n${body}`;
}

export async function listAllMySubmissions(req, res) {
    const sellerId = req.sellerId;
    try {
        const ver = await getVer(sellerListScope(sellerId));
        const key = `sl:${sellerId}:${ver}`;
        const inm = req.headers["if-none-match"];
        res.set({ "Cache-Control": "private, no-cache", Vary: "Authorization" });

        // Unchanged since the browser last asked: answer 304 from the tiny ETag key,
        // without pulling the big list out of the cache at all.
        if (inm) {
            const known = await cacheGet(`${key}:etag`);
            if (known && known === inm) { res.set("ETag", known); return res.status(304).end(); }
        }

        // Built once per version (concurrent callers share one database query). The big blob lives in Redis only.
        const blob = await cached(key, CACHE_TTL_SEC, async () => {
            const fresh = await buildBlob(sellerId);
            await cacheSet(`${key}:etag`, fresh.slice(0, fresh.indexOf("\n")), CACHE_TTL_SEC);
            return fresh;
        }, { memory: false });

        const i = blob.indexOf("\n");
        const etag = blob.slice(0, i);
        res.set("ETag", etag);
        if (inm === etag) return res.status(304).end();
        res.type("application/json").send(blob.slice(i + 1));
    } catch (err) {
        console.error("[sellerListings] listAllMySubmissions failed:", err.message);
        res.status(500).json({ success: false, message: "Couldn't load your listings. Please try again." });
    }
}