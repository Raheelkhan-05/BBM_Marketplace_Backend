// services/aiBanners.service.js — AI banner generation: coverage detection, context, creative concepts, prompts, OpenAI calls, queue worker.
import { supabaseAdmin } from "../config/supabase.js";
import { validateAndUpload, removeObjects, SHAPE_KEYS, isShape } from "./bannerImages.service.js";
import { broadcastBannersChanged } from "./groupBanners.service.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const aiConfigured = () => !!process.env.OPENAI_API_KEY;
const imageModel = () => process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const textModel = () => process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";
const imageQuality = () => process.env.OPENAI_IMAGE_QUALITY || "medium";
const concurrency = () => Math.max(1, parseInt(process.env.AI_BANNER_CONCURRENCY || "1", 10) || 1);
export const aiModelName = () => imageModel();

const STALE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const hidden = (n) => String(n || "").trim().toLowerCase() === "pending";

/* ------------------------- coverage detection -------------------------
   Every group / category / subcategory, with the sizes it already has and the ones it lacks. */

export async function loadCoverage() {
    const [reg, gb, gi, cats, subs, eb, open] = await Promise.all([
        supabaseAdmin.from("catalog_group_registry").select("group_id, name, category_name, variant_count").eq("is_active", true).order("name").range(0, 4999),
        supabaseAdmin.from("group_banners").select("group_id, image_url, is_active, ai_generated").range(0, 9999),
        supabaseAdmin.from("group_banner_images").select("group_id, shape, image_url").range(0, 19999),
        supabaseAdmin.from("hs_categories").select("id, name").is("deleted_at", null).neq("review_status", "rejected").order("name").range(0, 4999),
        supabaseAdmin.from("hs_subcategories").select("id, name, category_id").is("deleted_at", null).neq("review_status", "rejected").order("name").range(0, 4999),
        supabaseAdmin.from("catalog_entity_banners").select("entity_type, entity_id, shape, image_url, is_active, ai_generated").range(0, 19999),
        supabaseAdmin.from("ai_banner_jobs").select("entity_type, entity_id, status").in("status", ["queued", "running"]),
    ]);

    const err = [reg, gb, gi, cats, subs, eb, open].find((r) => r.error);
    if (err) throw new Error(err.error.message);

    const openMap = new Map((open.data || []).map((j) => [`${j.entity_type}:${j.entity_id}`, j.status]));
    const catName = new Map((cats.data || []).map((c) => [c.id, c.name]));

    const groupRec = new Map();

    for (const r of gb.data || []) {
        groupRec.set(r.group_id, {
            images: r.image_url ? { wide: r.image_url } : {},
            ai: !!r.ai_generated,
            active: r.is_active !== false,
        });
    }

    for (const r of gi.data || []) {
        const rec = groupRec.get(r.group_id);
        if (rec && isShape(r.shape) && r.image_url) {
            rec.images[r.shape] = r.image_url;
        }
    }

    const entityRec = new Map();

    for (const r of eb.data || []) {
        const key = `${r.entity_type}:${r.entity_id}`;

        if (!entityRec.has(key)) {
            entityRec.set(key, { images: {}, ai: true, active: false });
        }

        const rec = entityRec.get(key);

        if (isShape(r.shape) && r.image_url) {
            rec.images[r.shape] = r.image_url;
        }

        rec.ai = rec.ai && !!r.ai_generated;
        rec.active = rec.active || r.is_active !== false;
    }

    const make = (type, id, name, sub, rec) => {
        const images = rec?.images || {};

        return {
            id,
            name,
            sub,
            have: SHAPE_KEYS.filter((k) => images[k]),
            missing: SHAPE_KEYS.filter((k) => !images[k]),
            preview: images.wide || images.landscape || images.square || images.portrait || null,
            ai: rec ? !!rec.ai : null,
            active: rec ? rec.active : null,
            state: openMap.get(`${type}:${id}`) || null,
        };
    };

    return {
        group: (reg.data || []).map((g) =>
            make("group", g.group_id, g.name, g.category_name || null, groupRec.get(g.group_id))
        ),

        category: (cats.data || [])
            .filter((c) => !hidden(c.name))
            .map((c) => make("category", c.id, c.name, null, entityRec.get(`category:${c.id}`))),

        subcategory: (subs.data || [])
            .filter((s) => !hidden(s.name))
            .map((s) =>
                make(
                    "subcategory",
                    s.id,
                    s.name,
                    catName.get(s.category_id) ? `in ${catName.get(s.category_id)}` : null,
                    entityRec.get(`subcategory:${s.id}`)
                )
            ),
    };
}

// items: [{ type, id, name, shapes?: string[] | null, force? }]
export async function enqueueJobs(items, { publish = false, userId = null } = {}) {
    if (!items.length) return { queued: 0 };

    const { data: open } = await supabaseAdmin
        .from("ai_banner_jobs")
        .select("entity_type, entity_id")
        .in("status", ["queued", "running"]);

    const openSet = new Set(
        (open || []).map((j) => `${j.entity_type}:${j.entity_id}`)
    );

    const rows = items
        .filter((i) => !openSet.has(`${i.type}:${i.id}`))
        .map((i) => ({
            entity_type: i.type,
            entity_id: i.id,
            entity_name: i.name || null,
            shapes: Array.isArray(i.shapes) && i.shapes.length
                ? i.shapes.filter(isShape)
                : null,
            publish: !!publish,
            force: !!i.force,
            created_by: userId ? String(userId) : null,
        }));

    if (!rows.length) return { queued: 0 };

    const { error } = await supabaseAdmin.from("ai_banner_jobs").insert(rows);

    if (!error) return { queued: rows.length };

    // Handle a race on the one-open-job-per-entity index.
    let queued = 0;

    for (const r of rows) {
        const { error: e } = await supabaseAdmin.from("ai_banner_jobs").insert(r);
        if (!e) queued++;
    }

    return { queued };
}

/* ------------------------- catalog context ------------------------- */

const uniq = (arr) =>
    [...new Set(arr.map((s) => String(s || "").trim()).filter(Boolean))];

async function buildContext(type, id) {
    if (type === "group") {
        const [gp, items, reg] = await Promise.all([
            supabaseAdmin
                .from("hs_generic_products")
                .select("id, name, subcategory:hs_subcategories(name, category:hs_categories(name))")
                .eq("id", id)
                .maybeSingle(),

            supabaseAdmin
                .from("hs_generic_product_brands")
                .select("*")
                .eq("generic_product_id", id)
                .eq("review_status", "approved")
                .is("deleted_at", null)
                .limit(60),

            supabaseAdmin
                .from("catalog_group_registry")
                .select("name, category_name")
                .eq("group_id", id)
                .maybeSingle(),
        ]);

        const name = gp.data?.name || reg.data?.name;
        if (!name) return null;

        const sub = gp.data?.subcategory;
        const path = [
            sub?.category?.name || reg.data?.category_name,
            sub?.name,
        ].filter(Boolean).join(" > ");

        const variants = uniq((items.data || []).map((r) => r.name)).slice(0, 40);
        const brands = uniq((items.data || []).map((r) => r.brand_name));

        return {
            kind: "group",
            name,
            brands,
            brief: {
                level: "product range (one generic product sold by many sellers in many variants)",
                name,
                catalog_path: path || null,
                example_variant_listings: variants,
            },
        };
    }

    if (type === "subcategory") {
        const [s, gps] = await Promise.all([
            supabaseAdmin
                .from("hs_subcategories")
                .select("id, name, category:hs_categories(name)")
                .eq("id", id)
                .maybeSingle(),

            supabaseAdmin
                .from("hs_generic_products")
                .select("name")
                .eq("subcategory_id", id)
                .is("deleted_at", null)
                .limit(60),
        ]);

        if (!s.data) return null;

        return {
            kind: "subcategory",
            name: s.data.name,
            brands: [],
            brief: {
                level: "subcategory (a group of related generic products)",
                name: s.data.name,
                parent_category: s.data.category?.name || null,
                generic_products_covered: uniq((gps.data || []).map((r) => r.name)),
            },
        };
    }

    const c = await supabaseAdmin
        .from("hs_categories")
        .select("id, name")
        .eq("id", id)
        .maybeSingle();

    if (!c.data) return null;

    const subs = await supabaseAdmin
        .from("hs_subcategories")
        .select("id, name")
        .eq("category_id", id)
        .is("deleted_at", null)
        .neq("review_status", "rejected")
        .limit(60);

    const subIds = (subs.data || []).map((x) => x.id);

    const gps = subIds.length
        ? await supabaseAdmin
            .from("hs_generic_products")
            .select("name")
            .in("subcategory_id", subIds)
            .is("deleted_at", null)
            .limit(80)
        : { data: [] };

    return {
        kind: "category",
        name: c.data.name,
        brands: [],
        brief: {
            level: "top-level category (a broad department)",
            name: c.data.name,
            subcategories_listed: uniq((subs.data || []).map((x) => x.name)),
            sample_generic_products: uniq((gps.data || []).map((x) => x.name)).slice(0, 40),
        },
    };
}

