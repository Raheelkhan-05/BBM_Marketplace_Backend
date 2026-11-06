// src/controllers/partner.controller.js
// RFQ + SEO handlers for the integration API. Catalog / geo handlers are reused as-is in the router.
import { supabase } from "../config/supabase.js";
import { sanitizeEnquiry, toDto, isUuid, RFQ_STATUSES } from "../services/rfqValidation.js";
import { notifyAdminsNewRfq } from "../services/rfqNotify.js";
import { fetchActiveQuotes, quoteToDto } from "../services/rfqQuotes.service.js";
import { getSitemap, getSsrMeta, normalizeSlug } from "../services/seo.service.js";

const MAX_BULK = 50;
const MAX_PENDING = Number(process.env.PARTNER_MAX_PENDING) || 500;

const fail = (req, res, status, message) =>
    res.status(status).json({ success: false, message, request_id: req.partnerRequestId });

const safeSearch = (q) => String(q || "").replace(/[%_,()\\]/g, " ").trim().slice(0, 80);

// Same rule as the website: ONE final quantity in the individual unit (pack size 1).
function toTotalQuantity(raw) {
    const packKey = "packSize" in raw ? "packSize" : "pack_size" in raw ? "pack_size" : null;
    if (!packKey) return raw;
    const q = Number(raw.quantity), p = Number(raw[packKey]);
    if (!Number.isFinite(q) || !Number.isFinite(p) || !(q > 0) || !(p > 0) || p === 1) return raw;
    return { ...raw, quantity: Math.round(q * p * 1e6) / 1e6, [packKey]: 1 };
}
function prepare(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const withPack = raw.packSize === undefined || raw.packSize === null || raw.packSize === "" ? { ...raw, packSize: 1 } : raw;
    return toTotalQuantity(withPack);
}
function customerColumns(c) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return {};
    const s = (v, m) => (typeof v === "string" ? v.trim().slice(0, m) || null : null);
    return {
        customer_name: s(c.name, 150),
        customer_phone: s(c.phone, 20),
        customer_email: s(c.email, 150),
        customer_gstin: s(c.gstin, 15)?.toUpperCase() ?? null,
    };
}

async function pendingCount(buyerId) {
    const { count, error } = await supabase
        .from("rfq_enquiries").select("id", { count: "exact", head: true })
        .eq("buyer_id", buyerId).eq("status", "pending_review");
    if (error) throw error;
    return count || 0;
}

async function withQuotes(rows) {
    let map = new Map();
    try { map = await fetchActiveQuotes(rows.map((r) => r.id)); }
    catch (e) { console.error("[partner] quotes lookup failed:", e.message); }
    return rows.map((row) => {
        const quotes = (map.get(row.id) || []).map((q) => quoteToDto(q, row, { forBuyer: true }));
        return { ...toDto(row, { owner: true }), isMine: true, quotes, quotesCount: quotes.length };
    });
}

export const ping = (req, res) => res.json({ success: true, serverTime: new Date().toISOString() });

/* ───────────── RFQ ───────────── */

// GET /rfq?status=&q=&limit=&offset=
export async function listRfq(req, res) {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 30);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q = safeSearch(req.query.q);

    let query = supabase.from("rfq_enquiries").select("*", { count: "exact" })
        .eq("buyer_id", req.partnerBuyerId).order("created_at", { ascending: false });
    if (RFQ_STATUSES.includes(req.query.status)) query = query.eq("status", req.query.status);
    if (q) query = query.ilike("product_name", `%${q}%`);

    const { data, count, error } = await query.range(offset, offset + limit - 1);
    if (error) throw error;
    const items = await withQuotes(data || []);
    res.set("Cache-Control", "no-store");
    res.json({ success: true, items, total: count ?? items.length, hasMore: offset + items.length < (count ?? 0) });
}

// GET /rfq/:id
export async function getRfq(req, res) {
    if (!isUuid(req.params.id)) return fail(req, res, 404, "Enquiry not found.");
    const { data, error } = await supabase.from("rfq_enquiries").select("*")
        .eq("id", req.params.id).eq("buyer_id", req.partnerBuyerId).maybeSingle();
    if (error) throw error;
    if (!data) return fail(req, res, 404, "Enquiry not found.");
    const [enquiry] = await withQuotes([data]);
    res.set("Cache-Control", "no-store");
    res.json({ success: true, enquiry });
}

