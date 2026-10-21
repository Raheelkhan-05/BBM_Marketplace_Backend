// controllers/rfq.controller.js
import { supabase } from "../config/supabase.js";
import { sanitizeEnquiry, toDto, isUuid, RFQ_STATUSES } from "../services/rfqValidation.js";
import { notifyAdminsNewRfq } from "../services/rfqNotify.js";
import { attachQuotes, countQuotesForBuyer } from "../services/rfqQuotes.service.js";

const MAX_BULK = 50;       // keep within express.json's default 100kb body limit, or raise that limit for this route
const MAX_PENDING = 100;   // per-user cap on enquiries waiting for review

const safeSearch = (q) => String(q || "").replace(/[%_,()\\]/g, " ").trim().slice(0, 80);

const sellerIdsOf = (req) => [...new Set([req.user.id, req.sellerId].filter(Boolean))];

// Buyers now give ONE final quantity in the individual unit (e.g. 500 Kg). If a client still sends
// "quantity in packs" + "pack size" (the older post form, bulk-upload sheets), fold it into the total and store a
// pack size of 1, so every enquiry saved from now on has a single quantity. Anything that doesn't carry both numbers
// as positive values is passed through untouched (sanitizeEnquiry then validates it exactly as before).
function toTotalQuantity(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const packKey = "packSize" in raw ? "packSize" : "pack_size" in raw ? "pack_size" : null;
    if (!packKey) return raw;
    const q = Number(raw.quantity), p = Number(raw[packKey]);
    if (!Number.isFinite(q) || !Number.isFinite(p) || !(q > 0) || !(p > 0) || p === 1) return raw;
    return { ...raw, quantity: Math.round(q * p * 1e6) / 1e6, [packKey]: 1 };
}

async function pendingCount(userId) {
    const { count, error } = await supabase
        .from("rfq_enquiries")
        .select("id", { count: "exact", head: true })
        .eq("buyer_id", userId)
        .eq("status", "pending_review");
    if (error) throw error;
    return count || 0;
}

// GET /api/rfq?scope=all|mine&q=&status=&limit=&offset=
// Own rows carry `quotes` + `quotesCount`; other people's live rows carry `myQuote` (this seller's own quote, if any).
// scope=mine also returns `quotesTotal` (live quotes across all of the buyer's enquiries).
export async function listEnquiries(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const scope = req.query.scope === "mine" ? "mine" : "all";
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 30);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const q = safeSearch(req.query.q);

        let query = supabase.from("rfq_enquiries").select("*", { count: "exact" });
        if (scope === "mine") {
            query = query.eq("buyer_id", req.user.id).order("created_at", { ascending: false });
            if (RFQ_STATUSES.includes(req.query.status)) query = query.eq("status", req.query.status);
        } else {
            query = query
                .eq("status", "approved")
                .neq("buyer_id", req.user.id)
                .order("published_at", { ascending: false });
        }
        if (q) query = query.ilike("product_name", `%${q}%`);

        const { data, count, error } = await query.range(offset, offset + limit - 1);
        if (error) throw error;

        const rows = data || [];
        const base = rows.map((row) => {
            const mine = row.buyer_id === req.user.id;
            return {
                ...toDto(row, { owner: mine }),
                isMine: mine,
                ...(mine ? {} : { buyerId: row.buyer_id }), // sellers need it to save this buyer's custom price
            };
        });

        let items = base;
        let quotesError = null;
        try { items = await attachQuotes(base, rows, req.user.id, sellerIdsOf(req)); }
        catch (e) { quotesError = e.message; console.error("[rfq] attachQuotes failed:", e.message); }

        const body = { success: true, items, total: count ?? items.length, hasMore: offset + items.length < (count ?? 0) };
        if (quotesError) body.quotesError = quotesError; // visible in DevTools instead of silently empty

        if (scope === "mine") {
            try { body.quotesTotal = await countQuotesForBuyer(req.user.id); } catch { /* tile falls back to a dash */ }
        }
        res.json(body);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// GET /api/rfq/:id — PUBLIC for live (and closed) enquiries; the owner can also open their own in any status.
