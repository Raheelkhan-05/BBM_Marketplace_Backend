// Salesperson endpoints. Everything is scoped to customers assigned to the signed-in salesperson.
// Credit and company revenue are deliberately never selected here.
import { supabase } from "../config/supabase.js";
import { logActivity } from "../services/team.service.js";
import { pingCustomersChanged } from "../services/salesSync.service.js";
import { resolveGstin, findExisting, addOne } from "./sellerCustomers.controller.js";

const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FILTERS = ["active", "invited"];
const safeSearch = (q) => String(q || "").replace(/[%_,()\\*]/g, " ").trim().slice(0, 80);
const cleanPhone = (v) => { let d = String(v || "").replace(/\D/g, ""); if (d.length > 10 && d.startsWith("91")) d = d.slice(2, 12); return d; };
const NOT_READY = { success: true, sellerReady: false, items: [], total: 0, hasMore: false, counts: { all: 0, active: 0, invited: 0 } };

function parseOptional(body) {
    const name = String(body?.name || "").trim().slice(0, 80) || null;
    const rawPhone = String(body?.phone || "").trim();
    const rawEmail = String(body?.email || "").trim().toLowerCase();
    let phone = null, email = null;
    if (rawPhone) {
        phone = cleanPhone(rawPhone);
        if (!PHONE_RE.test(phone)) return { error: "Enter a valid 10-digit mobile number, or leave it empty." };
    }
    if (rawEmail) {
        if (!EMAIL_RE.test(rawEmail)) return { error: "Enter a valid email address, or leave it empty." };
        email = rawEmail;
    }
    return { name, phone, email };
}

const COLS = "id, customer_user_id, gstin, business_name, location, created_at, contact_name, contact_phone, contact_email";
const mine = (req) => supabase.from("seller_customers");

function toDto(r, stat) {
    return {
        id: r.id, userId: r.customer_user_id || null, status: r.customer_user_id ? "active" : "invited",
        name: r.business_name, gstin: r.gstin || null, location: r.location || null, addedAt: r.created_at,
        contactName: r.contact_name || null, phone: r.contact_phone || null, email: r.contact_email || null,
        ordersCount: Number(stat?.orders_count || 0), lastOrderAt: stat?.last_order_at || null,
    };
}

async function statsFor(sellerId, userIds) {
    if (!userIds.length) return new Map();
    const { data, error } = await supabase.rpc("seller_customer_stats", { p_seller_id: sellerId, p_buyer_ids: userIds });
    if (error) console.error("[sales] stats failed:", error.message);
    return new Map((data || []).map((s) => [s.buyer_id, s]));
}

const head = (sellerId, actorId) =>
    supabase.from("seller_customers").select("id", { count: "exact", head: true }).eq("seller_id", sellerId).eq("assigned_to", actorId);

