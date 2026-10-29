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

/* ───────────────────────── coverage detection ─────────────────────────
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
        if (rec && isShape(r.shape) && r.image_url) rec.images[r.shape] = r.image_url;
    }

    const entityRec = new Map();

    for (const r of eb.data || []) {
        const key = `${r.entity_type}:${r.entity_id}`;

        if (!entityRec.has(key)) {
            entityRec.set(key, { images: {}, ai: true, active: false });
        }

        const rec = entityRec.get(key);

        if (isShape(r.shape) && r.image_url) rec.images[r.shape] = r.image_url;

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

    const openSet = new Set((open || []).map((j) => `${j.entity_type}:${j.entity_id}`));

    const rows = items
        .filter((i) => !openSet.has(`${i.type}:${i.id}`))
        .map((i) => ({
            entity_type: i.type,
            entity_id: i.id,
            entity_name: i.name || null,
            shapes: Array.isArray(i.shapes) && i.shapes.length ? i.shapes.filter(isShape) : null,
            publish: !!publish,
            force: !!i.force,
            created_by: userId ? String(userId) : null,
        }));

    if (!rows.length) return { queued: 0 };

    const { error } = await supabaseAdmin.from("ai_banner_jobs").insert(rows);

    if (!error) return { queued: rows.length };

    // A race on the "one open job per entity" index: fall back to one by one.
    let queued = 0;

    for (const r of rows) {
        const { error: e } = await supabaseAdmin.from("ai_banner_jobs").insert(r);
        if (!e) queued++;
    }

    return { queued };
}

/* ───────────────────────── catalog context ───────────────────────── */

const uniq = (arr) => [
    ...new Set(arr.map((s) => String(s || "").trim()).filter(Boolean)),
];

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

/* ───────────────────────── OpenAI ───────────────────────── */

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

            await sleep(
                Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000 * attempt
            );

            continue;
        }

        let msg = text;

        try {
            msg = JSON.parse(text)?.error?.message || text;
        } catch {
            // Keep raw response text.
        }

        throw new Error(`OpenAI ${res.status}: ${String(msg).slice(0, 250)}`);
    }
}

