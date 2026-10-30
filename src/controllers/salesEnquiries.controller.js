// Salesperson RFQs. A salesperson posts on behalf of the company: buyer_id = companyId, posted_by = the salesperson.
// The company's Save module reads the same rows, so everything shows up there too.
import { supabase } from "../config/supabase.js";
import { sanitizeEnquiry, toDto, isUuid, RFQ_STATUSES } from "../services/rfqValidation.js";
import { notifyAdminsNewRfq } from "../services/rfqNotify.js";
import { attachQuotes } from "../services/rfqQuotes.service.js";
import { emitRfqQuotesChanged } from "../services/rfqRealtime.js";
import { pingCustomersChanged } from "../services/salesSync.service.js";
import { logActivity } from "../services/team.service.js";

const MAX_PENDING = 100;
const MAX_LIMIT = 50;
const safeSearch = (q) => String(q || "").replace(/[%_,()\\*]/g, " ").trim().slice(0, 80);

// One final quantity in the individual unit (same folding as rfq.controller).
function toTotalQuantity(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const packKey = "packSize" in raw ? "packSize" : "pack_size" in raw ? "pack_size" : null;
    if (!packKey) return raw;
    const q = Number(raw.quantity), p = Number(raw[packKey]);
    if (!Number.isFinite(q) || !Number.isFinite(p) || !(q > 0) || !(p > 0) || p === 1) return raw;
    return { ...raw, quantity: Math.round(q * p * 1e6) / 1e6, [packKey]: 1 };
}

function ctxOf(req, res) {
    const { companyId, actorId, teamId } = req.sales || {};
    if (!companyId || !actorId) {
        res.status(409).json({ success: false, message: "Your company account isn't ready yet." });
        return null;
    }
    return { companyId, actorId, teamId };
}

const head = (companyId) =>
    supabase.from("rfq_enquiries").select("id", { count: "exact", head: true }).eq("buyer_id", companyId);

const dto = (row, actorId) => ({
    ...toDto(row, { owner: true }),
    isMine: true,                       // "mine" for the company, so quotes get attached
    postedByMe: row.posted_by === actorId,
});

// Tell the Save module (company) and the salesperson's open pages. Never fails the request.
function broadcast(companyId, actorId, enquiryId) {
    try { emitRfqQuotesChanged([companyId, actorId].filter(Boolean), { enquiryId }); }
    catch (e) { console.error("[sales rfq] emit failed:", e?.message || e); }
    Promise.resolve().then(() => pingCustomersChanged(companyId, [actorId])).catch(() => { /* best effort */ });
}

// GET /api/sales/enquiries?q=&status=&mine=1&limit=&offset=
export async function listSalesEnquiries(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const ctx = ctxOf(req, res); if (!ctx) return;
        const { companyId, actorId } = ctx;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), MAX_LIMIT);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const mine = req.query.mine === "1" || req.query.mine === "true";
        const q = safeSearch(req.query.q);

        let query = supabase.from("rfq_enquiries").select("*", { count: "exact" }).eq("buyer_id", companyId);
        if (mine) query = query.eq("posted_by", actorId);
        if (RFQ_STATUSES.includes(req.query.status)) query = query.eq("status", req.query.status);
        if (q) query = query.ilike("product_name", `%${q}%`);

        const { data, count, error } = await query
            .order("created_at", { ascending: false }).order("id", { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw error;

        const rows = data || [];
        let items = rows.map((r) => dto(r, actorId));
        try { items = await attachQuotes(items, rows, companyId, [companyId]); }
        catch (e) { console.error("[sales rfq] attachQuotes failed:", e.message); }

        const body = { success: true, items, total: count ?? items.length, hasMore: offset + items.length < (count ?? 0) };
        if (offset === 0) {
            const [a, b] = await Promise.all([head(companyId), head(companyId).eq("posted_by", actorId)]);
            body.counts = { all: a.count || 0, mine: b.count || 0 };
        }
        res.json(body);
    } catch (e) {
        console.error("[sales rfq] list failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't load RFQs." });
    }
}

