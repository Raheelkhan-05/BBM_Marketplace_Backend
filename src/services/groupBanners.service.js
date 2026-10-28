// services/groupBanners.service.js
//
// - getActiveBanners(): live banners + all their image shapes (30s cache, invalidated on every admin write)
// - getHomeBanners(): the above + TODAY'S placement plan (same for every user; day = IST date)
// - scanCatalogGroups(): finds groups via catalog_browse_feed, records them, notifies admins about NEW ones
// - startGroupBannerWatcher(): runs the scan in the background
// - broadcastBannersChanged(): tells connected clients to refetch

import { supabaseAdmin } from "../config/supabase.js";
import { notifyUser } from "./notifications.service.js";
import { getIO } from "../socket/io.js";
import { BANNER_BUCKET, SHAPES, isShape } from "./bannerImages.service.js";

export { BANNER_BUCKET };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL_MS = 30_000;
const HOME_BANNER_MAX = Math.max(1, parseInt(process.env.HOME_BANNER_MAX || process.env.GROUP_BANNER_CAROUSEL_MAX || "200", 10) || 200);
export const PRIORITY_COUNT = Math.max(0, parseInt(process.env.HOME_BANNER_PRIORITY_COUNT || "3", 10) || 0);
const LOOKAHEAD = 4;
const SCAN_PAGE = 200;
const SCAN_MAX_PAGES = 60;
const SCAN_MIN_GAP_MS = 30_000;

// Same rule as catalog.controller.js
const GROUP_THRESHOLD = (() => {
    const n = parseInt(process.env.CATALOG_GROUP_THRESHOLD, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 6;
})();

const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
};

/* ───────────────────────── live banners (+ every shape) ───────────────────────── */

let cache = { t: 0, rows: null };
let generation = 0;
let inflight = null;

export function invalidateBannerCache() {
    generation += 1;
    cache = { t: 0, rows: cache.rows }; // keep stale rows as a fallback if the DB hiccups
}

export async function getActiveBanners() {
    if (cache.rows && Date.now() - cache.t < CACHE_TTL_MS) return cache.rows;
    if (inflight) return inflight;

    const gen = generation;
    inflight = (async () => {
        const { data, error } = await supabaseAdmin
            .from("group_banners")
            .select("group_id, image_url, alt_text, sort_order, created_at, group:catalog_group_registry(name, variant_count, is_active), extra:group_banner_images(shape, image_url)")
            .eq("is_active", true)
            .order("sort_order", { ascending: true })
            .order("created_at", { ascending: true })
            .limit(500);

        if (error) {
            console.error("[group-banners] getActiveBanners failed:", error.message);
            if (cache.rows) return cache.rows;
            throw error;
        }

        const rows = (data || [])
            .filter((r) => r.group && r.group.is_active)
            .slice(0, HOME_BANNER_MAX)
            .map((r) => {
                const images = { wide: r.image_url };
                for (const x of r.extra || []) if (isShape(x.shape) && x.image_url) images[x.shape] = x.image_url;
                return {
                    group_id: r.group_id,
                    name: r.group.name,
                    variant_count: r.group.variant_count,
                    image_url: r.image_url, // 16:9, kept for older clients / GroupBannerCard
                    alt_text: r.alt_text || null,
                    images,
                };
            });

        if (gen === generation) cache = { t: Date.now(), rows };
        return rows;
    })().finally(() => { inflight = null; });

    return inflight;
}

/* ───────────────────────── daily placement plan ─────────────────────────
   Deterministic: the same banners on the same IST day always give the same plan, for everyone.
   - first PRIORITY_COUNT banners (admin order) lead; the rest are ordered by hash(day + group_id),
     so adding/removing one banner doesn't reshuffle the others
   - block templates are picked by a day-seeded RNG; each slot takes the best shape fit among the next few banners
   Template counts/ratios MUST match TEMPLATES in components/home/GroupBannerBlock.jsx. */

const TEMPLATES = {
    hero: { weight: 3, ratios: [16 / 9] },
    duo: { weight: 3, ratios: [4 / 3, 4 / 3] },
    trio: { weight: 3, ratios: [3 / 4, 3 / 4, 3 / 4] },
    mosaic: { weight: 2, ratios: [3 / 4, 4 / 3, 4 / 3] },
    quad: { weight: 2, ratios: [1, 1, 1, 1] },
};

