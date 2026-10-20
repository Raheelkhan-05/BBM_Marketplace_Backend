// src/routes/seo.routes.js  (REPLACES the existing file; already mounted at /api/seo in app.js)
// Keeps your existing GET /api/seo/sitemap (used by the Vercel /sitemap.xml rewrite).
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin } from "../config/supabase.js";
import { requireSeoAdmin } from "../middleware/seoAuth.middleware.js";
import { seoRequestLogger } from "../middleware/seoRequestLogger.middleware.js";
import {
    SITE, normalizeSlug, getSeo, listSeo, upsertSeo, getSsrMeta,
    getSitemap, requestIndexing, logChange, FIELDS,
} from "../services/seo.service.js";

const router = Router();
router.use(seoRequestLogger);

const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests. Max 60/min." },
});

const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
        console.error("[seo]", e);
        res.status(e.status || 500).json({
            success: false,
            message: e.status ? e.message : "Something went wrong.",
            request_id: req.seoRequestId,
        });
    });

/* ───── public reads ───── */
router.get("/", wrap(async (req, res) => {
    if (!req.query.slug) return res.status(400).json({ success: false, message: "slug is required" });
    res.json(await getSeo(normalizeSlug(req.query.slug)));
}));

router.get("/all", wrap(async (req, res) => {
    res.json(await listSeo({ limit: req.query.limit, offset: req.query.offset }));
}));

router.get("/ssr-meta", wrap(async (req, res) => {
    if (!req.query.path) return res.status(400).json({ success: false, message: "path is required" });
    res.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.json(await getSsrMeta(normalizeSlug(req.query.path)));
}));

// /sitemap = your existing path (Vercel rewrite target); /sitemap.xml = same thing
const sendSitemap = wrap(async (req, res) => {
    const { xml } = await getSitemap();
    res.set("Cache-Control", "public, max-age=3600");
    res.type("application/xml").send(xml);
});
router.get("/sitemap", sendSitemap);
router.get("/sitemap.xml", sendSitemap);

/* ───── admin writes ───── */
router.put("/", requireSeoAdmin, writeLimiter, wrap(async (req, res) => {
    const rawSlug = req.body?.slug || req.query.slug;
    if (!rawSlug) return res.status(400).json({ success: false, message: "slug is required" });
    const slug = normalizeSlug(rawSlug);

    const input = Object.fromEntries(FIELDS.filter((f) => req.body?.[f] !== undefined).map((f) => [f, req.body[f]]));
    const out = await upsertSeo(slug, input, { actor: req.seoActor, requestId: req.seoRequestId });
    if (out.errors) return res.status(422).json({ success: false, errors: out.errors, request_id: req.seoRequestId });
    res.json({ success: true, changed: out.changed, created: !!out.created, request_id: req.seoRequestId, data: out.data });
}));

router.post("/sitemap/regenerate", requireSeoAdmin, writeLimiter, wrap(async (req, res) => {
    const { stats } = await getSitemap({ force: true });
    await logChange({
        requestId: req.seoRequestId, entityType: "sitemap", entityKey: "sitemap.xml",
        action: "regenerate", actor: req.seoActor, result: stats,
    });
    res.json({ success: true, ...stats, sitemap_url: `${SITE}/sitemap.xml`, request_id: req.seoRequestId });
}));

router.post("/request-indexing", requireSeoAdmin, writeLimiter, wrap(async (req, res) => {
    const urls = Array.isArray(req.body?.urls) ? [...new Set(req.body.urls.map(String))] : [];
    if (!urls.length || urls.length > 100) {
        return res.status(400).json({ success: false, message: "urls must have 1-100 items" });
    }
    const results = await requestIndexing(urls, { actor: req.seoActor, requestId: req.seoRequestId });
    res.json({ submitted: results.filter((r) => r.status === "submitted").length, results, request_id: req.seoRequestId });
}));

/* ───── admin: read the logs ───── */
// GET /api/seo/logs/requests?limit=50&method=PUT&status=422&source=automation&actor=run-1&since=2026-10-20
router.get("/logs/requests", requireSeoAdmin, wrap(async (req, res) => {
    let q = supabaseAdmin.from("seo_request_log").select("*").order("ts", { ascending: false })
        .limit(Math.min(Number(req.query.limit) || 50, 500));
    if (req.query.method) q = q.eq("method", String(req.query.method).toUpperCase());
    if (req.query.status) q = q.eq("status", Number(req.query.status));
    if (req.query.source) q = q.eq("source", req.query.source);
    if (req.query.actor) q = q.eq("actor", req.query.actor);
    if (req.query.since) q = q.gte("ts", req.query.since);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ items: data });
}));

// GET /api/seo/logs/changes?slug=/brands/zerust&entity_type=page&request_id=<uuid>
router.get("/logs/changes", requireSeoAdmin, wrap(async (req, res) => {
    let q = supabaseAdmin.from("seo_change_log").select("*").order("ts", { ascending: false })
        .limit(Math.min(Number(req.query.limit) || 50, 500));
    if (req.query.slug) q = q.eq("entity_key", normalizeSlug(req.query.slug));
    if (req.query.entity_type) q = q.eq("entity_type", req.query.entity_type);
    if (req.query.request_id) q = q.eq("request_id", req.query.request_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ items: data });
}));

export default router;