const CONCEPT_SYSTEM = `You are a senior marketplace creative director for a B2B wholesale marketplace.
Create ONE distinctive, practical banner concept for the supplied catalog entity. Reply with valid JSON only:
{"label": string, "hero_items": string[], "benefits": string[], "accent": "orange"|"blue"|"green", "visual_direction": string}
Rules:
- label: a generic buyer-friendly heading, 1-4 words, Title Case. Never use a brand, model number, size, unit, price, or overly specific listing title.
- hero_items: 3-5 generic, unbranded product types that are visually distinct and immediately recognizable.
  For a product range, show different common types/variants of that product; for a subcategory, represent several main products; for a category, represent its main subcategories.
- benefits: 2-3 very short, factual, broadly applicable buyer benefits or use cases grounded in the supplied catalog context. Use compact phrases (2-5 words each); do not invent certifications, guarantees, prices, delivery promises, or technical claims. If the context does not support benefits, return an empty array.
- visual_direction: one short, specific art-direction phrase. Vary the composition, camera angle, product grouping, and background treatment between concepts while staying premium and uncluttered. Do not suggest text inside the image beyond the heading and approved CTA.
- accent: pick orange, blue, or green based on the products. Avoid defaulting to the same accent every time.`;

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
        visual_direction: "editorial studio product still life with layered depth",
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

        if (!label || label.length > 40 || label.split(" ").length > 5) {
            label = fallback.label;
        }

        const low = label.toLowerCase();

        if (
            ctx.brands.some((b) =>
                b.length >= 3 &&
                new RegExp(
                    `\\b${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
                ).test(low)
            )
        ) {
            label = fallback.label;
        }

        const hero = (Array.isArray(raw.hero_items) ? raw.hero_items : [])
            .map((s) => String(s).trim().slice(0, 60))
            .filter(Boolean)
            .slice(0, 5);

        const benefits = (Array.isArray(raw.benefits) ? raw.benefits : [])
            .map((v) => String(v).replace(/[\r\n]/g, " ").trim().slice(0, 36))
            .filter(Boolean)
            .slice(0, 3);

        const visualDirection = String(
            raw.visual_direction || fallback.visual_direction
        ).replace(/[\r\n]/g, " ").trim().slice(0, 160) || fallback.visual_direction;

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

// When only some sizes are being (re)made, reuse the concept of the last successful run.
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
                benefits: Array.isArray(c.benefits) ? c.benefits : [],
                visual_direction: c.visual_direction ||
                    "editorial studio product still life with layered depth",
            };
        }
    } catch {
        // Fall back to a fresh concept.
    }

    return null;
}

const COMPOSITION = {
    landscape: "Landscape master canvas. Use an asymmetrical editorial layout: headline and concise supporting details in a clearly reserved text area on the left; realistic product still life on the right. Keep generous safe margins and strong visual hierarchy.",
    square: "Square canvas. Use a balanced, premium catalog-cover layout with headline near the top, a compact row of supporting benefit labels beneath it, and a bold product arrangement below. Keep all elements comfortably inside the safe area.",
    portrait: "Portrait master canvas. Use a vertical editorial layout: headline at the top, benefits as a tidy short list beneath it, and a large, carefully arranged product still life in the lower portion. Avoid stacking products into a cluttered pile.",
};

const KIND_PHRASE = {
    group: "a product range",
    subcategory: "a product subcategory",
    category: "a product category",
};

function buildImagePrompt(concept, ctx, orientation) {
    const accent = ACCENT[concept.accent] || ACCENT.blue;
    const isGroup = ctx.kind === "group";

    const cta = isGroup
        ? `Include one small, polished pill-shaped CTA below the headline, reading exactly "Explore range". Use a solid ${accent} fill, white text, clear contrast, even padding, and a clean geometric sans-serif. It must look like a designed UI button, not a floating label, outlined capsule, or oversized badge.`
        : "Do not include a CTA button.";

    const benefits = (concept.benefits || []).slice(0, 3);

    const benefitText = benefits.length
        ? `Include these exact short benefit/use-case phrases as a neat, legible supporting list: ${benefits.map((b) => `"${b}"`).join(", ")}. Render them as 2–3 evenly spaced text labels or a compact list with small simple bullets/icons. Keep them secondary to the headline; do not let them overlap the products or CTA.`
        : "Do not invent benefits, claims, or supporting copy; use only the headline and CTA (if specified).";

    return `Create a premium, high-converting e-commerce banner for a B2B wholesale marketplace. It should feel like a professionally art-directed campaign, not a generic template, and remain readable as a small phone thumbnail.

WHAT IT REPRESENTS: ${KIND_PHRASE[ctx.kind]} called "${concept.label}".

HERO VISUALS: ${concept.hero_items.join("; ")}. Show 3–5 distinct, realistic, unbranded products in premium studio product-photography style. Arrange them as a deliberate still life with believable scale, natural depth, subtle contact shadows, and clear separation between silhouettes. No logos, brand marks, packaging text, or made-up product labels.

ART DIRECTION: ${concept.visual_direction || "premium editorial product still life"}. Make the layout specific to this product family: vary product arrangement, camera angle, negative space, background geometry, and light direction. Avoid repeating the same centered pile of products or the same generic gradient composition across banners. Keep it elegant and uncluttered.

BRAND STYLE: clean, modern, trustworthy. Use a mostly white / very pale cool-neutral background with restrained ice-blue (#EDF3F5) and a subtle warm accent glow only where it helps the composition. Text ink #08222B, secondary text #52686F, accent ${accent}. Use accent colour sparingly for a short rule, small icons, or the CTA. Strong contrast and ample whitespace.

TEXT HIERARCHY: The headline "${concept.label}" must be spelled exactly, large, bold, and highly legible in a modern geometric sans-serif. ${benefitText} ${cta} No other words, numbers, prices, logos, watermarks, or fine print. Render all specified text cleanly and correctly; do not add decorative pseudo-text.

COMPOSITION: ${COMPOSITION[orientation]}
SAFE ZONE: keep all text, CTA, benefits, and important product details inside the central 80% of the frame so the artwork can be cropped to 16:9, 4:3, 1:1, and 3:4. Maintain clear separation between headline, benefits, products, and CTA.

QUALITY: crisp commercial product photography, clean edges, realistic materials, soft intentional shadows, no blur, no noise, no grain, no cartoon look, no clutter, no people.`;
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
    if (!b64) throw new Error("OpenAI returned no image.");

    return Buffer.from(b64, "base64");
}

/* ───────────────────────── crop to exact ratios ───────────────────────── */

const OUT = {
    wide: { from: "landscape", w: 1536, h: 864 },      // 16:9
    landscape: { from: "landscape", w: 1280, h: 960 }, // 4:3
    square: { from: "square", w: 1024, h: 1024 },      // 1:1
    portrait: { from: "portrait", w: 960, h: 1280 },    // 3:4
};

// Only derives the requested shapes (their masters must already exist).
async function deriveShapes(masters, shapes) {
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

        for (const q of [90, 82, 74, 66]) {
            buf = await sharp(masters[o.from])
                .resize(o.w, o.h, { fit: "cover", position: "centre" })
                .webp({ quality: q })
                .toBuffer();

            if (buf.length <= 1.8 * 1024 * 1024) break;
        }

        files[shape] = { buffer: buf };
    }

    return files;
}

/* ───────────────────────── save results ─────────────────────────
   Without force, only sizes that don't exist yet are written.
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

    // Remove only the files that were just replaced.
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

/* ───────────────────────── queue worker ───────────────────────── */

async function runJob(job) {
    const finish = (patch) =>
        supabaseAdmin
            .from("ai_banner_jobs")
            .update({
                finished_at: new Date().toISOString(),
                ...patch,
            })
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

        let shapes =
            Array.isArray(job.shapes) && job.shapes.length
                ? SHAPE_KEYS.filter((s) => job.shapes.includes(s))
                : [...SHAPE_KEYS];

        if (!shapes.length) shapes = [...SHAPE_KEYS];

        // A group can't hold extra sizes without its 16:9 base image.
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
            // Generate one at a time to be gentle on rate limits.
            masters[orientation] = await generateMaster(
                buildImagePrompt(concept, ctx, orientation),
                orientation
            );
        }

        const files = await deriveShapes(masters, shapes);

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