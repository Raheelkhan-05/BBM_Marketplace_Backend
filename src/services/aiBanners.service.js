// services/aiBanners.service.js — AI banner generation: coverage detection, context, prompts, OpenAI calls, queue worker.
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
const ACCENT = { orange: "#F4511E", blue: "#1E78D6", green: "#22A06B" };
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

const CONCEPT_SYSTEM = `You are a senior creative director for a premium B2B wholesale marketplace.
Create ONE specific, visually distinctive banner concept for the supplied catalog entity. Return valid JSON only:
{"label": string, "hero_items": string[], "benefits": string[], "accent": "orange"|"blue"|"green", "visual_direction": string}
Rules:
- label: 1-4 short buyer-friendly words in Title Case. Use the generic product/category name, never a brand, model, price, size, unit, or claim.
- hero_items: 3-5 generic, unbranded, recognizable product forms. Keep the selection coherent: variants for a product range; representative products for a subcategory; representative subcategories for a broad category.
- benefits: exactly 2 short, useful benefit OR application labels when the catalog context supports them. Each should be 2-4 words, ideally <=24 characters. Use grounded, ordinary use-cases; never invent certifications, guarantees, prices, delivery promises, performance figures, or technical claims. Use [] rather than guess if unsupported.
- visual_direction: one specific art-direction sentence that names a distinct composition approach and background/light treatment. Select an approach that fits these products (for example: sculptural pedestal arrangement, precise stepped plinths, diagonal motion, overhead technical flat-lay, architectural framing, offset modular blocks, or elegant material contrast). Avoid the same centered pile, generic gradient, or row-of-products look by default. No text in the artwork.
- accent: choose orange, blue, or green to suit the products; avoid choosing blue by default.`;