// POST /rfq
export async function createRfq(req, res) {
    const v = sanitizeEnquiry(prepare(req.body));
    if (!v.ok) return fail(req, res, 400, v.message);
    if ((await pendingCount(req.partnerBuyerId)) >= MAX_PENDING) {
        return fail(req, res, 429, "Too many enquiries are waiting for review. Please try again later.");
    }
    const { data, error } = await supabase.from("rfq_enquiries")
        .insert({ ...v.row, ...customerColumns(req.body?.customer), buyer_id: req.partnerBuyerId, status: "pending_review" })
        .select("*").single();
    if (error) throw error;
    notifyAdminsNewRfq({ count: 1, name: data.product_name });
    res.json({
        success: true,
        enquiry: { ...toDto(data, { owner: true }), isMine: true },
        message: "Submitted for review.",
    });
}

// POST /rfq/bulk  { rows: [...] }  — all-or-nothing
export async function bulkCreateRfq(req, res) {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length) return fail(req, res, 400, "No enquiries to upload.");
    if (rows.length > MAX_BULK) return fail(req, res, 400, `You can upload up to ${MAX_BULK} enquiries at a time.`);

    const errors = [], clean = [];
    rows.forEach((r, i) => {
        const v = sanitizeEnquiry(prepare(r));
        if (!v.ok) errors.push({ row: i + 1, message: v.message });
        else clean.push({ ...v.row, ...customerColumns(r?.customer), buyer_id: req.partnerBuyerId, status: "pending_review" });
    });
    if (errors.length) return res.status(400).json({ success: false, message: "Some rows are invalid.", errors, request_id: req.partnerRequestId });

    if ((await pendingCount(req.partnerBuyerId)) + clean.length > MAX_PENDING) {
        return fail(req, res, 429, "Too many enquiries are waiting for review. Please try again later.");
    }
    const { data, error } = await supabase.from("rfq_enquiries").insert(clean).select("id, product_name");
    if (error) throw error;
    notifyAdminsNewRfq({ count: data.length, name: data[0]?.product_name });
    res.json({ success: true, createdCount: data.length, ids: data.map((d) => d.id), message: `${data.length} enquiries submitted for review.` });
}

// PATCH /rfq/:id — full payload; allowed while pending_review / rejected; goes back into review
export async function updateRfq(req, res) {
    const { id } = req.params;
    if (!isUuid(id)) return fail(req, res, 404, "Enquiry not found.");
    const v = sanitizeEnquiry(prepare(req.body));
    if (!v.ok) return fail(req, res, 400, v.message);

    const patch = {
        ...v.row,
        ...(req.body?.customer !== undefined ? customerColumns(req.body.customer) : {}),
        status: "pending_review", review_note: null, reviewed_at: null, reviewed_by: null,
    };
    const { data: current, error: curErr } = await supabase.from("rfq_enquiries").select("id")
        .eq("id", id).eq("buyer_id", req.partnerBuyerId).maybeSingle();
    if (curErr) throw curErr;
    if (!current) return fail(req, res, 404, "Enquiry not found.");

    const { data, error } = await supabase.from("rfq_enquiries").update(patch)
        .eq("id", id).eq("buyer_id", req.partnerBuyerId).in("status", ["pending_review", "rejected"])
        .select("*").maybeSingle();
    if (error) throw error;
    if (!data) return fail(req, res, 409, "This enquiry can no longer be edited. Close it and create a new one.");
    notifyAdminsNewRfq({ count: 1, name: data.product_name, resubmitted: true });
    res.json({ success: true, enquiry: { ...toDto(data, { owner: true }), isMine: true }, message: "Saved and sent for review again." });
}

