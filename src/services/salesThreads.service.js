// services/salesThreads.service.js
// Shared helpers for sales threads: validation, DTOs, price maths, message text, signed file URLs.
import { supabase } from "../config/supabase.js";
import { emitRfqQuotesChanged } from "./rfqRealtime.js";

export const BUCKET = "sales-attachments";
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const APP_URL = String(process.env.APP_URL || process.env.FRONTEND_URL || "https://bbm.business").replace(/\/+$/, "");
export const productUrl = (submissionId) => `${APP_URL}/p/${submissionId}`;

// ---------------------------------------------------------------------------------------------------------
// WHO IS CALLING.  This is the ONLY place that knows how your sales middleware identifies the caller.
// Adjust the property names below if your existing sales middleware uses different ones.
//   actorId   -> the salesperson (only they can see / change their own threads)
//   ownerId   -> the company account the salesperson works for (products + the Save page belong to it)
// ---------------------------------------------------------------------------------------------------------
export function getSalesActor(req) {
    const s = req.sales || {};
    return {
        actorId: s.actorId || req.actor?.id,          // the real salesperson
        actorName: String(req.actor?.name || req.user?.name || "Salesperson").trim().slice(0, 120),
        actorEmail: req.actor?.email || null,
        ownerId: s.companyId || req.user.id,          // company user id (buyer_id on enquiries)
        sellerId: s.sellerId || null,                 // seller_profiles.id (null if not approved)
    };
}

// ---- small cleaners -------------------------------------------------------------------------------------
export const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const safeSearch = (q) => String(q || "").replace(/[%_,()\\]/g, " ").trim().slice(0, 80);
export const cleanGstin = (v) => String(v || "").replace(/\s+/g, "").toUpperCase().slice(0, 15);
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

// Returns a clean 10-digit Indian mobile number, or "" when it is not valid.
export function cleanPhone(v) {
    let d = String(v || "").replace(/\D/g, "");
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : "";
}
export function cleanEmail(v) {
    const e = String(v || "").trim().toLowerCase().slice(0, 200);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
}

export const clipPreview = (text, files = 0) => {
    const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 90);
    if (t && files) return `${t} (+${files} file${files === 1 ? "" : "s"})`;
    if (t) return t;
    return files ? `${files} file${files === 1 ? "" : "s"} attached` : "";
};

// Best effort live refresh of the Sales page and the Save page (same socket event the RFQ pages already use).
export function ping(userIds, payload) {
    try { emitRfqQuotesChanged([...new Set(userIds.filter(Boolean))], payload); } catch { /* best effort */ }
}

// ---- price maths ----------------------------------------------------------------------------------------
// A listing price is stored per SALE unit (unit / pack / master pack). One sale unit holds this many base units:
export const saleUnits = (pack, master) => {
    const p = Number(pack) > 0 ? Number(pack) : 1;
    const m = Number(master) > 0 ? Number(master) : 1;
    return m > 1 ? p * m : p > 1 ? p : 1;
};

export function priceLine({ price, gstInclusive, gstPercent, quantity }) {
    const g = 1 + (Number(gstPercent) || 0) / 100;
    const unitIncl = gstInclusive ? price : price * g;
    const totalIncl = round2(unitIncl * quantity);
    const taxable = round2(totalIncl / g);
    return {
        unitPriceIncl: round4(unitIncl),
        unitPriceExcl: round4(unitIncl / g),
        totalIncl,
        taxable,
        gstAmount: round2(totalIncl - taxable),
    };
}

// Same rules the marketplace uses before a product may be quoted.
export function listingProblem(s) {
    if (s.review_status === "pending_review") return "In review";
    if (s.review_status !== "approved") return "Not available";
    if (s.is_active === false) return "Paused";
    if (s.expires_at && new Date(s.expires_at).getTime() <= Date.now()) return "Expired";
    return null;
}

export const listingDescription = (s) =>
    String(s.short_description ?? s.description ?? s.brand?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 220);

