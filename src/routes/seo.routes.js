import { Router } from "express";
import { supabaseAdmin } from "../config/supabase.js";

const router = Router();

const SITE = "https://www.bbm.business";
const PAGE = 60;
const MAX_PAGES = 400;          // safety stop
const MAX_URLS = 50000;         // Google's limit per sitemap file
const TTL_MS = 60 * 60 * 1000;  // 1 hour

// Product pages are NOT in the sitemap until /brand-item/:slug/sellers is a live, real page.
// Set SITEMAP_INCLUDE_PRODUCTS=1 on the server only after that route works.
const INCLUDE_PRODUCTS = process.env.SITEMAP_INCLUDE_PRODUCTS === "1";

const esc = (s) =>
    String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

// Walks an RPC page by page until hasMore is false.
async function collect(rpcName, args, pick) {
    const out = [];
    for (let i = 0; i < MAX_PAGES; i++) {
        const { data, error } = await supabaseAdmin.rpc(rpcName, { ...args, p_limit: PAGE, p_offset: i * PAGE });
        if (error) throw new Error(`${rpcName}: ${error.message}`);
        const rows = pick(data) || [];
        out.push(...rows);
        if (!data?.hasMore || !rows.length) break;
    }
    return out;
}

async function buildPaths() {
    const [brands, sellers, products] = await Promise.all([
        collect("catalog_brands_page", { p_q: "" }, (d) => d?.brands),
        collect(
            "catalog_sellers_page",
            { p_q: "", p_seller_id: null, p_buyer_id: null }, // guest view
            (d) => d?.sellers
        ),
        INCLUDE_PRODUCTS
            ? collect(
                "catalog_browse_feed",
                {
                    p_category_id: null, p_q: "", p_sort: "relevance",
                    p_seller_id: null, p_buyer_id: null, p_followed_only: false,
                    p_shop_slug: null, p_dest_pincode: null, p_dest_state: null,
                },
                (d) => d?.items
            )
            : Promise.resolve([]),
    ]);

    const paths = ["/", "/brands", "/sellers", "/grow/details", "/save"];

    const seenBrands = new Set();
    for (const b of brands) {
        const name = String(b.brand_name || "").trim();
        if (!name || name.includes("/")) continue;           // a "/" would break the /brands/:brandName route
        if (Number(b.item_count) <= 0) continue;
        const key = name.toLowerCase();
        if (seenBrands.has(key)) continue;
        seenBrands.add(key);
        paths.push(`/brands/${encodeURIComponent(name)}`);
    }

    const seenShops = new Set();
    for (const s of sellers) {
        const slug = String(s.shop_slug || "").trim();
        if (!slug || seenShops.has(slug)) continue;
        seenShops.add(slug);
        paths.push(`/sellers/${encodeURIComponent(slug)}`);
    }

    const seenItems = new Set();
    for (const it of products) {
        if (it.lowest_price == null || seenItems.has(it.id)) continue; // skip items nobody can buy
        seenItems.add(it.id);
        paths.push(`/brand-item/${encodeURIComponent(it.slug || it.id)}/sellers`);
    }

    return paths.slice(0, MAX_URLS);
}

let cache = { xml: null, t: 0 };
let inflight = null;

async function getSitemapXml() {
    if (cache.xml && Date.now() - cache.t < TTL_MS) return cache.xml;
    if (inflight) return inflight; // many requests at once share one build

    inflight = (async () => {
        try {
            const paths = await buildPaths();
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${esc(SITE + p)}</loc></url>`).join("\n")}
</urlset>`;
            cache = { xml, t: Date.now() };
            return xml;
        } catch (e) {
            console.error("[seo] sitemap build failed:", e.message);
            if (cache.xml) return cache.xml; // serve the stale copy rather than an error
            throw e;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

router.get("/sitemap", async (req, res) => {
    try {
        const xml = await getSitemapXml();
        res.set("Cache-Control", "public, max-age=3600");
        res.type("application/xml").send(xml);
    } catch {
        res.status(500).type("text/plain").send("Sitemap unavailable");
    }
});

export default router;