/* ------------------------- OpenAI ------------------------- */

async function openai(path, body, { timeoutMs = 150_000, tries = 4 } = {}) {
    for (let attempt = 1; ; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let res;

        try {
            res = await fetch(`https://api.openai.com/v1${path}`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: ctl.signal,
            });
        } catch (e) {
            clearTimeout(timer);

            if (attempt >= tries) {
                throw new Error(
                    `OpenAI request failed: ${e.name === "AbortError" ? "timed out" : e.message}`
                );
            }

            await sleep(3000 * attempt);
            continue;
        }

        clearTimeout(timer);

        if (res.ok) return res.json();

        const text = await res.text().catch(() => "");

        if ((res.status === 429 || res.status >= 500) && attempt < tries) {
            const ra = Number(res.headers.get("retry-after"));
            await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000 * attempt);
            continue;
        }

        let msg = text;

        try {
            msg = JSON.parse(text)?.error?.message || text;
        } catch {
            // Keep the raw response.
        }

        throw new Error(`OpenAI ${res.status}: ${String(msg).slice(0, 250)}`);
    }
}

/* ===== DESIGN SYSTEM BEGIN =====
   Palettes, layout vocabulary, concept normalisation and the vector copy overlay.
   Nothing in this block touches the database or the network. */

const randOf = (list) => list[Math.floor(Math.random() * list.length)];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Palettes span the colour wheel while staying light, sober and premium (plus a few dark studio looks).
// Every palette is contrast-checked: ink and support text on wash, and onAccent on accent, all >= 4.5:1.
const lightPal = (wash, ink, support, accent, bg) => ({
    dark: false, wash, ink, support, accent, onAccent: "#FFFFFF",
    cardFill: "#FFFFFF", cardOp: 0.85, cardStroke: ink, bg,
});

const darkPal = (wash, ink, support, accent, onAccent, bg) => ({
    dark: true, wash, ink, support, accent, onAccent,
    cardFill: "#FFFFFF", cardOp: 0.09, cardStroke: "#FFFFFF", bg,
});

const PALETTES = {
    ivory: lightPal("#FBF7F0", "#1B2A2F", "#44535A", "#C2410C", "warm ivory / pale cream seamless backdrop, bright soft studio light"),
    mist: lightPal("#EEF4FA", "#0F2A44", "#3B536B", "#1D4ED8", "pale cool mist blue-grey backdrop, clean bright daylight studio light"),
    sage: lightPal("#EEF5EF", "#12301F", "#3F5A49", "#15803D", "soft sage-white backdrop with gentle green-grey tonal depth, bright natural light"),
    blush: lightPal("#FBEFEF", "#3A1620", "#6A4450", "#BE185D", "pale blush / rose-white backdrop, soft diffused light"),
    sand: lightPal("#F6EEDF", "#2E2414", "#5E5037", "#B45309", "warm sand / oat backdrop with subtle mineral texture, golden soft light"),
    lilac: lightPal("#F3EFFA", "#24193F", "#52466B", "#6D28D9", "pale lilac-lavender backdrop, soft cool diffused light"),
    aqua: lightPal("#E8F6F7", "#0B3038", "#3D6068", "#0E7490", "pale aqua / seafoam backdrop, fresh bright studio light"),
    citrus: lightPal("#F6F8E4", "#25300E", "#556033", "#4D7C0F", "pale lime-cream backdrop with a fresh yellow-green tint, bright airy light"),
    coral: lightPal("#FDEEEA", "#3C1512", "#6E4540", "#B91C1C", "soft coral-peach backdrop, warm gentle light"),
    jade: lightPal("#E9F5F1", "#0A3027", "#3C6256", "#0F766E", "pale jade / mint-green backdrop, clean bright light"),
    butter: lightPal("#FBF5DC", "#33290A", "#665A28", "#A16207", "soft butter-yellow backdrop, warm sunny soft light"),
    stone: lightPal("#F1F0EC", "#22211F", "#55524C", "#1E3A8A", "neutral warm stone-grey backdrop with fine mineral texture, even soft light"),
    slate: darkPal("#111C27", "#FFFFFF", "#CBD5E1", "#FBBF24", "#111C27", "deep slate-navy backdrop, low-key moody studio lighting with crisp rim light"),
    teal: darkPal("#0B2B2E", "#F4FBFA", "#B7D9D5", "#2DD4BF", "#06292B", "deep teal-green backdrop, low-key studio lighting with controlled specular highlights"),
    plum: darkPal("#1F1630", "#FFFFFF", "#D9CDEB", "#F472B6", "#2A0F20", "deep aubergine-plum backdrop, low-key dramatic studio lighting with soft rim light"),
    forest: darkPal("#0F2417", "#F1FAF3", "#BBD8C3", "#86EFAC", "#0B2414", "deep forest-green backdrop, low-key studio lighting with soft rim light"),
    burgundy: darkPal("#2A1015", "#FFF5F5", "#E3C4C8", "#FCA5A5", "#2A1015", "deep burgundy-wine backdrop, low-key dramatic lighting with warm rim light"),
};

const PALETTE_GUIDE = Object.entries(PALETTES)
    .map(([k, p]) => `${k} (${p.bg.split(",")[0]})`)
    .join("; ");

const LIGHT_PALETTES = Object.keys(PALETTES).filter((k) => !PALETTES[k].dark);
const LEGACY_ACCENT = { orange: "ivory", blue: "mist", green: "sage" };

const SIDE_H = ["left", "right"];
const SIDE_V = ["top", "bottom"];
const ALIGN_V = ["left", "center"];
const VALIGN = ["top", "center", "bottom"];
const KICKER_STYLES = ["rule", "tag", "plain"];
const BENEFIT_STYLES = ["dots", "ticks", "chips", "bars"];
const CTA_STYLES = ["pill", "block", "outline", "link"];
const CTA_POS = ["above_benefits", "below_benefits"];
const CASES = ["title", "upper"];

// What older, pre-redesign concepts looked like, so partial re-runs stay consistent with existing images.
const LEGACY_DEFAULTS = {
    palette: "mist",
    side_h: "left",
    side_v: "top",
    align_v: "left",
    copy_valign: "center",
    kicker_style: "rule",
    benefit_style: "dots",
    cta_style: "pill",
    cta_position: "below_benefits",
    headline_case: "title",
};