// GET /api/sales/customers?q=&filter=all|active|invited&limit=&offset=
export async function listMyCustomers(req, res) {
    try {
        const { sellerId, actorId } = req.sales;
        if (!sellerId) return res.json(NOT_READY);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const filter = FILTERS.includes(req.query.filter) ? req.query.filter : "all";
        const q = safeSearch(req.query.q);

        let query = mine(req).select(COLS, { count: "exact" }).eq("seller_id", sellerId).eq("assigned_to", actorId);
        if (filter === "active") query = query.not("customer_user_id", "is", null);
        if (filter === "invited") query = query.is("customer_user_id", null);
        if (q) query = query.or(`business_name.ilike.%${q}%,gstin.ilike.%${q}%,contact_name.ilike.%${q}%`);
        const { data, count, error } = await query
            .order("created_at", { ascending: false }).order("id", { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw error;
        const rows = data || [];

        const stats = await statsFor(sellerId, rows.map((r) => r.customer_user_id).filter(Boolean));
        const body = {
            success: true, sellerReady: true,
            items: rows.map((r) => toDto(r, stats.get(r.customer_user_id))),
            total: count ?? rows.length, hasMore: offset + rows.length < (count ?? 0),
        };
        if (offset === 0) {
            const [a, b, c] = await Promise.all([
                head(sellerId, actorId), head(sellerId, actorId).not("customer_user_id", "is", null), head(sellerId, actorId).is("customer_user_id", null),
            ]);
            body.counts = { all: a.count || 0, active: b.count || 0, invited: c.count || 0 };
        }
        res.json(body);
    } catch (e) {
        console.error("[sales] list failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't load your customers." });
    }
}

// GET /api/sales/summary
export async function getSummary(req, res) {
    try {
        const { sellerId, actorId } = req.sales;
        if (!sellerId) return res.json({ success: true, sellerReady: false, counts: { all: 0, active: 0, invited: 0, thisMonth: 0 }, orders: 0, recent: [] });

        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const [a, b, c, m, ids, recent] = await Promise.all([
            head(sellerId, actorId), head(sellerId, actorId).not("customer_user_id", "is", null), head(sellerId, actorId).is("customer_user_id", null),
            head(sellerId, actorId).gte("created_at", monthStart.toISOString()),
            supabase.from("seller_customers").select("customer_user_id").eq("seller_id", sellerId).eq("assigned_to", actorId).not("customer_user_id", "is", null).limit(1000),
            supabase.from("seller_customers").select(COLS).eq("seller_id", sellerId).eq("assigned_to", actorId).order("created_at", { ascending: false }).limit(5),
        ]);
        const stats = await statsFor(sellerId, (ids.data || []).map((r) => r.customer_user_id));
        let orders = 0; stats.forEach((s) => { orders += Number(s.orders_count || 0); });

        res.json({
            success: true, sellerReady: true,
            counts: { all: a.count || 0, active: b.count || 0, invited: c.count || 0, thisMonth: m.count || 0 },
            orders, recent: (recent.data || []).map((r) => toDto(r, stats.get(r.customer_user_id))),
        });
    } catch (e) {
        console.error("[sales] summary failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't load your dashboard." });
    }
}

// POST /api/sales/customers/lookup { gstin }
export async function lookupCustomer(req, res) {
    try {
        const { sellerId, companyId, actorId } = req.sales;
        if (!sellerId) return res.status(409).json({ success: false, message: "Your company isn't set up to sell yet." });
        const r = await resolveGstin(req.body?.gstin, companyId);
        let existing = null;
        if (r.state === "registered" || r.state === "unregistered") {
            existing = await findExisting(sellerId, { gstin: r.gstin, userId: r.userId });
        }
        res.json({
            success: true, state: r.state, gstin: r.gstin, name: r.name || null, location: r.location || null,
            existing: !!existing, existingMine: !!existing && existing.assigned_to === actorId, message: r.message || null,
        });
    } catch (e) {
        console.error("[sales] lookup failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't check this GST number. Try again." });
    }
}

// POST /api/sales/customers { gstin, name?, phone?, email? }
export async function addCustomer(req, res) {
    try {
        const { sellerId, companyId, actorId, teamId } = req.sales;
        if (!sellerId) return res.status(409).json({ success: false, message: "Your company isn't set up to sell yet." });
        const c = parseOptional(req.body);
        if (c.error) return res.status(400).json({ success: false, message: c.error });
        if (!c.phone && !c.email) return res.status(400).json({ success: false, message: "Enter a mobile number or an email address." });

        const out = await addOne(sellerId, companyId, req.body?.gstin, "gst", {
            assigned_to: actorId, assigned_by: actorId, assigned_kind: "self", assigned_at: new Date().toISOString(),
            contact_name: c.name, contact_phone: c.phone, contact_email: c.email,
        });
        if (["invalid", "self"].includes(out.result)) return res.status(400).json({ success: false, message: out.message });
        if (out.result === "error") return res.status(500).json({ success: false, message: out.message });
        if (out.result === "exists") {
            return res.status(409).json({
                success: false,
                message: out.assignedTo === actorId ? "You've already added this customer." : "This business is already in your company's customer list.",
            });
        }

        await pingCustomersChanged(companyId, [actorId]);
        await logActivity({
            teamId, actorId, actorRole: "member", category: "sales", action: "sales.customer_added",
            label: `Added customer ${out.name}`, entityType: "customer", entityId: out.customer?.id,
            meta: { link: "/sell/customers", gstin: out.gstin },
        });
        res.json({
            success: true, result: out.result, name: out.name,
            message: out.result === "added" ? `${out.name} added to your customers.` : `${out.name} saved. They aren't on BBM yet.`,
        });
    } catch (e) {
        console.error("[sales] add failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't add this customer. Try again." });
    }
}