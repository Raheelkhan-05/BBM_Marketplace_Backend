// src/services/seo.service.js
import { supabaseAdmin } from "../config/supabase.js";

export const SITE = (process.env.SITE_URL || "https://www.bbm.business").replace(/\/$/, "");

export const FIELDS = [
    "meta_title", "meta_description", "og_title", "og_description",
    "og_image", "canonical_url", "robots",
];
const LIMITS = { meta_title: 60, meta_description: 160, og_title: 60, og_description: 160, robots: 50 };

/* ───────────── slugs ───────────── */
// Brand URLs are case-insensitive in the app (/brands/Zerust == /brands/zerust), so brand slugs are
// stored lower-cased: one brand, one canonical URL. Seller slugs keep their case.
export function normalizeSlug(input) {
    let s = String(input || "").trim();
    try { s = new URL(s, SITE).pathname; } catch { /* keep as is */ }
    try { s = decodeURIComponent(s); } catch { /* keep as is */ }
    s = s.replace(/\/+$/, "");
    if (!s || s === "/home") s = "/";            // "/" redirects to /home in the SPA: treat as one page
    if (!s.startsWith("/")) s = `/${s}`;
    if (/^\/brands\/[^/]/.test(s)) s = s.toLowerCase();
    return s;
}

export function absoluteUrl(slug) {
    return SITE + (slug === "/" ? "/" : slug.split("/").map(encodeURIComponent).join("/"));
}

export function pageType(slug) {
    if (/^\/brands\/[^/]+$/.test(slug)) return "brand";
    if (/^\/sellers\/[^/]+$/.test(slug)) return "seller";
    return "static";
}

// Mirrors public/robots.txt: only these are meant to be indexed.
const PUBLIC_PATTERNS = [/^\/$/, /^\/brands(\/[^/]+)?$/, /^\/sellers(\/[^/]+)?$/, /^\/grow\/details$/, /^\/save$/];
export const isPublicPage = (slug) => PUBLIC_PATTERNS.some((r) => r.test(slug));

/* ───────────── defaults, built from real data ───────────── */
function clip(s, n) {
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const sp = cut.lastIndexOf(" ");
    return (sp > n - 20 ? cut.slice(0, sp) : cut).trim();
}

const STATIC_DEFAULTS = {
    "/": ["BBM – Wholesale Marketplace for Verified Sellers", "Compare wholesale prices, MOQs and delivery from verified sellers across India. Buy or sell on BBM."],
    "/brands": ["Brands on BBM – Shop wholesale products by brand", "Browse industrial and wholesale brands on BBM. Compare verified sellers, MOQs and delivery times for every brand."],
    "/sellers": ["Sellers on BBM – Verified wholesale suppliers", "Find verified wholesale sellers and suppliers on BBM. See their products, MOQs and delivery locations."],
    "/grow/details": ["Sell on BBM – Grow Your Wholesale Business", "List your products, receive enquiries and sell to buyers across India on BBM."],
    "/save": ["Save on Wholesale Purchases | BBM", "Source products at better prices from verified sellers on BBM."],
};

async function lookupBrand(name) {
    const { data, error } = await supabaseAdmin
        .from("hs_generic_product_brands")
        .select("brand_name, brand_image")
        .ilike("brand_name", name.replace(/[\\%_]/g, "\\$&")) // no wildcards = case-insensitive equality
        .eq("review_status", "approved")
        .is("deleted_at", null)
        .limit(20);
    if (error || !data?.length) return null;
    return { name: data[0].brand_name, image: data.find((r) => r.brand_image)?.brand_image || null };
}

async function lookupSeller(slug) {
    const { data } = await supabaseAdmin
        .from("seller_profiles")
        .select("display_name, city, state, logo_url, status")
        .eq("shop_slug", slug)
        .is("deleted_at", null)
        .maybeSingle();
    return data || null;
}

export async function buildDefault(slug) {
    const type = pageType(slug);
    let image = process.env.SEO_DEFAULT_OG_IMAGE || null;
    let robots = isPublicPage(slug) ? "index, follow" : "noindex, follow";
    let title, desc;

    if (type === "brand") {
        const b = await lookupBrand(slug.split("/")[2]);
        if (b) {
            title = `${b.name} Wholesale Products | BBM`;
            desc = `Buy ${b.name} products wholesale on BBM. Compare verified sellers, MOQs and delivery times.`;
            image = b.image || image;
        } else {
            title = "Brand not found | BBM";
            desc = "This brand is not available on BBM.";
            robots = "noindex, follow";
        }
    } else if (type === "seller") {
        const s = await lookupSeller(slug.split("/")[2]);
        if (s && s.status === "approved" && s.display_name) {
            const place = [s.city, s.state].filter(Boolean).join(", ");
            title = `${s.display_name}${place ? ` – ${place}` : ""} | BBM`;
            desc = `Shop wholesale products from ${s.display_name}${place ? ` in ${place}` : ""} on BBM. View MOQs, delivery and order directly.`;
            image = s.logo_url || image;
        } else {
            title = "Seller not found | BBM";
            desc = "This seller is not available on BBM.";
            robots = "noindex, follow";
        }
    } else if (STATIC_DEFAULTS[slug]) {
        [title, desc] = STATIC_DEFAULTS[slug];
    } else {
        title = "BBM – Wholesale Marketplace";
        desc = "BBM, the wholesale marketplace for verified sellers across India.";
    }

    title = clip(title, 60);
    desc = clip(desc, 160);
    return {
        meta_title: title, meta_description: desc, og_title: title, og_description: desc,
        og_image: image, canonical_url: absoluteUrl(slug), robots,
    };
}

