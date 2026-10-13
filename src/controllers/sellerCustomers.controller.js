// controllers/sellerCustomers.controller.js — a seller's customers (auto from orders + added by GSTIN + credit requests)
// CHANGED: reads from seller_customers_v (customer + credit state in ONE query),
// adds "requests" / "credit" filters, credit summary per customer, optional
// sync skip for realtime refreshes, and returns userId when a customer is added.
import { supabase, supabaseAdmin } from "../config/supabase.js";
import { validateGSTIN, fetchGstinDetails } from "../services/gst.service.js";

const MAX_BULK = 100;
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const safeSearch = (q) => String(q || "").replace(/[%_,()\\*]/g, " ").trim().slice(0, 80);
const nameOf = (bp) => bp?.display_name?.trim() || bp?.trade_name?.trim() || bp?.legal_name?.trim() || null;
const placeOf = (bp) => [bp?.district, bp?.state].filter(Boolean).join(", ") || null;
const FILTERS = ["active", "invited", "requests", "credit"];

async function sellerUserIdOf(sellerId) {
    const { data } = await supabase.from("seller_profiles").select("user_id").eq("id", sellerId).maybeSingle();
    return data?.user_id || null;
}

// GSTIN -> { state: invalid | self | registered | unregistered, ... }
async function resolveGstin(raw, sellerUserId) {
    const v = validateGSTIN(raw);
    const typed = String(raw || "").trim().toUpperCase();
    if (!v.valid) return { state: "invalid", gstin: typed, message: v.reason || "Invalid GST number." };
    const gstin = v.gstin;

    const { data: bp, error } = await supabaseAdmin
        .from("business_profiles")
        .select("user_id, gstin, legal_name, trade_name, display_name, district, state, profiles!inner(id, role, deleted_at)")
        .eq("gstin", gstin)
        .is("profiles.deleted_at", null)
        .eq("profiles.role", "user")
        .maybeSingle();
    if (error) { console.error("[customers] profile lookup failed:", error.message); return { state: "invalid", gstin, message: "Couldn't check this GST number. Try again." }; }

    if (bp) {
        if (bp.user_id === sellerUserId) return { state: "self", gstin, message: "This is your own business." };
        return { state: "registered", gstin, userId: bp.user_id, name: nameOf(bp) || "Buyer", location: placeOf(bp) };
    }
    const g = await fetchGstinDetails(gstin);
    if (!g?.mapped) return { state: "invalid", gstin, message: g?.reason || "We couldn't verify this GST number." };
    return {
        state: "unregistered", gstin,
        name: g.mapped.trade_name || g.mapped.legal_name || gstin,
        location: [g.mapped.district, g.mapped.state].filter(Boolean).join(", ") || null,
    };
}

async function findExisting(sellerId, { gstin, userId }) {
    let q = supabase.from("seller_customers").select("id, customer_user_id").eq("seller_id", sellerId);
    q = userId ? q.or(`gstin.eq.${gstin},customer_user_id.eq.${userId}`) : q.eq("gstin", gstin);
    const { data } = await q.limit(1).maybeSingle();
    return data || null;
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
}

// Add one GSTIN. result: added | invited (saved, not on BBM yet) | exists | self | invalid | error
async function addOne(sellerId, sellerUserId, rawGstin, source) {
    const r = await resolveGstin(rawGstin, sellerUserId);
    if (r.state === "invalid" || r.state === "self") return { gstin: r.gstin, result: r.state, message: r.message };

    const existing = await findExisting(sellerId, { gstin: r.gstin, userId: r.userId });
    if (existing) return { gstin: r.gstin, name: r.name, result: "exists", customer: { id: existing.id }, message: "Already in your customers." };

    const { data, error } = await supabase.from("seller_customers").insert({
        seller_id: sellerId,
        customer_user_id: r.state === "registered" ? r.userId : null,
        gstin: r.gstin, business_name: r.name, location: r.location, source,
    }).select("id, business_name, gstin, customer_user_id").single();
    if (error) {
        if (error.code === "23505") return { gstin: r.gstin, name: r.name, result: "exists", message: "Already in your customers." };
        console.error("[customers] insert failed:", error.message);
        return { gstin: r.gstin, name: r.name, result: "error", message: "Couldn't save this customer." };
    }
    return {
        gstin: r.gstin, name: r.name, location: r.location,
        userId: data.customer_user_id || null, // NEW: lets the client set credit right after adding
        result: r.state === "registered" ? "added" : "invited",
        customer: { id: data.id, name: data.business_name, gstin: data.gstin },
    };
}

function toDto(row, profile, stats) {
    const ordered = Number(stats?.orders_count || 0) > 0;
    const registered = !!row.customer_user_id;
    return {
        id: row.id,
        userId: row.customer_user_id || null,
        status: registered ? "active" : "invited",
        name: row.business_name,
        gstin: row.gstin || null,
        location: row.location || null,
        source: row.source,
        invitedAt: row.invited_at,
        addedAt: row.created_at,
        ordersCount: Number(stats?.orders_count || 0),
        totalSpent: Number(stats?.total_amount || 0),
        lastOrderAt: stats?.last_order_at || null,
        // contact details only once they have actually ordered from this seller
        contactName: ordered ? profile?.name || null : null,
        phone: ordered ? profile?.phone || null : null,
        email: ordered ? profile?.email || null : null,
        // credit (null for invited customers — no BBM account yet)
        credit: registered ? {
            id: row.credit_id || null,
            status: row.credit_status || "none", // none | pending | approved | rejected | revoked
            limit: Number(row.credit_limit || 0),
            used: Number(row.credit_used_effective || 0), // monthly reset already applied
            increasePending: !!row.credit_increase_pending,
            attention: !!row.credit_attention,
        } : null,
    };
}

