// src/middleware/salesActivityLogger.js
// Mounted in sales.routes.js. After a successful salesperson write it records one activity row.
// Reads the request + the JSON response, so the controllers stay untouched.
import { supabaseAdmin } from "../config/supabase.js";
import { getSalesActor } from "../services/salesThreads.service.js";
import { logSalesActivity } from "../services/salesMonitor.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const CH = { whatsapp: "WhatsApp", email: "Email" };

const infoCache = new Map();
async function threadInfo(id) {
    const hit = infoCache.get(id);
    if (hit && hit.exp > Date.now()) return hit.v;
    const { data } = await supabaseAdmin.from("rfq_enquiries")
        .select("customer_name, product_name, quantity, unit").eq("id", id).maybeSingle();
    const v = data ? { customer: data.customer_name || "", product: data.product_name || "" } : { customer: "", product: "" };
    if (infoCache.size > 3000) infoCache.clear();
    infoCache.set(id, { v, exp: Date.now() + 10 * 60_000 });
    return v;
}
const sub = (i) => [i.customer, i.product].filter(Boolean).join(" · ") || null;

async function describe(req, out) {
    const path = String(req.originalUrl || "").split("?")[0].replace(/\/+$/, "");
    const m = path.match(/\/sales\/(threads|order-book|customers)((?:\/[^/]+)*)$/);
    if (!m) return null;
    const seg = m[2].split("/").filter(Boolean);
    const b = req.body || {};
    const M = req.method;

    if (m[1] === "threads") {
        if (M === "POST" && seg.length === 0) {
            const t = out?.thread; if (!t?.id) return null;
            return {
                module: "enquiry", kind: "enquiry.created", title: "Created an enquiry", entityType: "enquiry", entityId: t.id,
                subtitle: sub({ customer: t.displayName || t.customerName, product: t.productName }),
                preview: t.quantity ? `${t.quantity} ${t.unit || ""}`.trim() : null, meta: {},
            };
        }
        const id = seg[0];
        if (!id || !UUID_RE.test(id)) return null;
        const base = { module: "enquiry", entityType: "enquiry", entityId: id };
        const info = out?.thread
            ? { customer: out.thread.displayName || out.thread.customerName, product: out.thread.productName }
            : await threadInfo(id);
        const subtitle = sub(info);

        if (M === "PATCH" && seg.length === 1) return { ...base, kind: "enquiry.customer_updated", title: "Updated customer details", subtitle, meta: {} };
        if (M === "PATCH" && seg[1] === "status") {
            const s = b.status;
            const title = s === "won" ? "Marked enquiry as won" : s === "lost" ? "Marked enquiry as lost" : "Reopened the enquiry";
            return { ...base, kind: `enquiry.${s === "open" ? "reopened" : s}`, title, subtitle, meta: { status: s } };
        }
        if (M === "PATCH" && seg[1] === "reminder") {
            const at = b.reminderAt;
            return {
                ...base, kind: at ? "enquiry.reminder_set" : "enquiry.reminder_removed", title: at ? "Set a reminder" : "Removed the reminder", subtitle,
                preview: at ? new Date(at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : null,
                meta: {},
            };
        }
        if (M === "POST" && seg[1] === "entries" && seg.length === 2) {
            const files = Array.isArray(b.attachments) ? b.attachments.length : 0;
            const text = clip(b.body, 200);
            return {
                ...base, kind: "enquiry.note", title: "Added an update", subtitle,
                preview: [text, files ? `+ ${plural(files, "file")}` : ""].filter(Boolean).join(" ") || null, meta: { files },
            };
        }
        if (M === "POST" && seg[1] === "quotes" && seg.length === 2) {
            const q = out?.quote;
            const chans = (Array.isArray(b.channels) ? b.channels : []).map((c) => CH[c] || c).join(", ");
            return {
                ...base, kind: "enquiry.quote_sent", title: "Sent a quotation", subtitle,
                preview: [q ? inr(q.total) : "", Array.isArray(b.items) ? plural(b.items.length, "item") : "", chans].filter(Boolean).join(" · ") || null,
                meta: { quoteId: q?.id || null },
            };
        }
        if (M === "POST" && seg[1] === "quotes" && seg[3] === "resend") {
            return { ...base, kind: "enquiry.quote_resent", title: "Resent a quotation", subtitle, meta: { quoteId: seg[2] } };
        }
        return null;
    }

    if (m[1] === "order-book" && M === "POST" && seg.length === 0) {
        const o = out?.order; if (!o?.id) return null;
        const customer = o.customerName || o.customer?.name || b.customerName || "";
        const total = o.totalAmount ?? o.total ?? o.total_amount;
        const n = Array.isArray(b.items) ? b.items.length : 0;
        return {
            module: "order", kind: "order.punched", title: "Punched an order", entityType: "order", entityId: o.id,
            subtitle: [o.orderNo, customer].filter(Boolean).join(" · ") || null,
            preview: [total != null ? inr(total) : "", n ? plural(n, "product") : ""].filter(Boolean).join(" · ") || null,
            meta: { orderNo: o.orderNo || null },
        };
    }

    if (m[1] === "customers" && M === "POST" && seg.length === 0) {
        return {
            module: "customer", kind: "customer.added", title: "Added a customer", entityType: "customer", entityId: null,
            subtitle: out?.name || null, preview: b.gstin ? `GSTIN ${String(b.gstin).toUpperCase()}` : null, meta: {},
        };
    }
    return null;
}

export default function salesActivityLogger(req, res, next) {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    const orig = res.json.bind(res);
    let payload;
    res.json = (body) => { payload = body; return orig(body); };
    res.on("finish", () => {
        if (res.statusCode < 200 || res.statusCode >= 300 || payload?.success === false) return;
        (async () => {
            const ev = await describe(req, payload);
            if (!ev) return;
            const a = getSalesActor(req);
            await logSalesActivity({
                companyId: req.sales?.companyId ?? a.ownerId, teamId: req.sales?.teamId || null,
                actorId: a.actorId, actorName: a.actorName, ...ev,
            });
        })().catch((e) => console.error("[sales monitor] logger failed:", e?.message || e));
    });
    next();
}