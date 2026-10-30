// controllers/sellerCustomers.controller.js — a seller's customers
// + salesperson assignment (admins only see/set it). resolveGstin / findExisting / addOne are exported for /api/sales.
import { supabase, supabaseAdmin } from "../config/supabase.js";
import { validateGSTIN, fetchGstinDetails } from "../services/gst.service.js";
import { getTeamContext, logActivity } from "../services/team.service.js";
import { pingCustomersChanged } from "../services/salesSync.service.js";

const MAX_BULK = 100;
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const safeSearch = (q) => String(q || "").replace(/[%_,()\\*]/g, " ").trim().slice(0, 80);
const nameOf = (bp) => bp?.display_name?.trim() || bp?.trade_name?.trim() || bp?.legal_name?.trim() || null;
const placeOf = (bp) => [bp?.district, bp?.state].filter(Boolean).join(", ") || null;
const FILTERS = ["active", "invited", "requests", "credit"];

async function viewerOf(req) {
    const actorId = req.actor?.id || req.user.id;
    const ctx = await getTeamContext(actorId);
    return { actorId, ctx, isAdmin: ctx.isAdmin };
}

async function sellerUserIdOf(sellerId) {
    const { data } = await supabase.from("seller_profiles").select("user_id").eq("id", sellerId).maybeSingle();
    return data?.user_id || null;
}