/* ───────────── validation ───────────── */
export function validate(input) {
    const errors = [];
    for (const [f, max] of Object.entries(LIMITS)) {
        if (typeof input[f] === "string" && input[f].length > max) errors.push(`${f} exceeds ${max} chars`);
    }
    for (const f of ["og_image", "canonical_url"]) {
        if (input[f]) {
            try {
                if (new URL(input[f]).protocol !== "https:") errors.push(`${f} must be https`);
            } catch { errors.push(`${f} must be a valid URL`); }
        }
    }
    if (input.canonical_url && !String(input.canonical_url).startsWith(SITE)) {
        errors.push(`canonical_url must start with ${SITE}`);
    }
    return errors;
}

const pick = (row) => Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? null]));

/* ───────────── change log (sitemap / indexing; page edits are logged inside seo_upsert) ───────────── */
export async function logChange(e) {
    const { error } = await supabaseAdmin.from("seo_change_log").insert({
        request_id: e.requestId || null,
        entity_type: e.entityType,
        entity_key: e.entityKey || null,
        action: e.action,
        actor: e.actor || null,
        changed_fields: e.changedFields || null,
        before: e.before ?? null,
        after: e.after ?? null,
        result: e.result ?? null,
    });
    if (error) console.error("[seo] change-log insert failed:", error.message);
}

/* ───────────── read / write ───────────── */
export async function getSeo(slug) {
    const { data, error } = await supabaseAdmin.from("seo_metadata").select("*").eq("slug", slug).maybeSingle();
    if (error) throw error;
    if (data) return { slug, page_type: data.page_type, ...pick(data), source: "database", updated_at: data.updated_at };
    return { slug, page_type: pageType(slug), ...(await buildDefault(slug)), source: "default", updated_at: null };
}

export async function listSeo({ limit = 500, offset = 0 } = {}) {
    const lim = Math.min(Number(limit) || 500, 1000);
    const off = Number(offset) || 0;
    const { data, count, error } = await supabaseAdmin
        .from("seo_metadata")
        .select("*", { count: "exact" })
        .order("slug")
        .range(off, off + lim - 1);
    if (error) throw error;
    return {
        total: count ?? data.length,
        items: data.map((r) => ({ slug: r.slug, page_type: r.page_type, ...pick(r), updated_at: r.updated_at })),
    };
}

export async function upsertSeo(slug, input, { actor, requestId }) {
    const errors = validate(input);
    if (errors.length) return { errors };

    const payload = Object.fromEntries(
        FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f] === "" ? null : input[f]])
    );
    const defaults = await buildDefault(slug);

    const { data, error } = await supabaseAdmin.rpc("seo_upsert", {
        p_slug: slug,
        p_page_type: pageType(slug),
        p_input: payload,
        p_defaults: defaults,
        p_actor: actor,
        p_request_id: requestId,
    });
    if (error) throw error;

    const row = data.data;
    return {
        changed: data.changed,
        created: data.created,
        data: { slug, page_type: row.page_type, ...pick(row), updated_at: row.updated_at },
    };
}

/* ───────────── SSR meta payload ───────────── */
export async function getSsrMeta(slug) {
    const s = await getSeo(slug);
    const canonical = s.canonical_url || absoluteUrl(slug);
    const meta = [
        { name: "description", content: s.meta_description },
        { name: "robots", content: s.robots || "index, follow" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "BBM" },
        { property: "og:title", content: s.og_title || s.meta_title },
        { property: "og:description", content: s.og_description || s.meta_description },
        { property: "og:url", content: canonical },
        { name: "twitter:card", content: s.og_image ? "summary_large_image" : "summary" },
    ];
    if (s.og_image) meta.push({ property: "og:image", content: s.og_image });
    return {
        title: s.meta_title,
        meta: meta.filter((m) => m.content),
        link: [{ rel: "canonical", href: canonical }],
        source: s.source,
    };
}

/* ───────────── sitemap (your existing RPC-based builder, plus noindex exclusion + stats) ───────────── */
const PAGE = 60;
const MAX_PAGES = 400;
const MAX_URLS = 50000;
const TTL_MS = 60 * 60 * 1000;
const INCLUDE_PRODUCTS = process.env.SITEMAP_INCLUDE_PRODUCTS === "1";