async function buildConcept(ctx) {
    const fallback = {
        label: ctx.name.split(/\s+/).slice(0, 4).join(" "),
        hero_items: (
            ctx.brief.generic_products_covered ||
            ctx.brief.sample_generic_products ||
            [ctx.name]
        ).slice(0, 4),
        benefits: [],
        accent: "blue",
        visual_direction: "Offset sculptural product arrangement on a pale mineral backdrop, with crisp directional studio light and generous negative space",
    };

    try {
        const data = await openai("/chat/completions", {
            model: textModel(),
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: CONCEPT_SYSTEM },
                { role: "user", content: JSON.stringify(ctx.brief) },
            ],
        }, { timeoutMs: 60_000 });

        const raw = JSON.parse(data.choices[0].message.content);

        let label = String(raw.label || "")
            .replace(/["“”]/g, "")
            .replace(/\s+/g, " ")
            .trim();

        if (!label || label.length > 40 || label.split(" ").length > 4) {
            label = fallback.label;
        }

        const low = label.toLowerCase();

        if (ctx.brands.some((b) =>
            b.length >= 3 &&
            new RegExp(
                `\\b${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
            ).test(low)
        )) {
            label = fallback.label;
        }

        const hero = (Array.isArray(raw.hero_items) ? raw.hero_items : [])
            .map((v) => String(v).replace(/[\r\n]/g, " ").trim().slice(0, 60))
            .filter(Boolean)
            .slice(0, 5);

        const benefits = (Array.isArray(raw.benefits) ? raw.benefits : [])
            .map((v) => String(v)
                .replace(/[\r\n]/g, " ")
                .replace(/[.!]+$/g, "")
                .trim()
                .slice(0, 28)
            )
            .filter(Boolean)
            .slice(0, 2);

        const visualDirection = String(raw.visual_direction || fallback.visual_direction)
            .replace(/[\r\n]/g, " ")
            .trim()
            .slice(0, 220) || fallback.visual_direction;

        return {
            label,
            hero_items: hero.length >= 2 ? hero : fallback.hero_items,
            benefits,
            accent: ACCENT[raw.accent] ? raw.accent : fallback.accent,
            visual_direction: visualDirection,
        };
    } catch (e) {
        console.error("[ai-banners] concept failed, using fallback:", e?.message);
        return fallback;
    }
}

// When only some sizes are being remade, reuse the concept of the last successful run.
async function priorConcept(job) {
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
            ACCENT[c.accent]
        ) {
            return {
                ...c,
                benefits: Array.isArray(c.benefits) ? c.benefits.slice(0, 2) : [],
                visual_direction: c.visual_direction ||
                    "Offset sculptural product arrangement on a pale mineral backdrop, with crisp directional studio light and generous negative space",
            };
        }
    } catch {
        // Fall back to a fresh concept.
    }

    return null;
}

const COMPOSITION = {
    landscape: "Landscape product photograph. Place the coherent hero arrangement in the right 54-60% of the canvas, with the visual center around 72% of the width. Keep the entire left 44-46% visually quiet and free of objects for a separately typeset headline and copy. The products must remain fully visible and must not intrude into the left copy area.",

    square: "Square product photograph. Build an intentional, dimensional arrangement only in the lower 48-50% of the frame. Keep the upper 48-50% clean, light, low-detail, and completely free of objects for a separately typeset headline and supporting copy. Avoid a centered pile; use a confident silhouette and deliberate negative space.",

    portrait: "Portrait product photograph. Place the product arrangement in the lower 52-58% of the frame, with clear separation between silhouettes. Keep the upper 38-42% light, low-detail, and free of objects for a separately typeset headline and supporting copy. Do not crop the hero products at the edges.",
};

const KIND_PHRASE = {
    group: "a product range",
    subcategory: "a product subcategory",
    category: "a product category",
};

function buildImagePrompt(concept, ctx, orientation) {
    const accent = ACCENT[concept.accent] || ACCENT.blue;

    return `Create a premium, professionally art-directed B2B marketplace campaign photograph for ${KIND_PHRASE[ctx.kind]} "${ctx.name}".

PRODUCT SUBJECTS: ${concept.hero_items.join("; ")}. Show 3-5 recognizable, generic, unbranded product forms appropriate to this catalog entity. Keep them physically plausible, correctly proportioned, beautifully lit, and distinct from one another. Do not introduce unrelated props or extra product categories. No visible people, logos, brand marks, packaging copy, labels, letters, numbers, watermarks, typography, interface elements, buttons, badges, icons, or pseudo-text. Absolutely no text anywhere in the generated image: all copy will be typeset separately afterward.

ART DIRECTION: ${concept.visual_direction || "A distinctive sculptural product arrangement with deliberate negative space and crisp studio lighting"}. Make this a product-specific campaign art direction, not a stock-photo template. Use a deliberate asymmetrical silhouette, believable contact shadows, varied product heights, and a controlled camera angle. Avoid an identical centered pile, generic floating products, repeated tiles, and an empty generic gradient as the only design idea.

BACKGROUND AND PALETTE: mostly light warm-white / pale mineral neutral, with restrained tonal depth, subtle material texture, and an understated ${accent} accent used only in abstract set design if it genuinely suits the products. Preserve clear negative space for copy. Avoid noisy patterns and high-frequency detail behind where text will be placed.

COMPOSITION: ${COMPOSITION[orientation]}

FINISH: premium commercial product photography, crisp focus, realistic materials, refined highlights, soft but defined contact shadows, carefully balanced visual weight, clean silhouettes, sophisticated editorial art direction, no clutter, no blur, no grain, no cartoon rendering.`;
}

const BENEFIT_INK = "#263D46";
const HEADLINE_INK = "#10272F";
const SUPPORT_INK = "#263D46";

const copyEscape = (v) =>
    String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

function estimatedWidth(text, fontSize) {
    // Conservative width estimate to prevent text from spilling into the image area.
    let units = 0;

    for (const ch of String(text)) {
        units += /[ilI.,'!|]/.test(ch) ? 0.33
            : /[MW@%&]/.test(ch) ? 0.98
                : /[A-Z0-9]/.test(ch) ? 0.76
                    : ch === " " ? 0.37
                        : 0.68;
    }

    return units * fontSize;
}

function wrapText(text, maxWidth, fontSize) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";

    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;

        if (!line || estimatedWidth(candidate, fontSize) <= maxWidth) {
            line = candidate;
        } else {
            lines.push(line);
            line = word;
        }
    }

    if (line) lines.push(line);

    return lines.length ? lines : [""];
}

function fitHeadline(label, maxWidth, baseSize, maxLines = 3) {
    let fontSize = baseSize;
    let lines = wrapText(label, maxWidth, fontSize);

    const doesNotFit = () =>
        lines.length > maxLines ||
        lines.some((line) => estimatedWidth(line, fontSize) > maxWidth);

    while (doesNotFit() && fontSize > 36) {
        fontSize -= 2;
        lines = wrapText(label, maxWidth, fontSize);
    }

    return { fontSize, lines };
}

function copyWash(shape) {
    if (shape === "wide" || shape === "landscape") {
        return `<linearGradient id="copyWash" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.99"/><stop offset="34%" stop-color="#FFFFFF" stop-opacity="0.98"/><stop offset="45%" stop-color="#FFFFFF" stop-opacity="0.94"/><stop offset="54%" stop-color="#FFFFFF" stop-opacity="0.72"/><stop offset="63%" stop-color="#FFFFFF" stop-opacity="0.18"/><stop offset="70%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`;
    }

    return `<linearGradient id="copyWash" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.99"/><stop offset="29%" stop-color="#FFFFFF" stop-opacity="0.98"/><stop offset="39%" stop-color="#FFFFFF" stop-opacity="0.94"/><stop offset="48%" stop-color="#FFFFFF" stop-opacity="0.74"/><stop offset="58%" stop-color="#FFFFFF" stop-opacity="0.16"/><stop offset="66%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`;
}

function buildOverlaySvg(concept, ctx, shape, width, height) {
    const accent = ACCENT[concept.accent] || ACCENT.blue;

    const benefits = (Array.isArray(concept.benefits) ? concept.benefits : [])
        .map((v) => String(v).trim())
        .filter(Boolean)
        .slice(0, 2);

    const isGroup = ctx.kind === "group";
    const isHorizontal = shape === "wide" || shape === "landscape";

    const marginX = Math.round(width * (isHorizontal ? 0.06 : 0.065));

    const textWidth = isHorizontal
        ? Math.round(width * (shape === "wide" ? 0.43 : 0.425))
        : width - marginX * 2;

    const kicker = ctx.kind === "group"
        ? "PRODUCT RANGE"
        : ctx.kind === "subcategory"
            ? "PRODUCT SUBCATEGORY"
            : "PRODUCT CATEGORY";

    const kickerSize = isHorizontal
        ? (shape === "wide" ? 20 : 18)
        : 19;

    const titleBaseSize = isHorizontal
        ? (shape === "wide" ? 78 : 66)
        : (shape === "square" ? 69 : 64);

    const title = fitHeadline(concept.label, textWidth, titleBaseSize, 3);
    const titleLineHeight = Math.round(title.fontSize * 1.04);

    const benefitSize = isHorizontal
        ? (shape === "wide" ? 28 : 26)
        : 26;

    const benefitRowHeight = isHorizontal ? 43 : 41;
    const buttonHeight = isHorizontal ? 60 : 58;

    const buttonWidth = shape === "wide"
        ? 252
        : shape === "landscape"
            ? 232
            : shape === "portrait"
                ? 248
                : 240;

    const topKickerH = 25;
    const titleGap = 15;
    const afterTitleGap = isHorizontal ? 27 : 24;
    const afterBenefitsGap = isGroup ? 22 : 0;

    const benefitRows = (!isHorizontal && benefits.length === 2)
        ? 1
        : benefits.length;

    const contentHeight =
        topKickerH +
        titleGap +
        title.lines.length * titleLineHeight +
        afterTitleGap +
        benefitRows * benefitRowHeight +
        (isGroup ? afterBenefitsGap + buttonHeight : 0);

    const top = isHorizontal
        ? Math.max(
            Math.round((height - contentHeight) / 2) - 2,
            Math.round(height * 0.08)
        )
        : marginX;

    const elements = [];

    elements.push(
        `<line x1="${marginX}" y1="${top + 4}" x2="${marginX + 36}" y2="${top + 4}" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>`
    );

    elements.push(
        `<text x="${marginX + 49}" y="${top + 10 + kickerSize * 0.55}" fill="${SUPPORT_INK}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${kickerSize}" font-weight="700" letter-spacing="1.1">${copyEscape(kicker)}</text>`
    );

    let cursorY = top + topKickerH + titleGap + title.fontSize * 0.86;

    title.lines.forEach((line, idx) => {
        elements.push(
            `<text x="${marginX}" y="${Math.round(cursorY + idx * titleLineHeight)}" fill="${HEADLINE_INK}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${title.fontSize}" font-weight="700" letter-spacing="-1.15">${copyEscape(line)}</text>`
        );
    });

    cursorY =
        cursorY +
        (title.lines.length - 1) * titleLineHeight +
        title.fontSize * 0.35 +
        afterTitleGap;

    if (!isHorizontal && benefits.length === 2) {
        const columnWidth = textWidth / 2;

        benefits.forEach((benefit, idx) => {
            const cellX = marginX + idx * columnWidth;
            const allowed = columnWidth - 32;

            let fs = benefitSize;

            while (fs > 20 && estimatedWidth(benefit, fs) > allowed) {
                fs -= 1;
            }

            const y = Math.round(cursorY + fs * 0.82);

            elements.push(
                `<circle cx="${cellX + 7}" cy="${y - fs * 0.33}" r="5.5" fill="${accent}"/>`
            );

            elements.push(
                `<text x="${cellX + 25}" y="${y}" fill="${BENEFIT_INK}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fs}" font-weight="600">${copyEscape(benefit)}</text>`
            );
        });

        cursorY += benefitRowHeight;
    } else {
        benefits.forEach((benefit) => {
            const allowed = textWidth - 30;
            let fs = benefitSize;

            while (fs > 21 && estimatedWidth(benefit, fs) > allowed) {
                fs -= 1;
            }

            const y = Math.round(cursorY + fs * 0.82);

            elements.push(
                `<circle cx="${marginX + 7}" cy="${y - fs * 0.33}" r="5.5" fill="${accent}"/>`
            );

            elements.push(
                `<text x="${marginX + 25}" y="${y}" fill="${BENEFIT_INK}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fs}" font-weight="600">${copyEscape(benefit)}</text>`
            );

            cursorY += benefitRowHeight;
        });
    }

    if (isGroup) {
        const buttonX = marginX;
        const buttonY = Math.round(cursorY + afterBenefitsGap - 5);

        // Render the CTA as vector artwork instead of relying on AI-generated lettering.
        elements.push(
            `<rect x="${buttonX}" y="${buttonY + 4}" width="${buttonWidth}" height="${buttonHeight}" rx="17" fill="#10272F" opacity="0.14"/>`
        );

        elements.push(
            `<rect x="${buttonX}" y="${buttonY}" width="${buttonWidth}" height="${buttonHeight}" rx="17" fill="${accent}"/>`
        );

        elements.push(
            `<rect x="${buttonX + 1.5}" y="${buttonY + 1.5}" width="${buttonWidth - 3}" height="${buttonHeight - 3}" rx="15.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.28" stroke-width="1.5"/>`
        );

        elements.push(
            `<text x="${buttonX + 23}" y="${buttonY + 37}" fill="#FFFFFF" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="700">Explore range</text>`
        );

        elements.push(
            `<path d="M ${buttonX + buttonWidth - 42} ${buttonY + 23} l 7 7 -7 7 M ${buttonX + buttonWidth - 35} ${buttonY + 30} h -15" fill="none" stroke="#FFFFFF" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>`
        );
    }

    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${copyWash(shape)}</defs><rect width="${width}" height="${height}" fill="url(#copyWash)"/>${elements.join("")}</svg>`
    );
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
        const concept = (partial && await priorConcept(job)) || await buildConcept(ctx);

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