export async function resolveGstin(raw, sellerUserId) {
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

export async function findExisting(sellerId, { gstin, userId }) {
    let q = supabase.from("seller_customers").select("id, customer_user_id, assigned_to").eq("seller_id", sellerId);
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

// `extra` = extra columns for the new row (assignment + contact when a salesperson adds).
export async function addOne(sellerId, sellerUserId, rawGstin, source, extra = {}) {
    const r = await resolveGstin(rawGstin, sellerUserId);
    if (r.state === "invalid" || r.state === "self") return { gstin: r.gstin, result: r.state, message: r.message };

    const existing = await findExisting(sellerId, { gstin: r.gstin, userId: r.userId });
    if (existing) {
        return { gstin: r.gstin, name: r.name, result: "exists", assignedTo: existing.assigned_to || null, customer: { id: existing.id }, message: "Already in your customers." };
    }

    const { data, error } = await supabase.from("seller_customers").insert({
        seller_id: sellerId,
        customer_user_id: r.state === "registered" ? r.userId : null,
        gstin: r.gstin, business_name: r.name, location: r.location, source,
        ...extra,
    }).select("id, business_name, gstin, customer_user_id").single();
    if (error) {
        if (error.code === "23505") return { gstin: r.gstin, name: r.name, result: "exists", message: "Already in your customers." };
        console.error("[customers] insert failed:", error.message);
        return { gstin: r.gstin, name: r.name, result: "error", message: "Couldn't save this customer." };
    }
    return {
        gstin: r.gstin, name: r.name, location: r.location,
        userId: data.customer_user_id || null,
        result: r.state === "registered" ? "added" : "invited",
        customer: { id: data.id, name: data.business_name, gstin: data.gstin },
    };
}

// asg = { names: Map } only for admins. Everyone else never receives assignment data.
function toDto(row, profile, stats, asg) {
    const ordered = Number(stats?.orders_count || 0) > 0;
    const registered = !!row.customer_user_id;
    const dto = {
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
        contactName: ordered ? profile?.name || null : null,
        phone: ordered ? profile?.phone || null : null,
        email: ordered ? profile?.email || null : null,
        credit: registered ? {
            id: row.credit_id || null,
            status: row.credit_status || "none",
            limit: Number(row.credit_limit || 0),
            used: Number(row.credit_used_effective || 0),
            increasePending: !!row.credit_increase_pending,
            attention: !!row.credit_attention,
        } : null,
    };
    if (asg) {
        dto.assignment = row.assigned_to ? {
            userId: row.assigned_to,
            name: asg.names.get(row.assigned_to) || "Salesperson",
            kind: row.assigned_kind === "self" ? "self" : "admin",
            at: row.assigned_at || null,
        } : null;
        if (row.contact_name || row.contact_phone || row.contact_email) {
            dto.savedContact = { name: row.contact_name || null, phone: row.contact_phone || null, email: row.contact_email || null };
        }
    }
    return dto;
}

// GET /api/seller/customers?q=&filter=&assignee=all|unassigned|<userId>&limit=&offset=&sync=0
export async function listCustomers(req, res) {
    try {
        const sellerId = req.sellerId;
        const { isAdmin } = await viewerOf(req);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const filter = FILTERS.includes(req.query.filter) ? req.query.filter : "all";
        const q = safeSearch(req.query.q);
        const assignee = String(req.query.assignee || "");

        if (offset === 0 && req.query.sync !== "0") {
            const { error } = await supabase.rpc("sync_seller_customers_from_orders", { p_seller_id: sellerId });
            if (error) console.error("[customers] sync failed:", error.message);
        }

        let query = supabase.from("seller_customers_v").select("*", { count: "exact" }).eq("seller_id", sellerId);
        if (filter === "active") query = query.not("customer_user_id", "is", null);
        if (filter === "invited") query = query.is("customer_user_id", null);
        if (filter === "requests") query = query.eq("credit_attention", true);
        if (filter === "credit") query = query.eq("credit_status", "approved");
        if (isAdmin && assignee === "unassigned") query = query.is("assigned_to", null);
        else if (isAdmin && isUuid(assignee)) query = query.eq("assigned_to", assignee);
        if (q) query = query.or(`business_name.ilike.%${q}%,gstin.ilike.%${q}%`);
        const { data, count, error } = await query
            .order("credit_attention", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw error;
        const rows = data || [];

        const userIds = rows.map((r) => r.customer_user_id).filter(Boolean);
        const assigneeIds = isAdmin ? [...new Set(rows.map((r) => r.assigned_to).filter(Boolean))] : [];
        const [profRes, statRes, asgRes] = await Promise.all([
            userIds.length ? supabase.from("profiles").select("id, name, phone, email").in("id", userIds) : Promise.resolve({ data: [] }),
            userIds.length ? supabase.rpc("seller_customer_stats", { p_seller_id: sellerId, p_buyer_ids: userIds }) : Promise.resolve({ data: [] }),
            assigneeIds.length ? supabaseAdmin.from("profiles").select("id, name, email, phone").in("id", assigneeIds) : Promise.resolve({ data: [] }),
        ]);
        if (statRes.error) console.error("[customers] stats failed:", statRes.error.message);
        const profById = new Map((profRes.data || []).map((p) => [p.id, p]));
        const statById = new Map((statRes.data || []).map((s) => [s.buyer_id, s]));
        const asg = isAdmin ? { names: new Map((asgRes.data || []).map((p) => [p.id, p.name || p.email || p.phone])) } : null;

        const body = {
            success: true,
            items: rows.map((r) => toDto(r, profById.get(r.customer_user_id), statById.get(r.customer_user_id), asg)),
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

// GET /api/seller/customers/salespeople — admins only
export async function listSalespeople(req, res) {
    try {
        const { ctx, isAdmin } = await viewerOf(req);
        if (!isAdmin) return res.status(403).json({ success: false, message: "Only your team admin can do this." });
        if (!ctx.teamId) return res.json({ success: true, items: [] });
        const { data: rows, error } = await supabaseAdmin.from("team_members").select("user_id").eq("team_id", ctx.teamId).eq("role", "salesperson");
        if (error) throw error;
        const ids = (rows || []).map((r) => r.user_id);
        const { data: profs } = ids.length ? await supabaseAdmin.from("profiles").select("id, name, email, phone").in("id", ids) : { data: [] };
        const items = (profs || [])
            .map((p) => ({ userId: p.id, name: p.name || p.email || p.phone || "Salesperson" }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, items });
    } catch (e) {
        res.status(500).json({ success: false, message: "Couldn't load your salespeople." });
    }
}

// PUT /api/seller/customers/:id/assign { salespersonId: uuid | null } — admins only
export async function assignCustomer(req, res) {
    try {
        const { actorId, ctx, isAdmin } = await viewerOf(req);
        if (!isAdmin) return res.status(403).json({ success: false, message: "Only your team admin can assign customers." });
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: "Customer not found." });

        const sid = req.body?.salespersonId ?? null;
        if (sid !== null && !isUuid(sid)) return res.status(400).json({ success: false, message: "Choose a valid salesperson." });

        const { data: row } = await supabase.from("seller_customers").select("id, business_name, assigned_to")
            .eq("id", req.params.id).eq("seller_id", req.sellerId).maybeSingle();
        if (!row) return res.status(404).json({ success: false, message: "Customer not found." });

        let sp = null;
        if (sid) {
            const { data: m } = await supabaseAdmin.from("team_members").select("user_id, role")
                .eq("team_id", ctx.teamId || "00000000-0000-0000-0000-000000000000").eq("user_id", sid).maybeSingle();
            if (!m || m.role !== "salesperson") return res.status(400).json({ success: false, message: "That person isn't a salesperson on your team." });
            const { data: p } = await supabaseAdmin.from("profiles").select("name, email, phone").eq("id", sid).maybeSingle();
            sp = p?.name || p?.email || p?.phone || "Salesperson";
        }

        const patch = sid
            ? { assigned_to: sid, assigned_by: actorId, assigned_kind: "admin", assigned_at: new Date().toISOString() }
            : { assigned_to: null, assigned_by: null, assigned_kind: null, assigned_at: null };
        const { error } = await supabase.from("seller_customers").update(patch).eq("id", row.id).eq("seller_id", req.sellerId);
        if (error) throw error;

        await pingCustomersChanged(req.user.id, [sid, row.assigned_to]);
        await logActivity({
            teamId: ctx.teamId, actorId, actorRole: "admin", category: "sales",
            action: sid ? "sales.customer_assigned" : "sales.customer_unassigned",
            label: sid ? `Assigned ${row.business_name} to ${sp}` : `Unassigned ${row.business_name}`,
            entityType: "customer", entityId: row.id, meta: { link: "/sell/customers" },
        });
        res.json({ success: true, assignment: sid ? { userId: sid, name: sp, kind: "admin" } : null });
    } catch (e) {
        console.error("[customers] assign failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't update the assignment. Try again." });
    }
}

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

export async function removeCustomer(req, res) {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: "Customer not found." });
        const { data, error } = await supabase.from("seller_customers").delete()
            .eq("id", req.params.id).eq("seller_id", req.sellerId).is("customer_user_id", null).select("id, assigned_to").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ success: false, message: "Only customers who haven't joined yet can be removed." });
        if (data.assigned_to) pingCustomersChanged(req.user.id, [data.assigned_to]).catch(() => { });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}