const DEFAULT_CTA = "Explore range";
const DEFAULT_DIRECTION = "Offset sculptural product arrangement with deliberate negative space, crisp directional studio light and believable contact shadows";
const DEFAULT_CAMERA = "controlled three-quarter camera angle at product height";

const fallbackLabel = (ctx) => ctx.name.split(/\s+/).slice(0, 4).join(" ");

const fallbackHero = (ctx) => {
    const list = (
        ctx.brief.generic_products_covered ||
        ctx.brief.sample_generic_products ||
        ctx.brief.example_variant_listings ||
        []
    ).slice(0, 4);

    return list.length ? list : [ctx.name];
};

const cleanLine = (v, max) =>
    String(v ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// Turns whatever the model returned (or a stored concept) into a complete, safe concept.
// Missing layout fields fall back to `dflt`, or to a random choice when there is no default.
function normalizeConcept(raw, ctx, dflt = {}) {
    const r = raw && typeof raw === "object" ? raw : {};

    const pickEnum = (key, list) => {
        if (list.includes(r[key])) return r[key];
        if (list.includes(dflt[key])) return dflt[key];
        return randOf(list);
    };

    const fb = fallbackLabel(ctx);
    let label = cleanLine(r.label, 60).replace(/["“”]/g, "").trim();

    if (!label || label.length > 40 || label.split(" ").length > 4) label = fb;

    const low = label.toLowerCase();

    if ((ctx.brands || []).some((b) =>
        b.length >= 3 && new RegExp(`\\b${escapeRe(b.toLowerCase())}\\b`).test(low)
    )) {
        label = fb;
    }

    const hero = (Array.isArray(r.hero_items) ? r.hero_items : [])
        .map((v) => cleanLine(v, 60))
        .filter(Boolean)
        .slice(0, 4);

    let cta = cleanLine(r.cta_label, 24).replace(/[^\p{L}\p{N}\s&'-]/gu, "").trim();

    if (!cta || cta.split(" ").length > 3 || cta.length > 18) cta = DEFAULT_CTA;

    cta = cta.charAt(0).toUpperCase() + cta.slice(1);

    const palette = PALETTES[r.palette]
        ? r.palette
        : LEGACY_ACCENT[r.accent] || (PALETTES[dflt.palette] ? dflt.palette : randOf(LIGHT_PALETTES));

    return {
        label,
        hero_items: hero.length >= 2 ? hero : fallbackHero(ctx),
        palette,
        idea: cleanLine(r.idea, 240),
        visual_direction: cleanLine(r.visual_direction, 340) || DEFAULT_DIRECTION,
        camera: cleanLine(r.camera, 140) || DEFAULT_CAMERA,
        side_h: pickEnum("side_h", SIDE_H),
        side_v: pickEnum("side_v", SIDE_V),
        align_v: pickEnum("align_v", ALIGN_V),
        copy_valign: pickEnum("copy_valign", VALIGN),
        kicker_style: pickEnum("kicker_style", KICKER_STYLES),
        cta_style: pickEnum("cta_style", CTA_STYLES),
        cta_position: pickEnum("cta_position", CTA_POS),
        headline_case: pickEnum("headline_case", CASES),
        cta_label: cta,
    };
}

/* ---- text measuring ---- */

const FONT = "DejaVu Sans, Arial, sans-serif";

const copyEscape = (v) =>
    String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

// Conservative width estimate (bold DejaVu Sans) so copy never spills into the image area or other elements.
function estimatedWidth(text, fontSize, { bold = false, ls = 0 } = {}) {
    const s = String(text);
    let units = 0;

    for (const ch of s) {
        units += /[ilI.,'!|]/.test(ch) ? 0.33
            : /[MW@%&]/.test(ch) ? 0.98
                : /[A-Z0-9]/.test(ch) ? 0.76
                    : ch === " " ? 0.37
                        : 0.68;
    }

    return units * fontSize * (bold ? 1.05 : 1) + ls * s.length;
}

function wrapText(text, maxWidth, fontSize) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";

    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;

        if (!line || estimatedWidth(candidate, fontSize, { bold: true }) <= maxWidth) {
            line = candidate;
        } else {
            lines.push(line);
            line = word;
        }
    }

    if (line) lines.push(line);

    return lines.length ? lines : [""];
}

function fitHeadline(label, maxWidth, baseSize, maxLines = 3, minSize = 40) {
    let fontSize = baseSize;
    let lines = wrapText(label, maxWidth, fontSize);

    const doesNotFit = () =>
        lines.length > maxLines ||
        lines.some((line) => estimatedWidth(line, fontSize, { bold: true }) > maxWidth);

    while (doesNotFit() && fontSize > minSize) {
        fontSize -= 2;
        lines = wrapText(label, maxWidth, fontSize);
    }

    return { fontSize, lines };
}

const txt = (x, y, s, size, fill, { weight = 700, ls = 0, anchor = "start" } = {}) =>
    `<text x="${Math.round(x)}" y="${Math.round(y)}" fill="${fill}" font-family="${FONT}" font-size="${Math.round(size)}" font-weight="${weight}"${ls ? ` letter-spacing="${ls}"` : ""}${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}>${copyEscape(s)}</text>`;

/* ---- geometry tables ---- */

const isHorizontal = (shape) => shape === "wide" || shape === "landscape";

// Fraction of the canvas reserved for copy on stacked (square / portrait) layouts.
// Kept small on purpose so the products get the larger share of the banner.
const ZONE = { square: 0.44, portrait: 0.44 };

// Base sizes in px at the final output width. Supporting copy stays around 3-5% of the banner width
// so it remains readable on a phone.
const BASE = {
    wide: { kicker: 30, title: 108, benefit: 46, cta: 40 },
    landscape: { kicker: 28, title: 98, benefit: 44, cta: 38 },
    square: { kicker: 30, title: 96, benefit: 44, cta: 42 },
    portrait: { kicker: 32, title: 104, benefit: 48, cta: 44 },
};

const KICKER = {
    group: "PRODUCT RANGE",
    subcategory: "PRODUCT SUBCATEGORY",
    category: "PRODUCT CATEGORY",
};

/* ---- benefit rows ---- */

function benefitItem(style, text, fs, pal) {
    const tw = estimatedWidth(text, fs, { bold: true });
    const accent = pal.accent;

    if (style === "chips") {
        const h = Math.round(fs * 1.7);
        const padX = Math.round(fs * 0.65);
        const w = Math.round(tw + padX * 2);

        return {
            w, h,
            draw: (x, y) =>
                `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${accent}" fill-opacity="${pal.dark ? 0.2 : 0.13}" stroke="${accent}" stroke-opacity="0.6" stroke-width="2.5"/>` +
                txt(x + padX, y + h / 2 + fs * 0.36, text, fs, pal.ink),
        };
    }

    if (style === "bars") {
        const h = Math.round(fs * 1.7);
        const lead = Math.round(fs * 0.5);
        const bar = 7;
        const gap = Math.round(fs * 0.4);
        const padR = Math.round(fs * 0.6);
        const w = Math.round(lead + bar + gap + tw + padR);

        return {
            w, h,
            draw: (x, y) =>
                `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.round(h * 0.22)}" fill="${pal.cardFill}" fill-opacity="${pal.cardOp}" stroke="${pal.cardStroke}" stroke-opacity="0.12" stroke-width="2"/>` +
                `<rect x="${x + lead}" y="${y + h * 0.2}" width="${bar}" height="${h * 0.6}" rx="3.5" fill="${accent}"/>` +
                txt(x + lead + bar + gap, y + h / 2 + fs * 0.36, text, fs, pal.ink),
        };
    }

    if (style === "ticks") {
        const h = Math.round(fs * 1.5);
        const d = Math.round(fs * 0.95);
        const off = d + Math.round(fs * 0.4);
        const w = Math.round(off + tw);

        return {
            w, h,
            draw: (x, y) => {
                const cx = x + d / 2;
                const cy = y + h / 2;

                return `<circle cx="${cx}" cy="${cy}" r="${d / 2}" fill="${accent}"/>` +
                    `<path d="M ${cx - d * 0.22} ${cy + d * 0.02} L ${cx - d * 0.05} ${cy + d * 0.19} L ${cx + d * 0.24} ${cy - d * 0.15}" fill="none" stroke="${pal.onAccent}" stroke-width="${Math.max(3, Math.round(fs * 0.09))}" stroke-linecap="round" stroke-linejoin="round"/>` +
                    txt(x + off, y + h / 2 + fs * 0.36, text, fs, pal.ink);
            },
        };
    }

    // dots
    const h = Math.round(fs * 1.5);
    const r = Math.round(fs * 0.17);
    const off = Math.round(fs * 0.62);
    const w = Math.round(off + tw);

    return {
        w, h,
        draw: (x, y) =>
            `<circle cx="${x + r}" cy="${y + h / 2}" r="${r}" fill="${accent}"/>` +
            txt(x + off, y + h / 2 + fs * 0.36, text, fs, pal.ink),
    };
}

/* ---- CTA buttons ----
   Width is derived from the measured label, so the arrow always sits after the text with a clear gap. */

function ctaButton(style, label, fs0, maxW, pal) {
    const accent = pal.accent;

    const dims = (f) => {
        const tw = estimatedWidth(label, f, { bold: true });

        if (style === "pill") {
            const h = Math.round(f * 2.1);
            const padL = Math.round(f * 0.95);
            const gap = Math.round(f * 0.75);
            const d = Math.round(h * 0.62);
            const padR = Math.round((h - d) / 2);

            return { tw, h, padL, gap, d, padR, w: Math.round(padL + tw + gap + d + padR) };
        }

        if (style === "link") {
            const h = Math.round(f * 1.55);
            const gap = Math.round(f * 0.6);
            const aw = Math.round(f * 0.7);

            return { tw, h, gap, aw, w: Math.round(tw + gap + aw) };
        }

        // block + outline
        const h = Math.round(f * 2.0);
        const padL = Math.round(f * 0.95);
        const gap = Math.round(f * 0.75);
        const aw = Math.round(f * 0.7);

        return { tw, h, padL, gap, aw, padR: padL, w: Math.round(padL + tw + gap + aw + padL) };
    };

    let f = fs0;
    let d = dims(f);

    while (f > 22 && d.w > maxW) {
        f -= 1;
        d = dims(f);
    }

    const arrow = (ax, cy, aw, color) => {
        const ah = Math.round(aw * 0.42);

        return `<path d="M ${ax} ${cy} H ${ax + aw} M ${ax + aw - ah} ${cy - ah} L ${ax + aw} ${cy} L ${ax + aw - ah} ${cy + ah}" fill="none" stroke="${color}" stroke-width="${Math.max(3, Math.round(f * 0.11))}" stroke-linecap="round" stroke-linejoin="round"/>`;
    };

    const shadow = (x, y, rx) =>
        pal.dark
            ? ""
            : `<rect x="${x}" y="${y + 5}" width="${d.w}" height="${d.h}" rx="${rx}" fill="${pal.ink}" opacity="0.16"/>`;

    if (style === "pill") {
        return {
            w: d.w, h: d.h,
            draw: (x, y) => {
                const ccx = x + d.w - d.padR - d.d / 2;
                const cy = y + d.h / 2;
                const aw = Math.round(d.d * 0.46);

                return shadow(x, y, d.h / 2) +
                    `<rect x="${x}" y="${y}" width="${d.w}" height="${d.h}" rx="${d.h / 2}" fill="${accent}"/>` +
                    txt(x + d.padL, cy + f * 0.34, label, f, pal.onAccent) +
                    `<circle cx="${ccx}" cy="${cy}" r="${d.d / 2}" fill="${pal.onAccent}"/>` +
                    arrow(Math.round(ccx - aw / 2), cy, aw, accent === pal.onAccent ? pal.ink : (pal.dark ? pal.wash : accent));
            },
        };
    }

    if (style === "block") {
        return {
            w: d.w, h: d.h,
            draw: (x, y) => {
                const rx = Math.round(d.h * 0.18);
                const cy = y + d.h / 2;

                return shadow(x, y, rx) +
                    `<rect x="${x}" y="${y}" width="${d.w}" height="${d.h}" rx="${rx}" fill="${pal.ink}"/>` +
                    txt(x + d.padL, cy + f * 0.34, label, f, pal.wash) +
                    arrow(x + d.w - d.padR - d.aw, cy, d.aw, pal.dark ? pal.wash : accent);
            },
        };
    }

    if (style === "outline") {
        return {
            w: d.w, h: d.h,
            draw: (x, y) => {
                const cy = y + d.h / 2;

                return `<rect x="${x + 2}" y="${y + 2}" width="${d.w - 4}" height="${d.h - 4}" rx="${(d.h - 4) / 2}" fill="${pal.wash}" fill-opacity="0.6" stroke="${accent}" stroke-width="4"/>` +
                    txt(x + d.padL, cy + f * 0.34, label, f, pal.ink) +
                    arrow(x + d.w - d.padR - d.aw, cy, d.aw, accent);
            },
        };
    }

    // link
    return {
        w: d.w, h: d.h,
        draw: (x, y) =>
            txt(x, y + f * 0.95, label, f, pal.ink) +
            arrow(x + d.tw + d.gap, y + Math.round(f * 0.6), d.aw, accent) +
            `<rect x="${x}" y="${y + d.h - 5}" width="${d.w}" height="5" rx="2.5" fill="${accent}"/>`,
    };
}

/* ---- copy block ----
   Built in local coordinates (y = 0 is the top of the block), measured, then placed by the caller. */

function layoutCopy(concept, ctx, shape, W, H, k, nBenefits, showKicker) {
    const pal = PALETTES[concept.palette] || PALETTES.mist;
    const accent = pal.accent;
    const horizontal = isHorizontal(shape);
    const centered = !horizontal && concept.align_v === "center";
    const base = BASE[shape];

    const marginX = Math.round(W * (horizontal ? 0.06 : 0.065));
    const textW = horizontal ? Math.round(W * 0.40) : W - marginX * 2;
    const x0 = horizontal && concept.side_h === "right" ? W - marginX - textW : marginX;
    const cx = Math.round(x0 + textW / 2);
    const anchor = centered ? "middle" : "start";
    const tx = centered ? cx : x0;
    const sec = Math.round(30 * k);

    const els = [];
    let y = 0;

    if (showKicker) {
        const kfs = Math.round(base.kicker * k);
        const label = KICKER[ctx.kind];
        const ls = Math.round(kfs * 0.08);
        const kw = estimatedWidth(label, kfs, { bold: true, ls });

        if (concept.kicker_style === "tag") {
            const padX = Math.round(kfs * 0.7);
            const h = Math.round(kfs * 1.9);
            const w = Math.round(kw + padX * 2);
            const bx = centered ? Math.round(cx - w / 2) : x0;

            els.push(`<rect x="${bx}" y="${y}" width="${w}" height="${h}" rx="${Math.round(h * 0.28)}" fill="${accent}"/>`);
            els.push(txt(bx + padX, y + h / 2 + kfs * 0.365, label, kfs, pal.onAccent, { ls }));
            y += h;
        } else if (concept.kicker_style === "rule") {
            const ruleW = Math.round(kfs * 1.6);
            const gap = Math.round(kfs * 0.55);
            const bx = centered ? Math.round(cx - (ruleW + gap + kw) / 2) : x0;

            els.push(`<line x1="${bx}" y1="${y + kfs * 0.5}" x2="${bx + ruleW}" y2="${y + kfs * 0.5}" stroke="${accent}" stroke-width="${Math.max(4, Math.round(kfs * 0.18))}" stroke-linecap="round"/>`);
            els.push(txt(bx + ruleW + gap, y + kfs * 0.865, label, kfs, pal.support, { ls }));
            y += kfs;
        } else {
            els.push(txt(tx, y + kfs * 0.865, label, kfs, accent, { ls, anchor }));
            y += kfs;
        }

        y += Math.round(kfs * 0.8);
    }

    const upper = concept.headline_case === "upper";
    const head = upper ? concept.label.toUpperCase() : concept.label;
    const title = fitHeadline(head, textW, Math.round(base.title * k), shape === "square" ? 2 : 3);
    const lh = Math.round(title.fontSize * 1.06);
    const tls = upper ? 0 : -Math.round(title.fontSize * 0.012);

    title.lines.forEach((line, i) => {
        els.push(txt(tx, y + title.fontSize * 0.86 + i * lh, line, title.fontSize, pal.ink, { ls: tls, anchor }));
    });

    y += (title.lines.length - 1) * lh + Math.round(title.fontSize * 1.08);

    // const blocks = [];
    // const benefits = concept.benefits.slice(0, nBenefits);
    // const style = concept.benefit_style;

    // if (benefits.length) {
    //     const startFs = Math.round(base.benefit * k);
    //     let block = null;

    //     // Square banners: both benefits share one line, which saves height for the products.
    //     if (shape === "square" && benefits.length > 1) {
    //         const measure = (f) => {
    //             const items = benefits.map((t) => benefitItem(style, t, f, pal));
    //             const gap = Math.round(f * 0.6);
    //             const total = items.reduce((s, b) => s + b.w, 0) + gap * (items.length - 1);

    //             return { items, gap, total };
    //         };

    //         const minFs = Math.round(startFs * 0.78);
    //         let f = startFs;
    //         let m = measure(f);

    //         while (f > minFs && m.total > textW) {
    //             f -= 1;
    //             m = measure(f);
    //         }

    //         if (m.total <= textW) {
    //             block = {
    //                 h: Math.max(...m.items.map((b) => b.h)),
    //                 draw: (top) => {
    //                     let xx = centered ? Math.round(cx - m.total / 2) : x0;
    //                     const out = [];

    //                     for (const b of m.items) {
    //                         out.push(b.draw(xx, top));
    //                         xx += b.w + m.gap;
    //                     }

    //                     return out;
    //                 },
    //             };
    //         }
    //     }

    //     if (!block) {
    //         const list = shape === "square" ? benefits.slice(0, 1) : benefits;
    //         let fs = startFs;
    //         const build = () => list.map((t) => benefitItem(style, t, fs, pal));
    //         let built = build();

    //         while (fs > 20 && built.some((b) => b.w > textW)) {
    //             fs -= 1;
    //             built = build();
    //         }

    //         const rowGap = Math.round(fs * 0.3);
    //         const h = built.reduce((s, b) => s + b.h, 0) + rowGap * (built.length - 1);

    //         block = {
    //             h,
    //             draw: (top) => {
    //                 let yy = top;
    //                 const out = [];

    //                 for (const b of built) {
    //                     out.push(b.draw(centered ? Math.round(cx - b.w / 2) : x0, yy));
    //                     yy += b.h + rowGap;
    //                 }

    //                 return out;
    //             },
    //         };
    //     }

    //     blocks.push(block);
    // }

    // if (ctx.kind === "group") {
    //     const btn = ctaButton(concept.cta_style, concept.cta_label, Math.round(base.cta * k), textW, pal);

    //     const cta = {
    //         h: btn.h,
    //         draw: (top) => [btn.draw(centered ? Math.round(cx - btn.w / 2) : x0, top)],
    //     };

    //     if (concept.cta_position === "above_benefits") blocks.unshift(cta);
    //     else blocks.push(cta);
    // }

    // for (const b of blocks) {
    //     y += sec;
    //     els.push(...b.draw(y));
    //     y += b.h;
    // }

    return { els, h: Math.round(y) };
}

// The wash fades out just before the products start, so it never hazes them.
function copyWash(shape, concept, pal) {
    const z = isHorizontal(shape) ? 0.46 : ZONE[shape] - 0.03;

    const stops = [[0, 0.99], [0.72 * z, 0.98], [0.92 * z, 0.92], [z, 0.7], [1.12 * z, 0.2], [1.24 * z, 0]];

    let axis;

    if (isHorizontal(shape)) {
        axis = concept.side_h === "right" ? `x1="1" y1="0" x2="0" y2="0"` : `x1="0" y1="0" x2="1" y2="0"`;
    } else {
        axis = concept.side_v === "bottom" ? `x1="0" y1="1" x2="0" y2="0"` : `x1="0" y1="0" x2="0" y2="1"`;
    }

    const body = stops
        .map(([o, a]) => `<stop offset="${(Math.min(o, 1) * 100).toFixed(1)}%" stop-color="${pal.wash}" stop-opacity="${a}"/>`)
        .join("");

    return `<linearGradient id="copyWash" ${axis}>${body}</linearGradient>`;
}

// Each entry: [scale, benefits shown, kicker shown]. The first one that fits wins:
// drop extras before shrinking text.
const LADDER_DEFAULT = [
    [1, 0, true],
    [1, 0, false],
    [0.92, 0, false],
    [0.84, 0, false],
    [0.76, 0, false],
    [0.66, 0, false],
];

const LADDER_SQUARE = LADDER_DEFAULT;

function buildOverlaySvg(concept, ctx, shape, width, height) {
    const pal = PALETTES[concept.palette] || PALETTES.mist;
    const horizontal = isHorizontal(shape);
    const ladder = shape === "square" ? LADDER_SQUARE : LADDER_DEFAULT;

    const padY = horizontal ? Math.round(height * 0.07) : Math.round(width * 0.065);

    const maxH = horizontal
        ? height - padY * 2
        : Math.round(height * ZONE[shape]) - padY - Math.round(width * 0.02);

    let chosen = null;

    for (const [k, n, kicker] of ladder) {
        chosen = layoutCopy(concept, ctx, shape, width, height, k, n, kicker);
        if (chosen.h <= maxH) break;
    }

    let top;

    if (horizontal) {
        top = concept.copy_valign === "top"
            ? padY
            : concept.copy_valign === "bottom"
                ? height - padY - chosen.h
                : Math.round((height - chosen.h) / 2);
    } else {
        top = concept.side_v === "bottom" ? height - padY - chosen.h : padY;
    }

    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${copyWash(shape, concept, pal)}</defs><rect width="${width}" height="${height}" fill="url(#copyWash)"/><g transform="translate(0 ${top})">${chosen.els.join("")}</g></svg>`
    );
}

/* ---- colour rotation ----
   The server decides which palettes the AI may use, so the home page never ends up one colour. */

const PALETTE_MEMORY = 8;

const paletteOfConcept = (c) =>
    PALETTES[c?.palette] ? c.palette : LEGACY_ACCENT[c?.accent] || null;

const shuffle = (arr) => {
    const a = [...arr];

    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }

    return a;
};

// `recent` is newest-first. Returns the palettes used lately and 5 fresh ones the AI may choose from.
function paletteOffers(recent) {
    const all = Object.keys(PALETTES);
    const used = recent.slice(0, PALETTE_MEMORY).map(paletteOfConcept).filter(Boolean);
    const lastFew = used.slice(0, 3);
    const darkRecent = lastFew.some((k) => PALETTES[k].dark);

    let pool = all.filter((k) => !used.includes(k) && !(darkRecent && PALETTES[k].dark));

    if (pool.length < 3) pool = all.filter((k) => !lastFew.includes(k));
    if (!pool.length) pool = all;

    return { used, offers: shuffle(pool).slice(0, 5) };
}

/* ===== DESIGN SYSTEM END ===== */

/* ------------------------- creative concept (AI) ------------------------- */

const CONCEPT_SYSTEM = `You are a senior creative director and art director for a premium B2B wholesale marketplace.
Design ONE specific, original banner concept for the supplied catalog entity. Every banner in the catalogue must feel like it came from a different campaign: different idea, different set, different colour, different layout. Return valid JSON only:
{
 "label": string,
 "hero_items": string[],
 "palette": string,
 "idea": string,
 "visual_direction": string,
 "camera": string,
 "side_h": "left"|"right",
 "side_v": "top"|"bottom",
 "align_v": "left"|"center",
 "copy_valign": "top"|"center"|"bottom",
 "kicker_style": "rule"|"tag"|"plain",
 "headline_case": "title"|"upper",
}
CONTENT RULES
- label: 1-3 short buyer-friendly words in Title Case (4 words maximum). Use the generic product/category name, never a brand, model, price, size, unit, or claim. Shorter is better because it is typeset large.
- hero_items: 3-4 generic, unbranded, recognizable product forms. Keep the selection coherent: variants for a product range; representative products for a subcategory; representative subcategories for a broad category. The first item is the dominant hero.
CREATIVE RULES
- idea: one sentence naming the visual story, drawn from how these specific products are used, made, or built. It must not be a generic "products on a pedestal".
- visual_direction: 1-2 sentences describing the set, composition, backdrop surface and light. Build a scene specific to these products: architectural framing, a staged vignette made from the products' own materials, a macro hero with receding variants, a diagonal cascade, a modular wall, an overhead flat-lay, colour-blocked geometric panels, layered cut-paper depth, a raw-material slab stage, a curved wall with a pool of light, and so on. Never default to a centered pile or a plain row of items.
- PRODUCT SCALE IS CRITICAL: the products are the star and must be recognisable at a glance, even as a small thumbnail. Compose with FEW, LARGE products and one clearly dominant hero, tight framing, a close camera. Never plan many small items, wide empty floors, or tiny products lost in a big scene.
- camera: a short phrase (angle, lens feel, depth of field). Prefer close, tight framing.
- palette: pick EXACTLY ONE value from "allowed_palettes" (the server already removed colours used recently, so every banner on the home page has a different colour). Choose the one that best suits the products' materials and mood. Palette guide: ${PALETTE_GUIDE}. The look must stay light, sober, professional and premium; slate, teal, plum, forest and burgundy are dark studio looks, so pick one only when it clearly suits the products (premium, technical, electrical, lighting, tools).
LAYOUT RULES (the copy is typeset separately over the image, so layout must vary)
- side_h: which side the copy sits on in wide/landscape banners. side_v: top or bottom of square/portrait banners. align_v: left or center alignment for square/portrait copy. copy_valign: where the copy block sits vertically in wide/landscape banners.
- Choose layout values that differ from the recently used banners supplied to you, and that suit this composition.
- kicker_style, headline_case: pick a combination that is different from the recent banners. Use upper headline_case sparingly, mainly for bold technical or industrial products.
You receive "creative_lens" as a starting point of inspiration; adapt it to the products, or ignore it if it clearly does not suit them. You also receive "recently_used_banners": do not repeat their layout combination or visual approach.`;

const LENSES = [
    "monumental architecture: arches, stepped plinths and deep shadows",
    "overhead technical flat-lay with precise grid spacing and hard shadows",
    "dynamic diagonal cascade, as if the products are mid-motion",
    "a gravity-defying balanced stack on a slim support",
    "macro close-up of one hero product with shallow depth of field and smaller variants behind it",
    "a miniature vignette built from the products' own materials",
    "a radial fan arrangement with a strong focal point",
    "a tight modular wall of variants with one hero pulled forward",
    "a hero product large in front with variants stepping back in a receding line",
    "colour-blocked geometric panels with products placed on the intersections",
    "layered cut-paper depth with products in the middle layer",
    "a curved studio wall with a single pool of light",
    "a low-angle heroic perspective looking up at the products",
    "a raw-material slab stage (stone, timber, steel, concrete) matching the products",
    "products suspended on thin lines at staggered heights",
    "a split-level set with two surfaces at different heights",
];

async function recentConcepts(limit = 12) {
    try {
        const { data } = await supabaseAdmin
            .from("ai_banner_jobs")
            .select("concept")
            .eq("status", "done")
            .not("concept", "is", null)
            .order("finished_at", { ascending: false })
            .limit(limit);

        return (data || []).map((r) => r.concept).filter((c) => c && typeof c === "object");
    } catch {
        return [];
    }
}

const summariseConcept = (c) => ({
    palette: paletteOfConcept(c),
    layout: [c.side_h, c.side_v].filter(Boolean).join("/") || null,
    direction: String(c.visual_direction || "").slice(0, 110),
});

// If the new concept repeats the look of a very recent one, shuffle the layout choices.
function diversify(concept, recent) {
    // const sig = (c) => [paletteOfConcept(c), c.side_h, c.benefit_style, c.cta_style].join("|");
    const sig = (c) => [paletteOfConcept(c), c.side_h].join("|");
    const seen = new Set(recent.slice(0, 5).map(sig));

    for (let i = 0; i < 8 && seen.has(sig(concept)); i++) {
        concept.side_h = randOf(SIDE_H);
    }

    return concept;
}

async function buildConcept(ctx) {
    const recent = await recentConcepts();
    const { used, offers } = paletteOffers(recent);
    let concept;

    try {
        const data = await openai("/chat/completions", {
            model: textModel(),
            response_format: { type: "json_object" },
            ...(/^(o\d|gpt-5)/i.test(textModel()) ? {} : { temperature: 1 }),
            messages: [
                { role: "system", content: CONCEPT_SYSTEM },
                {
                    role: "user",
                    content: JSON.stringify({
                        catalog_entity: ctx.brief,
                        allowed_palettes: offers,
                        recently_used_palettes: used,
                        creative_lens: randOf(LENSES),
                        recently_used_banners: recent.map(summariseConcept),
                        variation_seed: Math.random().toString(36).slice(2, 8),
                    }),
                },
            ],
        }, { timeoutMs: 60_000 });

        concept = normalizeConcept(JSON.parse(data.choices[0].message.content), ctx);
    } catch (e) {
        console.error("[ai-banners] concept failed, using fallback:", e?.message);
        concept = normalizeConcept({}, ctx);
    }

    // The colour is enforced here, whatever the AI answered.
    if (!offers.includes(concept.palette)) concept.palette = randOf(offers);

    return diversify(concept, recent);
}

// When only some sizes are being remade, reuse the concept of the last successful run.
async function priorConcept(job, ctx) {
    try {
        const { data } = await supabaseAdmin
            .from("ai_banner_jobs")
            .select("concept")
            .eq("entity_type", job.entity_type)
            .eq("entity_id", job.entity_id)
            .eq("status", "done")
            .not("concept", "is", null)
            .order("finished_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        const c = data?.concept;

        if (
            c &&
            typeof c.label === "string" &&
            Array.isArray(c.hero_items) &&
            c.hero_items.length >= 2 &&
            (PALETTES[c.palette] || LEGACY_ACCENT[c.accent])
        ) {
            return normalizeConcept(c, ctx, LEGACY_DEFAULTS);
        }
    } catch {
        // Fall back to a fresh concept.
    }

    return null;
}

/* ------------------------- image prompt ------------------------- */

function compositionFor(orientation, concept) {
    if (orientation === "landscape") {
        const edge = "Keep every product at least 8% away from the top and bottom edges and at least 5% away from the left and right edges so nothing is cropped.";

        return concept.side_h === "right"
            ? `Landscape product photograph. Place the hero arrangement in the LEFT 54-57% of the canvas (visual center around 28% of the width) and make it LARGE: it should fill roughly 85% of the canvas height and most of that zone's width. Keep the entire RIGHT 43% visually quiet, smooth and free of objects for a separately typeset headline and copy. The products must stay fully visible and must not intrude into the right copy area. ${edge}`
            : `Landscape product photograph. Place the hero arrangement in the RIGHT 54-57% of the canvas (visual center around 72% of the width) and make it LARGE: it should fill roughly 85% of the canvas height and most of that zone's width. Keep the entire LEFT 43% visually quiet, smooth and free of objects for a separately typeset headline and copy. The products must stay fully visible and must not intrude into the left copy area. ${edge}`;
    }

    if (orientation === "square") {
        return concept.side_v === "bottom"
            ? "Square product photograph. Build the hero arrangement in the UPPER 56% of the frame and make it LARGE and dominant: it should span roughly 85-90% of the canvas width and fill most of that zone's height, so the products read instantly. Keep the lower 44% clean, smooth, low-detail, and completely free of objects for a separately typeset headline and button. Keep products fully visible, away from the left, right and top edges."
            : "Square product photograph. Build the hero arrangement in the LOWER 56% of the frame and make it LARGE and dominant: it should span roughly 85-90% of the canvas width and fill most of that zone's height, so the products read instantly. Keep the upper 44% clean, smooth, low-detail, and completely free of objects for a separately typeset headline and button. Keep products fully visible, away from the left, right and bottom edges.";
    }

    return concept.side_v === "bottom"
        ? "Portrait product photograph. Place the hero arrangement in the UPPER 56% of the frame and make it LARGE and dominant, spanning roughly 85-90% of the canvas width, with clear separation between silhouettes. Keep the lower 44% smooth, low-detail, and free of objects for a separately typeset headline, supporting copy and button. Do not crop the hero products at the edges."
        : "Portrait product photograph. Place the hero arrangement in the LOWER 56% of the frame and make it LARGE and dominant, spanning roughly 85-90% of the canvas width, with clear separation between silhouettes. Keep the upper 44% smooth, low-detail, and free of objects for a separately typeset headline, supporting copy and button. Do not crop the hero products at the edges.";
}

const KIND_PHRASE = {
    group: "a product range",
    subcategory: "a product subcategory",
    category: "a product category",
};

function buildImagePrompt(concept, ctx, orientation) {
    const pal = PALETTES[concept.palette] || PALETTES.mist;

    return `Create a premium, professionally art-directed B2B marketplace campaign photograph for ${KIND_PHRASE[ctx.kind]} "${ctx.name}".

CREATIVE CONCEPT: ${concept.idea || "A product-specific visual story built around how these products are used and made."}

PRODUCT SUBJECTS: ${concept.hero_items.join("; ")}. Show 3-4 recognizable, generic, unbranded product forms appropriate to this catalog entity, with ONE dominant hero product at least 1.5 times larger than the others. Keep them physically plausible, correctly proportioned, beautifully lit, and distinct from one another. Do not introduce unrelated product categories. No visible people, logos, brand marks, packaging copy, labels, letters, numbers, watermarks, typography, interface elements, buttons, badges, icons, or pseudo-text. Absolutely no text anywhere in the generated image: all copy will be typeset separately afterward.

PRODUCT SCALE (very important): the products must be BIG and instantly recognisable, even when this image is viewed as a small thumbnail on a phone. Use tight, close framing; fewer, larger products beat many small ones. The products should fill their allotted zone almost edge to edge, with no wide empty floor, no distant camera, and no tiny products lost in a large scene.

ART DIRECTION: ${concept.visual_direction}. CAMERA: ${concept.camera}. Make this a product-specific campaign, not a stock-photo template. The set may use abstract geometric pieces (plinths, arches, slabs, panels, steps) in materials related to the products. Use believable contact shadows, varied product heights, and a deliberate asymmetrical silhouette. Avoid an identical centered pile, generic floating products, repeated tiles, and an empty generic gradient as the only design idea.

BACKGROUND AND PALETTE: ${pal.bg}; overall backdrop tone close to ${pal.wash}, with restrained tonal depth, subtle material texture, and an understated ${pal.accent} accent used only in abstract set design if it genuinely suits the products. The backdrop behind the copy area must be smooth, calm and low-detail; avoid noisy patterns and high-frequency detail where text will be placed.

COMPOSITION: ${compositionFor(orientation, concept)}

FINISH: premium commercial product photography, crisp focus, realistic materials, refined highlights, soft but defined contact shadows, carefully balanced visual weight, clean silhouettes, sophisticated editorial art direction, no clutter, no blur on the main products, no grain, no cartoon rendering.`;
}

async function generateMaster(prompt, orientation) {
    const size = {
        landscape: "1536x1024",
        square: "1024x1024",
        portrait: "1024x1536",
    }[orientation];

    const data = await openai("/images/generations", {
        model: imageModel(),
        prompt,
        size,
        quality: imageQuality(),
        n: 1,
        output_format: "png",
    });

    const b64 = data?.data?.[0]?.b64_json;

    if (!b64) {
        throw new Error("OpenAI returned no image.");
    }

    return Buffer.from(b64, "base64");
}

/* ------------------------- crop to exact ratios ------------------------- */

const OUT = {
    wide: { from: "landscape", w: 1536, h: 864 },
    landscape: { from: "landscape", w: 1280, h: 960 },
    square: { from: "square", w: 1024, h: 1024 },
    portrait: { from: "portrait", w: 960, h: 1280 },
};

// Crop to the requested ratio, then add sharp vector text and CTA artwork.
async function deriveShapes(masters, shapes, concept, ctx) {
    let sharp;

    try {
        sharp = (await import("sharp")).default;
    } catch {
        throw new Error("The 'sharp' package is not installed on the server (npm i sharp).");
    }

    const files = {};

    for (const shape of shapes) {
        const o = OUT[shape];
        let buf;
        const overlay = buildOverlaySvg(concept, ctx, shape, o.w, o.h);

        for (const q of [90, 84, 78, 72]) {
            buf = await sharp(masters[o.from])
                .resize(o.w, o.h, { fit: "cover", position: "centre" })
                .composite([{ input: overlay, blend: "over" }])
                .webp({ quality: q, effort: 5 })
                .toBuffer();

            if (buf.length <= 1.8 * 1024 * 1024) break;
        }

        files[shape] = { buffer: buf };
    }

    return files;
}

/* ------------------------- save results -------------------------
   Without force, only missing sizes are written.
   With force, the requested sizes are replaced. */

async function persistGroup(job, files, label, shapes) {
    const groupId = job.entity_id;

    const { data: existing } = await supabaseAdmin
        .from("group_banners")
        .select("*")
        .eq("group_id", groupId)
        .maybeSingle();

    const { data: oldExtras } = await supabaseAdmin
        .from("group_banner_images")
        .select("shape, image_path")
        .eq("group_id", groupId);

    const have = new Set(
        existing ? ["wide", ...(oldExtras || []).map((o) => o.shape)] : []
    );

    const toWrite = shapes.filter((s) => job.force || !have.has(s));

    if (!toWrite.length) {
        return { skipped: "Nothing to do: every requested size already exists." };
    }

    const up = await validateAndUpload(
        Object.fromEntries(toWrite.map((s) => [s, files[s]])),
        groupId
    );

    if (!up.ok) throw new Error(up.message);

    const wide = up.uploaded.find((u) => u.shape === "wide");
    const others = up.uploaded.filter((u) => u.shape !== "wide");
    const nowIso = new Date().toISOString();

    if (wide || !existing) {
        let sortOrder = existing?.sort_order;

        if (sortOrder == null) {
            const { data: last } = await supabaseAdmin
                .from("group_banners")
                .select("sort_order")
                .order("sort_order", { ascending: false })
                .limit(1)
                .maybeSingle();

            sortOrder = (last?.sort_order ?? 0) + 1;
        }

        const { error } = await supabaseAdmin
            .from("group_banners")
            .upsert({
                group_id: groupId,
                image_url: wide.url,
                image_path: wide.path,
                alt_text: existing?.alt_text ?? label,
                is_active: existing ? existing.is_active : !!job.publish,
                sort_order: sortOrder,
                ai_generated: true,
                updated_at: nowIso,
                updated_by: null,
            }, { onConflict: "group_id" });

        if (error) {
            await removeObjects(up.uploaded.map((u) => u.path));

            throw new Error(
                error.code === "23503"
                    ? "Group is not in the registry yet."
                    : error.message
            );
        }
    }

    if (others.length) {
        const { error: imgErr } = await supabaseAdmin
            .from("group_banner_images")
            .upsert(
                others.map((o) => ({
                    group_id: groupId,
                    shape: o.shape,
                    image_url: o.url,
                    image_path: o.path,
                    width: o.width,
                    height: o.height,
                    updated_at: nowIso,
                    updated_by: null,
                })),
                { onConflict: "group_id,shape" }
            );

        if (imgErr) {
            await removeObjects(up.uploaded.map((u) => u.path));
            throw new Error(imgErr.message);
        }
    }

    const stale = (oldExtras || [])
        .filter((o) => others.some((n) => n.shape === o.shape))
        .map((o) => o.image_path);

    if (wide && existing?.image_path) stale.push(existing.image_path);

    await removeObjects(stale);

    broadcastBannersChanged();

    return {};
}

async function persistEntity(job, files, label, shapes) {
    const { entity_type: type, entity_id: id } = job;

    const { data: existing } = await supabaseAdmin
        .from("catalog_entity_banners")
        .select("shape, image_path, is_active, ai_generated")
        .eq("entity_type", type)
        .eq("entity_id", id);

    const have = new Set((existing || []).map((r) => r.shape));
    const toWrite = shapes.filter((s) => job.force || !have.has(s));

    if (!toWrite.length) {
        return { skipped: "Nothing to do: every requested size already exists." };
    }

    const up = await validateAndUpload(
        Object.fromEntries(toWrite.map((s) => [s, files[s]])),
        `${type}/${id}`
    );

    if (!up.ok) throw new Error(up.message);

    const nowIso = new Date().toISOString();
    const active = existing?.length ? existing[0].is_active : !!job.publish;

    const { error } = await supabaseAdmin
        .from("catalog_entity_banners")
        .upsert(
            up.uploaded.map((u) => ({
                entity_type: type,
                entity_id: id,
                shape: u.shape,
                image_url: u.url,
                image_path: u.path,
                alt_text: label,
                is_active: active,
                ai_generated: true,
                width: u.width,
                height: u.height,
                updated_at: nowIso,
                updated_by: null,
            })),
            { onConflict: "entity_type,entity_id,shape" }
        );

    if (error) {
        await removeObjects(up.uploaded.map((u) => u.path));
        throw new Error(error.message);
    }

    await removeObjects(
        (existing || [])
            .filter((r) => toWrite.includes(r.shape))
            .map((r) => r.image_path)
    );

    return {};
}

/* ------------------------- queue worker ------------------------- */

async function runJob(job) {
    const finish = (patch) =>
        supabaseAdmin
            .from("ai_banner_jobs")
            .update({ finished_at: new Date().toISOString(), ...patch })
            .eq("id", job.id);

    try {
        const ctx = await buildContext(job.entity_type, job.entity_id);

        if (!ctx) {
            return void (await finish({
                status: "failed",
                error: "Couldn't find this item in the catalog.",
            }));
        }

        await supabaseAdmin
            .from("ai_banner_jobs")
            .update({ entity_name: ctx.name })
            .eq("id", job.id);

        let shapes = Array.isArray(job.shapes) && job.shapes.length
            ? SHAPE_KEYS.filter((s) => job.shapes.includes(s))
            : [...SHAPE_KEYS];

        if (!shapes.length) shapes = [...SHAPE_KEYS];

        // A group needs its 16:9 base image if it doesn't have one.
        if (job.entity_type === "group" && !shapes.includes("wide")) {
            const { data: gb } = await supabaseAdmin
                .from("group_banners")
                .select("group_id")
                .eq("group_id", job.entity_id)
                .maybeSingle();

            if (!gb) shapes.unshift("wide");
        }

        const partial = shapes.length < SHAPE_KEYS.length;
        const concept = (partial && await priorConcept(job, ctx)) || await buildConcept(ctx);

        const orientations = [...new Set(shapes.map((s) => OUT[s].from))];
        const masters = {};

        for (const orientation of orientations) {
            masters[orientation] = await generateMaster(
                buildImagePrompt(concept, ctx, orientation),
                orientation
            );
        }

        const files = await deriveShapes(masters, shapes, concept, ctx);

        const res = job.entity_type === "group"
            ? await persistGroup(job, files, concept.label, shapes)
            : await persistEntity(job, files, concept.label, shapes);

        await finish({
            status: "done",
            concept,
            note: res.skipped || null,
            error: null,
        });
    } catch (e) {
        console.error("[ai-banners] job failed:", job.id, e?.message);

        await finish({
            status: "failed",
            error: String(e?.message || e).slice(0, 300),
        });
    }
}

async function recoverStale() {
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();

    await supabaseAdmin
        .from("ai_banner_jobs")
        .update({
            status: "failed",
            error: "Stopped unexpectedly too many times.",
            finished_at: new Date().toISOString(),
        })
        .eq("status", "running")
        .lt("started_at", cutoff)
        .gte("attempts", MAX_ATTEMPTS);

    await supabaseAdmin
        .from("ai_banner_jobs")
        .update({ status: "queued" })
        .eq("status", "running")
        .lt("started_at", cutoff);
}

async function claimNext() {
    const { data: next } = await supabaseAdmin
        .from("ai_banner_jobs")
        .select("id, attempts")
        .eq("status", "queued")
        .order("created_at")
        .limit(1)
        .maybeSingle();

    if (!next) return null;

    const { data: claimed } = await supabaseAdmin
        .from("ai_banner_jobs")
        .update({
            status: "running",
            started_at: new Date().toISOString(),
            attempts: (next.attempts || 0) + 1,
            error: null,
        })
        .eq("id", next.id)
        .eq("status", "queued")
        .select()
        .maybeSingle();

    return claimed || null;
}

let started = false;
let active = 0;
let ticking = false;

export function startAiBannerWorker() {
    if (started) return;

    started = true;

    const tick = async () => {
        if (ticking || !aiConfigured()) return;

        ticking = true;

        try {
            await recoverStale();

            while (active < concurrency()) {
                const job = await claimNext();

                if (!job) break;

                active++;

                runJob(job).finally(() => {
                    active--;
                });
            }
        } catch (e) {
            console.error("[ai-banners] worker tick failed:", e?.message);
        } finally {
            ticking = false;
        }
    };

    setInterval(tick, 5000).unref?.();
    setTimeout(tick, 15_000).unref?.();
}