// GET /api/seller/customers?q=&filter=all|active|invited|requests|credit&limit=&offset=&sync=0
export async function listCustomers(req, res) {
    try {
        const sellerId = req.sellerId;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const filter = FILTERS.includes(req.query.filter) ? req.query.filter : "all";
        const q = safeSearch(req.query.q);

        // realtime-triggered refreshes pass sync=0: the order/credit paths already sync.
        if (offset === 0 && req.query.sync !== "0") {
            const { error } = await supabase.rpc("sync_seller_customers_from_orders", { p_seller_id: sellerId });
            if (error) console.error("[customers] sync failed:", error.message);
        }

        let query = supabase.from("seller_customers_v").select("*", { count: "exact" }).eq("seller_id", sellerId);
        if (filter === "active") query = query.not("customer_user_id", "is", null);
        if (filter === "invited") query = query.is("customer_user_id", null);
        if (filter === "requests") query = query.eq("credit_attention", true);
        if (filter === "credit") query = query.eq("credit_status", "approved");
        if (q) query = query.or(`business_name.ilike.%${q}%,gstin.ilike.%${q}%`);
        const { data, count, error } = await query
            .order("credit_attention", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw error;
        const rows = data || [];

        const userIds = rows.map((r) => r.customer_user_id).filter(Boolean);
        const [profRes, statRes] = await Promise.all([
            userIds.length ? supabase.from("profiles").select("id, name, phone, email").in("id", userIds) : Promise.resolve({ data: [] }),
            userIds.length ? supabase.rpc("seller_customer_stats", { p_seller_id: sellerId, p_buyer_ids: userIds }) : Promise.resolve({ data: [] }),
        ]);
        if (statRes.error) console.error("[customers] stats failed:", statRes.error.message);
        const profById = new Map((profRes.data || []).map((p) => [p.id, p]));
        const statById = new Map((statRes.data || []).map((s) => [s.buyer_id, s]));

        const body = {
            success: true,
            items: rows.map((r) => toDto(r, profById.get(r.customer_user_id), statById.get(r.customer_user_id))),
            total: count ?? rows.length,
            hasMore: offset + rows.length < (count ?? 0),
        };
        if (offset === 0) {
            const head = () => supabase.from("seller_customers_v").select("id", { count: "exact", head: true }).eq("seller_id", sellerId);
            const [a, b, c, d, e] = await Promise.all([
                head(),
                head().not("customer_user_id", "is", null),
                head().is("customer_user_id", null),
                head().eq("credit_attention", true),
                head().eq("credit_status", "approved"),
            ]);
            body.counts = { all: a.count || 0, active: b.count || 0, invited: c.count || 0, requests: d.count || 0, credit: e.count || 0 };
        }
        res.json(body);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/seller/customers/lookup  { gstin }
export async function lookupCustomer(req, res) {
    try {
        const sellerUserId = await sellerUserIdOf(req.sellerId);
        const r = await resolveGstin(req.body?.gstin, sellerUserId);
        let existing = false;
        if (r.state === "registered" || r.state === "unregistered") {
            existing = !!(await findExisting(req.sellerId, { gstin: r.gstin, userId: r.userId }));
        }
        res.json({ success: true, state: r.state, gstin: r.gstin, name: r.name || null, location: r.location || null, existing, message: r.message || null });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/seller/customers  { gstin }
export async function addCustomer(req, res) {
    try {
        const sellerUserId = await sellerUserIdOf(req.sellerId);
        const out = await addOne(req.sellerId, sellerUserId, req.body?.gstin, "gst");
        if (["invalid", "self"].includes(out.result)) return res.status(400).json({ success: false, ...out });
        if (out.result === "error") return res.status(500).json({ success: false, ...out });
        if (out.result === "exists") return res.status(409).json({ success: false, ...out });
        res.json({
            success: true, ...out,
            message: out.result === "added" ? `${out.name} added to your customers.` : `${out.name} saved. Send them an invite to join BBM.`,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/seller/customers/bulk  { gstins: [] }
export async function bulkAddCustomers(req, res) {
    try {
        const list = req.body?.gstins;
        if (!Array.isArray(list) || !list.length) return res.status(400).json({ success: false, message: "Add at least one GST number." });
        const unique = [...new Set(list.map((g) => String(g || "").trim().toUpperCase()).filter(Boolean))];
        if (unique.length > MAX_BULK) return res.status(400).json({ success: false, message: `You can add up to ${MAX_BULK} GST numbers at a time.` });

        const sellerUserId = await sellerUserIdOf(req.sellerId);
        const results = await pool(unique, 4, (g) => addOne(req.sellerId, sellerUserId, g, "bulk").catch((e) => ({ gstin: g, result: "error", message: e.message })));
        const count = (k) => results.filter((r) => r.result === k).length;
        res.json({
            success: true, results,
            summary: { added: count("added"), invited: count("invited"), exists: count("exists"), failed: count("invalid") + count("self") + count("error") },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/seller/customers/:id/invite — records that an invite was sent
export async function markInvited(req, res) {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: "Customer not found." });
        const { data, error } = await supabase.from("seller_customers")
            .update({ invited_at: new Date().toISOString() })
            .eq("id", req.params.id).eq("seller_id", req.sellerId).is("customer_user_id", null)
            .select("id, invited_at").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "This customer has already joined or doesn't exist." });
        res.json({ success: true, invitedAt: data.invited_at });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// DELETE /api/seller/customers/:id — only customers who haven't joined yet
export async function removeCustomer(req, res) {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: "Customer not found." });
        const { data, error } = await supabase.from("seller_customers").delete()
            .eq("id", req.params.id).eq("seller_id", req.sellerId).is("customer_user_id", null).select("id").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ success: false, message: "Only customers who haven't joined yet can be removed." });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}