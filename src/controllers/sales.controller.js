// Salesperson endpoints. Everything is scoped to customers assigned to the signed-in salesperson.
// Credit and company revenue are deliberately never selected here.
import { supabase } from "../config/supabase.js";
import { logActivity } from "../services/team.service.js";
import { pingCustomersChanged } from "../services/salesSync.service.js";
import { isUuid } from "../services/rfqValidation.js";
import { resolveGstin, findExisting, addOne, backfillAddresses } from "./sellerCustomers.controller.js";
import {
    loadContacts, contactDto, parseContact, parseContactList, saveContact, updateContact, deleteContact, addressText, MAX_CONTACTS,
} from "../services/customerContacts.service.js";

const safeSearch = (q) => String(q || "").replace(/[%_,()\\*]/g, " ").trim().slice(0, 80);
const NOT_READY = { success: true, sellerReady: false, items: [], total: 0, hasMore: false, counts: { all: 0, active: 0, invited: 0 } };

const COLS = "id, customer_user_id, gstin, business_name, location, created_at, address, city, state, pincode";

// Old single-contact fields (contactName / phone / email) = the PRIMARY contact, so older screens keep working.
function toDto(r, stat, contacts = []) {
    const list = contacts.map(contactDto);
    const p = list[0] || null;
    return {
        id: r.id, userId: r.customer_user_id || null, status: r.customer_user_id ? "active" : "invited",
        name: r.business_name, gstin: r.gstin || null, location: r.location || null,
        address: r.address || null, city: r.city || null, state: r.state || null, pincode: r.pincode || null,
        addressLine: addressText(r) || null,
        addedAt: r.created_at,
        contacts: list,
        contactName: p?.name || null, phone: p?.phone || null, email: p?.email || null,
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
        const { sellerId, companyId, actorId } = req.sales;
        if (!sellerId) return res.json(NOT_READY);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const filter = ["active", "invited"].includes(req.query.filter) ? req.query.filter : "all";
        const q = safeSearch(req.query.q);

        let query = supabase.from("seller_customers").select(COLS, { count: "exact" }).eq("seller_id", sellerId).eq("assigned_to", actorId);
        if (filter === "active") query = query.not("customer_user_id", "is", null);
        if (filter === "invited") query = query.is("customer_user_id", null);
        if (q) {
            // also match any of the customer's contacts (name, mobile, email)
            const { data: hit } = await supabase.from("seller_customer_contacts").select("customer_id")
                .eq("seller_id", sellerId).or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`).limit(300);
            const ids = [...new Set((hit || []).map((h) => h.customer_id))];
            query = query.or(`business_name.ilike.%${q}%,gstin.ilike.%${q}%${ids.length ? `,id.in.(${ids.join(",")})` : ""}`);
        }
        const { data, count, error } = await query
            .order("created_at", { ascending: false }).order("id", { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw error;
        const rows = data || [];

        const [stats, contactMap] = await Promise.all([
            statsFor(sellerId, rows.map((r) => r.customer_user_id).filter(Boolean)),
            loadContacts(rows.map((r) => r.id)),
        ]);
        backfillAddresses({ sellerId, companyId, rows, pingIds: [actorId] });

        const body = {
            success: true, sellerReady: true,
            items: rows.map((r) => toDto(r, stats.get(r.customer_user_id), contactMap.get(r.id))),
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
        const recentRows = recent.data || [];
        const [stats, contactMap] = await Promise.all([
            statsFor(sellerId, (ids.data || []).map((r) => r.customer_user_id)),
            loadContacts(recentRows.map((r) => r.id)),
        ]);
        let orders = 0; stats.forEach((s) => { orders += Number(s.orders_count || 0); });

        res.json({
            success: true, sellerReady: true,
            counts: { all: a.count || 0, active: b.count || 0, invited: c.count || 0, thisMonth: m.count || 0 },
            orders, recent: recentRows.map((r) => toDto(r, stats.get(r.customer_user_id), contactMap.get(r.id))),
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
            addressLine: r.addr ? addressText({ ...r.addr, location: r.location }) || null : null,
            existing: !!existing, existingMine: !!existing && existing.assigned_to === actorId, message: r.message || null,
        });
    } catch (e) {
        console.error("[sales] lookup failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't check this GST number. Try again." });
    }
}

const hasText = (c) => ["name", "phone", "email"].some((k) => String(c?.[k] || "").trim());

// POST /api/sales/customers { gstin, contacts: [{ name?, phone?, email? }] }   (old form { name, phone, email } still works)
export async function addCustomer(req, res) {
    try {
        const { sellerId, companyId, actorId, teamId } = req.sales;
        if (!sellerId) return res.status(409).json({ success: false, message: "Your company isn't set up to sell yet." });

        const raw = Array.isArray(req.body?.contacts) ? req.body.contacts : [{ name: req.body?.name, phone: req.body?.phone, email: req.body?.email }];
        const parsed = parseContactList(raw.filter(hasText));
        if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
        if (!parsed.list.length) return res.status(400).json({ success: false, message: "Add at least one contact with a mobile number or an email." });

        const out = await addOne(sellerId, companyId, req.body?.gstin, "gst", {
            assigned_to: actorId, assigned_by: actorId, assigned_kind: "self", assigned_at: new Date().toISOString(),
            contacts: parsed.list,
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

// ---------------------------------------------------------------- contacts of one customer
async function ownCustomer(req, res) {
    const { sellerId, actorId } = req.sales || {};
    if (!sellerId) { res.status(409).json({ success: false, message: "Your company isn't set up to sell yet." }); return null; }
    const id = req.params.id;
    if (!isUuid(id)) { res.status(404).json({ success: false, message: "Customer not found." }); return null; }
    const { data, error } = await supabase.from("seller_customers").select("id")
        .eq("id", id).eq("seller_id", sellerId).eq("assigned_to", actorId).maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ success: false, message: "Customer not found." }); return null; }
    return data;
}

const contactsOf = async (customerId) => ((await loadContacts([customerId])).get(customerId) || []).map(contactDto);
const refreshed = (req) => Promise.resolve(pingCustomersChanged(req.sales.companyId, [req.sales.actorId])).catch(() => { /* best effort */ });

// POST /api/sales/customers/:id/contacts { name?, phone?, email?, makePrimary? }
export async function addCustomerContact(req, res) {
    try {
        const own = await ownCustomer(req, res); if (!own) return;
        const p = parseContact(req.body);
        if (p.error) return res.status(400).json({ success: false, message: p.error });
        const out = await saveContact({ sellerId: req.sales.sellerId, customerId: own.id, actorId: req.sales.actorId, contact: p, makePrimary: req.body?.makePrimary === true });
        if (out.error) return res.status(409).json({ success: false, message: out.error });
        refreshed(req);
        res.json({
            success: true, contact: contactDto(out.contact), contacts: await contactsOf(own.id),
            message: out.created ? "Contact added." : "This contact was already saved.",
        });
    } catch (e) {
        console.error("[sales] add contact failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't save the contact. Try again." });
    }
}

// PATCH /api/sales/customers/:id/contacts/:contactId { name?, phone?, email?, isPrimary? }
export async function updateCustomerContact(req, res) {
    try {
        const own = await ownCustomer(req, res); if (!own) return;
        if (!isUuid(req.params.contactId)) return res.status(404).json({ success: false, message: "Contact not found." });
        const out = await updateContact({ sellerId: req.sales.sellerId, customerId: own.id, contactId: req.params.contactId, body: req.body || {} });
        if (out.error) return res.status(out.status || 400).json({ success: false, message: out.error });
        refreshed(req);
        res.json({ success: true, contact: contactDto(out.contact), contacts: await contactsOf(own.id), message: "Contact saved." });
    } catch (e) {
        console.error("[sales] update contact failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't save the contact. Try again." });
    }
}

// DELETE /api/sales/customers/:id/contacts/:contactId
export async function deleteCustomerContact(req, res) {
    try {
        const own = await ownCustomer(req, res); if (!own) return;
        if (!isUuid(req.params.contactId)) return res.status(404).json({ success: false, message: "Contact not found." });
        const out = await deleteContact({ sellerId: req.sales.sellerId, customerId: own.id, contactId: req.params.contactId });
        if (out.error) return res.status(out.status || 400).json({ success: false, message: out.error });
        refreshed(req);
        res.json({ success: true, contacts: await contactsOf(own.id), message: "Contact removed." });
    } catch (e) {
        console.error("[sales] delete contact failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't remove the contact. Try again." });
    }
}

export { MAX_CONTACTS };