export const dayKey = (d = new Date()) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d); // YYYY-MM-DD

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}
function mulberry32(a) {
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 0 = the group has an image of exactly this ratio; higher = more cropping needed.
function fitCost(banner, ratio) {
    let best = Infinity;
    for (const shape of Object.keys(banner.images || {})) {
        const r = SHAPES[shape]?.ratio;
        if (r) best = Math.min(best, Math.abs(Math.log(ratio / r)));
    }
    return best;
}

export function buildPlan(banners, day) {
    const rng = mulberry32(fnv1a(`bbm-home-banners:${day}`));
    const priority = banners.slice(0, PRIORITY_COUNT);
    const rest = banners.slice(PRIORITY_COUNT)
        .map((b) => ({ b, k: fnv1a(`${day}:${b.group_id}`) }))
        .sort((x, y) => x.k - y.k || String(x.b.group_id).localeCompare(String(y.b.group_id)))
        .map((x) => x.b);
    const queue = [...priority, ...rest];

    const blocks = [];
    let prev = null;
    while (queue.length) {
        let names = Object.keys(TEMPLATES).filter((n) => TEMPLATES[n].ratios.length <= queue.length && n !== prev);
        if (blocks.length === 0 || !names.length) names = ["hero"]; // first block is always a hero
        const total = names.reduce((s, n) => s + TEMPLATES[n].weight, 0);
        let r = rng() * total;
        let name = names[names.length - 1];
        for (const n of names) { r -= TEMPLATES[n].weight; if (r <= 0) { name = n; break; } }

        const groups = [];
        for (const ratio of TEMPLATES[name].ratios) {
            const look = blocks.length === 0 ? 1 : Math.min(queue.length, LOOKAHEAD);
            let bestIdx = 0, bestCost = Infinity;
            for (let i = 0; i < look; i++) {
                const c = fitCost(queue[i], ratio);
                if (c < bestCost - 1e-9) { bestIdx = i; bestCost = c; }
            }
            groups.push(queue.splice(bestIdx, 1)[0].group_id);
        }
        blocks.push({ key: `${day}:${blocks.length}`, template: name, groups });
        prev = name;
    }
    return blocks;
}

let planCache = { day: null, rows: null, plan: null };

export async function getHomeBanners() {
    const rows = await getActiveBanners();
    const day = dayKey();
    if (planCache.rows === rows && planCache.day === day) return { banners: rows, plan: planCache.plan };
    const plan = { day, blocks: buildPlan(rows, day) };
    planCache = { day, rows, plan };
    return { banners: rows, plan };
}

// `_req` is kept so the controller calls don't change.
// Only logged-in users hold a socket (the handshake rejects guests), so guests catch up via the 60s poll.
export function broadcastBannersChanged(_req) {
    invalidateBannerCache();
    try {
        getIO().emit("group-banners:update", { t: Date.now() });
    } catch (e) {
        console.error("[group-banners] broadcast failed:", e?.message);
    }
}

/* ───────────────────────── new-group detection ───────────────────────── */

async function fetchAllGroupsFromFeed() {
    const found = new Map();
    for (let page = 0; page < SCAN_MAX_PAGES; page++) {
        const { data, error } = await supabaseAdmin.rpc("catalog_browse_feed", {
            p_category_id: null,
            p_q: "",
            p_sort: "relevance",
            p_limit: SCAN_PAGE,
            p_offset: page * SCAN_PAGE,
            p_seller_id: null,
            p_buyer_id: null,
            p_followed_only: false,
            p_shop_slug: null,
            p_dest_pincode: null,
            p_dest_state: null,
            p_group_threshold: GROUP_THRESHOLD,
            p_generic_product_id: null,
        });
        if (error) throw new Error(error.message);

        for (const it of data?.items || []) {
            if (it?.row_type !== "group") continue;
            const id = String(it.group_id || it.generic_product_id || it.id || "").toLowerCase();
            if (!UUID_RE.test(id)) continue;
            found.set(id, {
                group_id: id,
                name: String(it.name || "Untitled group").slice(0, 200),
                category_name: it.category_name || null,
                variant_count: Number(it.variant_count) || 0,
            });
        }
        if (!data?.hasMore) return { found, complete: true };
    }
    return { found, complete: false };
}

async function getAdminUserIds() {
    const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("role", "admin")
        .is("deleted_at", null);
    if (error) throw new Error(error.message);
    return (data || []).map((r) => r.id);
}

// Returns how many notifications were actually saved (notifyUser returns null on failure instead of throwing).
async function notifyAdminsOfNewGroups(groups) {
    const adminIds = await getAdminUserIds();
    if (!adminIds.length) return 0;

    const messages = groups.length > 5
        ? [{
            title: `${groups.length} new product groups need banners`,
            body: "New groups were created from product variants. Add a 16:9 banner for each so they look right on the Home page.",
            extra: { count: groups.length },
        }]
        : groups.map((g) => ({
            title: "New product group needs a banner",
            body: `“${g.name}” now has ${g.variant_count} variants. Add a 16:9 banner for the Home page.`,
            extra: { groupId: g.group_id },
        }));

    let saved = 0;
    for (const adminId of adminIds) {
        for (const m of messages) {
            const row = await notifyUser(adminId, {
                type: "group_banner_needed",
                title: m.title,
                body: m.body,
                link: "/admin/group-banners",
                ...m.extra, // socket-only hints, not persisted
            });
            if (row) saved += 1;
        }
    }
    return saved;
}

let scanPromise = null;
let lastScan = { at: 0, summary: null };
export const getLastScan = () => lastScan;

export function scanCatalogGroups({ force = false } = {}) {
    if (scanPromise) return scanPromise;
    if (!force && Date.now() - lastScan.at < SCAN_MIN_GAP_MS) {
        return Promise.resolve({ ...(lastScan.summary || {}), throttled: true });
    }
    if (GROUP_THRESHOLD <= 0) return Promise.resolve({ skipped: "grouping disabled" });

    scanPromise = (async () => {
        const { found, complete } = await fetchAllGroupsFromFeed();

        const { data: existing, error: exErr } = await supabaseAdmin
            .from("catalog_group_registry")
            .select("group_id, is_active")
            .range(0, 9999);
        if (exErr) throw new Error(exErr.message);

        const existingIds = new Set((existing || []).map((r) => String(r.group_id).toLowerCase()));
        const baseline = existingIds.size === 0; // first ever scan: record, don't notify
        const nowIso = new Date().toISOString();
        const all = [...found.values()];

        const fresh = all.filter((g) => !existingIds.has(g.group_id));
        for (const part of chunk(fresh, 500)) {
            const { error } = await supabaseAdmin
                .from("catalog_group_registry")
                .upsert(
                    part.map((g) => ({ ...g, is_active: true, first_seen_at: nowIso, last_seen_at: nowIso, admin_notified_at: baseline ? nowIso : null })),
                    { onConflict: "group_id", ignoreDuplicates: true }
                );
            if (error) throw new Error(error.message);
        }

        const known = all.filter((g) => existingIds.has(g.group_id));
        for (const part of chunk(known, 500)) {
            const { error } = await supabaseAdmin
                .from("catalog_group_registry")
                .upsert(part.map((g) => ({ ...g, is_active: true, last_seen_at: nowIso })), { onConflict: "group_id" });
            if (error) throw new Error(error.message);
        }

        // Only retire groups when the scan covered the whole catalog
        let deactivated = 0;
        if (complete) {
            const gone = (existing || [])
                .filter((r) => r.is_active && !found.has(String(r.group_id).toLowerCase()))
                .map((r) => r.group_id);
            for (const part of chunk(gone, 200)) {
                const { error } = await supabaseAdmin.from("catalog_group_registry").update({ is_active: false }).in("group_id", part);
                if (error) throw new Error(error.message);
            }
            deactivated = gone.length;
        }

        // Announce anything not yet announced (also retries earlier failures).
        // CLAIM first (atomic UPDATE ... WHERE admin_notified_at IS NULL), so two server
        // processes can never notify the same group twice. Release the claim if nothing was delivered.
        let notified = 0;
        const { data: claimed, error: claimErr } = await supabaseAdmin
            .from("catalog_group_registry")
            .update({ admin_notified_at: new Date().toISOString() })
            .is("admin_notified_at", null)
            .eq("is_active", true)
            .select("group_id, name, category_name, variant_count");
        if (claimErr) {
            console.error("[group-banners] claim failed:", claimErr.message);
        } else if (claimed?.length) {
            let saved = 0;
            try {
                saved = await notifyAdminsOfNewGroups(claimed);
            } catch (e) {
                console.error("[group-banners] admin notification failed:", e?.message);
            }
            if (saved > 0) {
                notified = claimed.length;
            } else {
                for (const part of chunk(claimed.map((c) => c.group_id), 200)) {
                    const { error } = await supabaseAdmin
                        .from("catalog_group_registry")
                        .update({ admin_notified_at: null })
                        .in("group_id", part);
                    if (error) console.error("[group-banners] releasing claim failed:", error.message);
                }
            }
        }

        if (fresh.length || deactivated) invalidateBannerCache();

        const summary = { found: found.size, created: fresh.length, deactivated, notified, complete };
        lastScan = { at: Date.now(), summary };
        return summary;
    })()
        .catch((e) => {
            console.error("[group-banners] scan failed:", e?.message);
            throw e;
        })
        .finally(() => { scanPromise = null; });

    return scanPromise;
}

let watcherStarted = false;
export function startGroupBannerWatcher({ intervalMs = 30 * 60 * 1000 } = {}) {
    if (watcherStarted) return;
    watcherStarted = true;
    const run = () => scanCatalogGroups({ force: true }).catch(() => { /* logged above */ });
    setTimeout(run, 60_000).unref?.();
    setInterval(run, intervalMs).unref?.();
}