// Guests (req.user is null) get the requirement only: no buyer id, no quotes, no "my quote".
export async function getEnquiry(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Enquiry not found." });
        const { data, error } = await supabase.from("rfq_enquiries").select("*").eq("id", id).maybeSingle();
        if (error) throw error;

        const userId = req.user?.id || null;
        const mine = !!userId && data?.buyer_id === userId;
        const publicStatus = data && ["approved", "closed"].includes(data.status);
        if (!data || (!mine && !publicStatus)) {
            return res.status(404).json({ success: false, message: "Enquiry not found." });
        }

        res.set("Cache-Control", "no-store");
        let enquiry = {
            ...toDto(data, { owner: mine }),
            isMine: mine,
            ...(mine || !userId ? {} : { buyerId: data.buyer_id }), // guests never get the buyer's id
        };
        if (userId) {
            try { [enquiry] = await attachQuotes([enquiry], [data], userId, sellerIdsOf(req)); }
            catch (e) { console.error("[rfq] attachQuotes failed:", e.message); }
        }
        res.json({ success: true, enquiry });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/rfq
export async function createEnquiry(req, res) {
    try {
        const v = sanitizeEnquiry(toTotalQuantity(req.body));
        if (!v.ok) return res.status(400).json({ success: false, message: v.message });

        if ((await pendingCount(req.user.id)) >= MAX_PENDING) {
            return res.status(429).json({ success: false, message: "You have too many enquiries waiting for review. Please wait for them to be reviewed." });
        }

        const { data, error } = await supabase
            .from("rfq_enquiries")
            .insert({ ...v.row, buyer_id: req.user.id, status: "pending_review" })
            .select("*")
            .single();
        if (error) throw error;

        notifyAdminsNewRfq({ count: 1, name: data.product_name });
        res.json({
            success: true,
            enquiry: { ...toDto(data, { owner: true }), isMine: true },
            message: "Submitted for review. We'll notify you once it's approved.",
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/rfq/bulk  { rows: [payload, ...] } — all-or-nothing
export async function bulkCreateEnquiries(req, res) {
    try {
        const rows = req.body?.rows;
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: "No enquiries to upload." });
        }
        if (rows.length > MAX_BULK) {
            return res.status(400).json({ success: false, message: `You can upload up to ${MAX_BULK} enquiries at a time.` });
        }

        const errors = [];
        const clean = [];
        rows.forEach((r, i) => {
            const v = sanitizeEnquiry(toTotalQuantity(r));
            if (!v.ok) errors.push({ row: i + 1, message: v.message });
            else clean.push({ ...v.row, buyer_id: req.user.id, status: "pending_review" });
        });
        if (errors.length) {
            return res.status(400).json({ success: false, message: "Some rows are invalid.", errors });
        }

        if ((await pendingCount(req.user.id)) + clean.length > MAX_PENDING) {
            return res.status(429).json({ success: false, message: "That would exceed the limit of enquiries waiting for review. Please wait for earlier ones to be reviewed." });
        }

        const { data, error } = await supabase.from("rfq_enquiries").insert(clean).select("id, product_name");
        if (error) throw error;

        notifyAdminsNewRfq({ count: data.length, name: data[0]?.product_name });
        res.json({
            success: true,
            createdCount: data.length,
            message: `${data.length} enquir${data.length === 1 ? "y" : "ies"} submitted for review.`,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// PATCH /api/rfq/:id — owner edits a pending/rejected enquiry; it goes back into review
export async function updateOwnEnquiry(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Enquiry not found." });

        const v = sanitizeEnquiry(toTotalQuantity(req.body));
        if (!v.ok) return res.status(400).json({ success: false, message: v.message });

        const { data: current, error: curErr } = await supabase
            .from("rfq_enquiries").select("id, status").eq("id", id).eq("buyer_id", req.user.id).maybeSingle();
        if (curErr) throw curErr;
        if (!current) return res.status(404).json({ success: false, message: "Enquiry not found." });
        if (!["pending_review", "rejected"].includes(current.status)) {
            return res.status(409).json({ success: false, message: "Live or closed enquiries can't be edited. Close it and post a new one." });
        }

        const { data, error } = await supabase
            .from("rfq_enquiries")
            .update({ ...v.row, status: "pending_review", review_note: null, reviewed_at: null, reviewed_by: null })
            .eq("id", id).eq("buyer_id", req.user.id)
            .in("status", ["pending_review", "rejected"])
            .select("*").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ success: false, message: "This enquiry was just reviewed. Refresh and try again." });

        notifyAdminsNewRfq({ count: 1, name: data.product_name, resubmitted: true });
        res.json({
            success: true,
            enquiry: { ...toDto(data, { owner: true }), isMine: true },
            message: "Saved and sent for review again.",
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/rfq/:id/close — owner withdraws a pending or live enquiry
export async function closeOwnEnquiry(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Enquiry not found." });
        const { data, error } = await supabase
            .from("rfq_enquiries")
            .update({ status: "closed" })
            .eq("id", id).eq("buyer_id", req.user.id)
            .in("status", ["pending_review", "approved"])
            .select("*").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ success: false, message: "This enquiry can't be closed." });
        res.json({ success: true, enquiry: { ...toDto(data, { owner: true }), isMine: true } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}