const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function collect(rpcName, args, pickFn) {
    const out = [];
    for (let i = 0; i < MAX_PAGES; i++) {
        const { data, error } = await supabaseAdmin.rpc(rpcName, { ...args, p_limit: PAGE, p_offset: i * PAGE });
        if (error) throw new Error(`${rpcName}: ${error.message}`);
        const rows = pickFn(data) || [];
        out.push(...rows);
        if (!data?.hasMore || !rows.length) break;
    }
    return out;
}

async function buildPaths() {
    const [brands, sellers, products] = await Promise.all([
        collect("catalog_brands_page", { p_q: "" }, (d) => d?.brands),
        collect("catalog_sellers_page", { p_q: "", p_seller_id: null, p_buyer_id: null }, (d) => d?.sellers),
        INCLUDE_PRODUCTS
            ? collect(
                "catalog_browse_feed",
                {
                    p_category_id: null, p_q: "", p_sort: "relevance", p_seller_id: null, p_buyer_id: null,
                    p_followed_only: false, p_shop_slug: null, p_dest_pincode: null, p_dest_state: null,
                },
                (d) => d?.items
            )
            : Promise.resolve([]),
    ]);

    const groups = { static: ["/", "/brands", "/sellers", "/grow/details", "/save"], brands: [], sellers: [], products: [] };

    const seenBrands = new Set();
    for (const b of brands) {
        const name = String(b.brand_name || "").trim();
        if (!name || name.includes("/")) continue;
        if (Number(b.item_count) <= 0) continue;
        const key = name.toLowerCase();
        if (seenBrands.has(key)) continue;
        seenBrands.add(key);
        groups.brands.push(`/brands/${encodeURIComponent(key)}`); // lower-case = the canonical form
    }

    const seenShops = new Set();
    for (const s of sellers) {
        const slug = String(s.shop_slug || "").trim();
        if (!slug || seenShops.has(slug)) continue;
        seenShops.add(slug);
        groups.sellers.push(`/sellers/${encodeURIComponent(slug)}`);
    }

    const seenItems = new Set();
    for (const it of products) {
        if (it.lowest_price == null || seenItems.has(it.id)) continue;
        seenItems.add(it.id);
        groups.products.push(`/brand-item/${encodeURIComponent(it.slug || it.id)}/sellers`);
    }
    return groups;
}

let cache = { xml: null, stats: null, t: 0 };
let inflight = null;

export async function getSitemap({ force = false } = {}) {
    if (!force && cache.xml && Date.now() - cache.t < TTL_MS) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            const groups = await buildPaths();

            const { data: noindexRows } = await supabaseAdmin.from("seo_metadata").select("slug").ilike("robots", "%noindex%");
            const noindex = new Set((noindexRows || []).map((r) => r.slug));

            let excluded = 0;
            const breakdown = {};
            let paths = [];
            for (const [kind, list] of Object.entries(groups)) {
                const kept = list.filter((p) => {
                    const drop = noindex.has(normalizeSlug(p));
                    if (drop) excluded++;
                    return !drop;
                });
                breakdown[kind] = kept.length;
                paths.push(...kept);
            }
            paths = paths.slice(0, MAX_URLS);

            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${esc(SITE + p)}</loc></url>`).join("\n")}
</urlset>`;

            cache = {
                xml,
                t: Date.now(),
                stats: { total_urls: paths.length, breakdown, excluded_noindex: excluded, generated_at: new Date().toISOString() },
            };
            return cache;
        } catch (e) {
            console.error("[seo] sitemap build failed:", e.message);
            if (cache.xml) return cache; // serve the stale copy rather than an error
            throw e;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/* ───────────── Google Indexing API ───────────── */
export async function requestIndexing(urls, { actor, requestId }) {
    const raw = process.env.GOOGLE_INDEXING_SA_KEY;
    if (!raw) throw Object.assign(new Error("GOOGLE_INDEXING_SA_KEY is not set"), { status: 503 });

    const { JWT } = await import("google-auth-library"); // npm i google-auth-library
    const key = JSON.parse(raw);
    const client = new JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/indexing"] });

    const results = [];
    for (const url of urls) {
        let result;
        if (!url.startsWith(SITE)) {
            result = { url, status: "rejected", error: "URL is not on this site" };
        } else {
            try {
                const r = await client.request({
                    url: "https://indexing.googleapis.com/v3/urlNotifications:publish",
                    method: "POST",
                    data: { url, type: "URL_UPDATED" },
                });
                result = { url, status: "submitted", google_status: r.status };
            } catch (e) {
                result = { url, status: "failed", error: e.message };
            }
        }
        results.push(result);
        await logChange({ requestId, entityType: "indexing", entityKey: url, action: "submit", actor, result });
    }
    return results;
}