// POST /api/sales/enquiries
export async function createSalesEnquiry(req, res) {
    try {
        const ctx = ctxOf(req, res); if (!ctx) return;
        const { companyId, actorId, teamId } = ctx;

        const v = sanitizeEnquiry(toTotalQuantity(req.body));
        if (!v.ok) return res.status(400).json({ success: false, message: v.message });

        const { count: pending, error: pErr } = await head(companyId).eq("status", "pending_review");
        if (pErr) throw pErr;
        if ((pending || 0) >= MAX_PENDING) {
            return res.status(429).json({ success: false, message: "There are too many RFQs waiting for review. Please wait for them to be reviewed." });
        }

        const { data, error } = await supabase
            .from("rfq_enquiries")
            .insert({ ...v.row, buyer_id: companyId, posted_by: actorId, status: "pending_review" })
            .select("*").single();
        if (error) throw error;

        notifyAdminsNewRfq({ count: 1, name: data.product_name });
        broadcast(companyId, actorId, data.id);
        try {
            await logActivity({
                teamId, actorId, actorRole: "member", category: "sales", action: "sales.rfq_posted",
                label: `Posted RFQ ${data.product_name}`, entityType: "rfq", entityId: data.id, meta: { link: "/sell/rfq" },
            });
        } catch { /* best effort */ }

        res.json({ success: true, enquiry: dto(data, actorId), message: "Submitted for review. We'll notify you once it's approved." });
    } catch (e) {
        console.error("[sales rfq] create failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't submit this RFQ. Try again." });
    }
}

// PATCH /api/sales/enquiries/:id — only the salesperson's own pending/rejected RFQs; goes back into review
export async function updateSalesEnquiry(req, res) {
    try {
        const ctx = ctxOf(req, res); if (!ctx) return;
        const { companyId, actorId } = ctx;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "RFQ not found." });

        const v = sanitizeEnquiry(toTotalQuantity(req.body));
        if (!v.ok) return res.status(400).json({ success: false, message: v.message });

        const { data: cur, error: cErr } = await supabase.from("rfq_enquiries").select("id, status")
            .eq("id", id).eq("buyer_id", companyId).eq("posted_by", actorId).maybeSingle();
        if (cErr) throw cErr;
        if (!cur) return res.status(404).json({ success: false, message: "RFQ not found." });
        if (!["pending_review", "rejected"].includes(cur.status)) {
            return res.status(409).json({ success: false, message: "Live or closed RFQs can't be edited. Close it and post a new one." });
        }

        const { data, error } = await supabase.from("rfq_enquiries")
            .update({ ...v.row, status: "pending_review", review_note: null, reviewed_at: null, reviewed_by: null })
            .eq("id", id).eq("buyer_id", companyId).eq("posted_by", actorId)
            .in("status", ["pending_review", "rejected"]).select("*").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ success: false, message: "This RFQ was just reviewed. Refresh and try again." });

        notifyAdminsNewRfq({ count: 1, name: data.product_name, resubmitted: true });
        broadcast(companyId, actorId, data.id);
        res.json({ success: true, enquiry: dto(data, actorId), message: "Saved and sent for review again." });
    } catch (e) {
        console.error("[sales rfq] update failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't save your changes. Try again." });
    }
}

// POST /api/sales/enquiries/:id/close — only the salesperson's own pending or live RFQs
export async function closeSalesEnquiry(req, res) {
    try {
        const ctx = ctxOf(req, res); if (!ctx) return;
        const { companyId, actorId } = ctx;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "RFQ not found." });

        const { data, error } = await supabase.from("rfq_enquiries").update({ status: "closed" })
            .eq("id", id).eq("buyer_id", companyId).eq("posted_by", actorId)
            .in("status", ["pending_review", "approved"]).select("*").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ success: false, message: "This RFQ can't be closed." });

        broadcast(companyId, actorId, id);
        res.json({ success: true, enquiry: dto(data, actorId) });
    } catch (e) {
        console.error("[sales rfq] close failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't close this RFQ." });
    }
}