// ---- DTOs -----------------------------------------------------------------------------------------------
export function threadDto(row, extra = {}) {
    return {
        id: row.id,
        customerName: row.customer_name || "",
        customerGstin: row.customer_gstin || "",
        customerPhone: row.customer_phone || "",
        customerEmail: row.customer_email || "",
        displayName: row.customer_name || (row.customer_gstin ? `GSTIN ${row.customer_gstin}` : "Customer"),
        productName: row.product_name,
        quantity: Number(row.quantity),
        unit: row.unit,
        specifications: row.specifications || "",
        status: row.status === "closed" ? "closed" : "open",
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at || row.created_at,
        lastPreview: row.last_entry_preview || "",
        salespersonId: row.created_by_actor_id,
        salespersonName: row.created_by_actor_name || "",
        ...extra,
    };
}

export function quoteDto(q) {
    return {
        id: q.id,
        total: Number(q.total),
        subtotal: Number(q.subtotal),
        gstAmount: Number(q.gst_amount),
        validUntil: q.valid_until,
        validityDays: q.validity_days,
        channels: q.channels || [],
        delivery: q.delivery || {},
        note: q.note || "",
        createdAt: q.created_at,
        items: (q.items || []).map((i) => ({
            submissionId: i.submissionId, productName: i.productName, brandName: i.brandName || "",
            unit: i.unit, quantity: i.quantity, unitPriceIncl: i.unitPriceIncl, totalIncl: i.totalIncl, url: i.url,
        })),
    };
}

export const entryDto = (e, quote = null) => ({
    id: e.id, kind: e.kind, body: e.body || "", attachments: e.attachments || [],
    authorName: e.author_name || "", createdAt: e.created_at, quote,
});

// Adds a 1-hour signed URL to every attachment, and the quote card data to quote entries.
export async function hydrateEntries(rows) {
    if (!rows.length) return [];
    const quoteIds = [...new Set(rows.map((r) => r.quote_id).filter(Boolean))];
    const paths = [...new Set(rows.flatMap((r) => (r.attachments || []).map((a) => a.path)).filter(Boolean))];

    const [qRes, uRes] = await Promise.all([
        quoteIds.length ? supabase.from("sales_quotes").select("*").in("id", quoteIds) : { data: [] },
        paths.length ? supabase.storage.from(BUCKET).createSignedUrls(paths, 3600) : { data: [] },
    ]);
    if (qRes.error) throw qRes.error;
    const quotes = new Map((qRes.data || []).map((q) => [q.id, quoteDto(q)]));
    const urls = new Map((uRes.data || []).map((u) => [u.path, u.signedUrl]));

    return rows.map((r) => entryDto(
        { ...r, attachments: (r.attachments || []).map((a) => ({ ...a, url: urls.get(a.path) || null })) },
        r.quote_id ? quotes.get(r.quote_id) || null : null,
    ));
}

// For the Save page: the quotations a salesperson sent on each sales enquiry (read only).
export async function attachSalesQuotes(items) {
    const ids = items.filter((i) => i.source === "sales").map((i) => i.id);
    if (!ids.length) return items;
    const { data, error } = await supabase
        .from("sales_quotes").select("id, enquiry_id, total, channels, items, created_at")
        .in("enquiry_id", ids).order("created_at", { ascending: false });
    if (error) throw error;
    const by = new Map();
    for (const q of data || []) {
        const list = by.get(q.enquiry_id) || [];
        list.push({ id: q.id, total: Number(q.total), itemsCount: Array.isArray(q.items) ? q.items.length : 0, channels: q.channels || [], createdAt: q.created_at });
        by.set(q.enquiry_id, list);
    }
    return items.map((i) => (i.source === "sales" ? { ...i, salesQuotes: by.get(i.id) || [] } : i));
}

// ---- customer-facing text -------------------------------------------------------------------------------
export const inr = (n, max = 2) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: max });
export const fmtQty = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 4 });
export const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const oneLine = (s) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();

// WhatsApp template variables may not contain new lines, so the items are joined on one line with " | ".
export function whatsappItemsLine(items, max = 850) {
    const parts = [];
    let len = 0;
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const p = `${i + 1}) ${oneLine(it.productName)} - ${fmtQty(it.quantity)} ${oneLine(it.unit)} x ${inr(it.unitPriceIncl, 4)} = ${inr(it.totalIncl)} - ${it.url}`;
        if (parts.length && len + p.length + 3 > max) {
            const rest = items.length - i;
            parts.push(`and ${rest} more item${rest === 1 ? "" : "s"}`);
            break;
        }
        parts.push(p);
        len += p.length + 3;
    }
    return parts.join(" | ");
}