// POST /rfq/:id/close
export async function closeRfq(req, res) {
    const { id } = req.params;
    if (!isUuid(id)) return fail(req, res, 404, "Enquiry not found.");
    const { data, error } = await supabase.from("rfq_enquiries").update({ status: "closed" })
        .eq("id", id).eq("buyer_id", req.partnerBuyerId).in("status", ["pending_review", "approved"])
        .select("*").maybeSingle();
    if (error) throw error;
    if (!data) return fail(req, res, 409, "This enquiry can't be closed.");
    res.json({ success: true, enquiry: { ...toDto(data, { owner: true }), isMine: true } });
}

// GET /rfq/updates?since=<ISO date-time>
// New/changed quotes and review outcomes since `since` — poll this to push WhatsApp alerts.
export async function rfqUpdates(req, res) {
    const since = new Date(String(req.query.since || ""));
    if (Number.isNaN(since.getTime())) return fail(req, res, 400, "since must be an ISO date-time, e.g. 2026-11-06T00:00:00Z.");

    const { data, error } = await supabase.from("rfq_enquiries").select("*")
        .eq("buyer_id", req.partnerBuyerId).order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    const rows = data || [];

    const map = await fetchActiveQuotes(rows.map((r) => r.id));
    const quotes = [];
    for (const row of rows) {
        for (const q of map.get(row.id) || []) {
            if (new Date(q.updated_at || q.created_at) > since) quotes.push(quoteToDto(q, row, { forBuyer: true }));
        }
    }
    const statusChanges = rows
        .filter((r) => (r.reviewed_at && new Date(r.reviewed_at) > since) || (r.published_at && new Date(r.published_at) > since))
        .map((r) => ({ id: r.id, productName: r.product_name, status: r.status, reviewNote: r.review_note || "", reviewedAt: r.reviewed_at, publishedAt: r.published_at }));

    res.set("Cache-Control", "no-store");
    res.json({ success: true, since: since.toISOString(), serverTime: new Date().toISOString(), quotes, statusChanges });
}

/* ───────────── SEO / page content ───────────── */

// GET /seo/ssr-meta?path=/brands/zerust
export async function ssrMeta(req, res) {
    if (!req.query.path) return fail(req, res, 400, "path is required.");
    const slug = normalizeSlug(req.query.path);
    res.json({ success: true, slug, ...(await getSsrMeta(slug)) });
}

// GET /seo/slugs — every indexable page, straight from the live sitemap
export async function slugs(req, res) {
    const { xml } = await getSitemap();
    const items = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => {
        const url = m[1].replace(/&amp;/g, "&");
        let path = url;
        try { path = new URL(url).pathname; } catch { /* keep url */ }
        return { url, path };
    });
    res.set("Cache-Control", "public, max-age=300");
    res.json({ success: true, total: items.length, items });
}

/* ───────────── Catalog: brand family ───────────── */

// Same normalisation as the catalog search (lowercase letters + digits only), so "Yogi Hi-Tech" == "yogihitech".
const normalize = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9\u0080-\uFFFF]+/g, "");

// GET /catalog/brand-family?brandName=&limit=&offset=
// Every approved catalog item carrying a brand name, with where it sits in the category tree.
export async function brandFamily(req, res) {
    const raw = String(req.query.brandName || req.query.q || "").trim().slice(0, 100);
    const n = normalize(raw);
    if (n.length < 2) return fail(req, res, 400, "brandName is required (at least 2 characters).");
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { data, error } = await supabase
        .from("hs_generic_product_brands")
        .select(`
            id, name, brand_name, slug, image, generic_product_id,
            generic_product:hs_generic_products ( name, subcategory:hs_subcategories ( name, category:hs_categories ( name ) ) )
        `)
        .eq("review_status", "approved").is("deleted_at", null)
        .ilike("brand_name_norm", `%${n}%`)
        .order("name")
        .range(offset, offset + limit); // one extra row to detect hasMore
    if (error) throw error;

    const rows = data || [];
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
        id: r.id, name: r.name, brandName: r.brand_name, slug: r.slug, image: r.image,
        genericProductId: r.generic_product_id,
        genericProductName: r.generic_product?.name ?? null,
        subcategoryName: r.generic_product?.subcategory?.name ?? null,
        categoryName: r.generic_product?.subcategory?.category?.name ?? null,
    }));
    res.json({ success: true, brandName: raw, items, hasMore, nextOffset: offset + items.length });
}