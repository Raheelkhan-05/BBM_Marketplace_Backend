// controllers/adminRfq.controller.js
import { supabase } from "../config/supabase.js";
import { sanitizeEnquiry, toDto, isUuid, RFQ_STATUSES } from "../services/rfqValidation.js";
import { notifyBuyerRfqApproved, notifyBuyerRfqRejected } from "../services/rfqNotify.js";

const EMBED = "*, hs_categories(id, name), hs_subcategories(id, name), hs_generic_products(id, name)";
const safeSearch = (q) => String(q || "").replace(/[%_,()\\]/g, " ").trim().slice(0, 80);
const HIERARCHY_KEYS = ["genericProductId", "subcategoryId", "categoryId"];

async function requireHierarchySetting() {
    const { data } = await supabase.from("rfq_settings").select("require_hierarchy").eq("id", true).maybeSingle();
    return !!data?.require_hierarchy;
}

async function checkId(table, id, extraCol) {
    const { data, error } = await supabase
        .from(table).select(`id${extraCol ? `, ${extraCol}` : ""}`).eq("id", id).is("deleted_at", null).maybeSingle();
    if (error) return { error: error.code === "22P02" ? "Invalid id." : error.message, code: error.code === "22P02" ? 400 : 500 };
    if (!data) return { error: "Selected catalog entry wasn't found.", code: 400 };
    return { data };
}

// Derives the whole chain from the most specific level supplied, so it can never be inconsistent.
async function resolveHierarchy({ genericProductId, subcategoryId, categoryId }) {
    let gp = genericProductId || null;
    let sub = subcategoryId || null;
    let cat = categoryId || null;

    if (gp) {
        const r = await checkId("hs_generic_products", gp, "subcategory_id");
        if (r.error) return r;
        sub = r.data.subcategory_id || sub;
    }
    if (sub) {
        const r = await checkId("hs_subcategories", sub, "category_id");
        if (r.error) return r;
        cat = r.data.category_id || cat;
    }
    if (cat) {
        const r = await checkId("hs_categories", cat);
        if (r.error) return r;
    }
    return { ids: { generic_product_id: gp, subcategory_id: sub, category_id: cat } };
}

const fetchOne = (id) => supabase.from("rfq_enquiries").select(EMBED).eq("id", id).maybeSingle();

// GET /api/admin/rfq/settings
export async function getRfqSettings(req, res) {
    try {
        res.json({ success: true, requireHierarchy: await requireHierarchySetting() });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// PUT /api/admin/rfq/settings { requireHierarchy }
export async function updateRfqSettings(req, res) {
    try {
        const value = req.body?.requireHierarchy === true;
        const { error } = await supabase
            .from("rfq_settings").upsert({ id: true, require_hierarchy: value, updated_at: new Date().toISOString() });
        if (error) throw error;
        res.json({ success: true, requireHierarchy: value });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// GET /api/admin/rfq?status=pending_review|approved|rejected|closed|all&q=&limit=&offset=
export async function adminListEnquiries(req, res) {
    try {
        const status = RFQ_STATUSES.includes(req.query.status) ? req.query.status : null;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const q = safeSearch(req.query.q);

        let query = supabase.from("rfq_enquiries").select(EMBED, { count: "exact" })
            .order("created_at", { ascending: status === "pending_review" }); // oldest first in the review queue
        if (status) query = query.eq("status", status);
        if (q) query = query.ilike("product_name", `%${q}%`);

        const countFor = (s) => supabase.from("rfq_enquiries").select("id", { count: "exact", head: true }).eq("status", s);
        const [list, ...counts] = await Promise.all([query.range(offset, offset + limit - 1), ...RFQ_STATUSES.map(countFor)]);
        if (list.error) throw list.error;

        res.json({
            success: true,
            items: (list.data || []).map((r) => toDto(r, { admin: true })),
            total: list.count ?? 0,
            hasMore: offset + (list.data?.length || 0) < (list.count ?? 0),
            counts: Object.fromEntries(RFQ_STATUSES.map((s, i) => [s, counts[i].count || 0])),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// GET /api/admin/rfq/:id
export async function adminGetEnquiry(req, res) {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: "Not found." });
        const { data, error } = await fetchOne(req.params.id);
        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Not found." });
        res.json({ success: true, enquiry: toDto(data, { admin: true }) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// Builds the DB update from { edits?, genericProductId?, subcategoryId?, categoryId? }.
async function buildUpdate(body, existing) {
    const update = {};
    if (body.edits) {
        const v = sanitizeEnquiry(body.edits);
        if (!v.ok) return { error: v.message, code: 400 };
        Object.assign(update, v.row);
    }
    if (HIERARCHY_KEYS.some((k) => k in body)) {
        const h = await resolveHierarchy(body);
        if (h.error) return h;
        Object.assign(update, h.ids);
    }
    return { update, hierarchy: { ...{ generic_product_id: existing.generic_product_id, category_id: existing.category_id, subcategory_id: existing.subcategory_id }, ...update } };
}

// PATCH /api/admin/rfq/:id — save edits/hierarchy without changing status
export async function adminUpdateEnquiry(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Not found." });
        const { data: existing, error: exErr } = await fetchOne(id);
        if (exErr) throw exErr;
        if (!existing) return res.status(404).json({ success: false, message: "Not found." });

        const b = await buildUpdate(req.body || {}, existing);
        if (b.error) return res.status(b.code).json({ success: false, message: b.error });
        if (!Object.keys(b.update).length) return res.status(400).json({ success: false, message: "Nothing to update." });

        const { error } = await supabase.from("rfq_enquiries").update(b.update).eq("id", id);
        if (error) throw error;
        const { data } = await fetchOne(id);
        res.json({ success: true, enquiry: toDto(data, { admin: true }) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/admin/rfq/:id/approve { edits?, hierarchy ids?, note? }
export async function adminApproveEnquiry(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Not found." });
        const { data: existing, error: exErr } = await fetchOne(id);
        if (exErr) throw exErr;
        if (!existing) return res.status(404).json({ success: false, message: "Not found." });
        if (!["pending_review", "rejected"].includes(existing.status)) {
            return res.status(409).json({ success: false, message: "This enquiry can't be approved from its current status." });
        }

        const b = await buildUpdate(req.body || {}, existing);
        if (b.error) return res.status(b.code).json({ success: false, message: b.error });

        if (await requireHierarchySetting()) {
            if (!b.hierarchy.generic_product_id || !b.hierarchy.subcategory_id || !b.hierarchy.category_id) {
                return res.status(400).json({ success: false, message: "Map this enquiry to a Category / Subcategory / Generic Product before approving." });
            }
        }

        const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";
        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from("rfq_enquiries")
            .update({
                ...b.update,
                status: "approved",
                review_note: note || null,
                reviewed_at: now,
                reviewed_by: req.user.id,
                published_at: now,
            })
            .eq("id", id)
            .in("status", ["pending_review", "rejected"]) // guards against two admins acting at once
            .select("id, buyer_id, product_name")
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ success: false, message: "Someone else just reviewed this enquiry." });

        notifyBuyerRfqApproved(data.buyer_id, data.product_name);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/admin/rfq/:id/reject { reason }
export async function adminRejectEnquiry(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Not found." });
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
        if (!reason) return res.status(400).json({ success: false, message: "A rejection reason is required." });

        const { data, error } = await supabase
            .from("rfq_enquiries")
            .update({
                status: "rejected",
                review_note: reason,
                reviewed_at: new Date().toISOString(),
                reviewed_by: req.user.id,
                published_at: null,
            })
            .eq("id", id)
            .in("status", ["pending_review", "approved"])
            .select("id, buyer_id, product_name")
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ success: false, message: "This enquiry can't be rejected from its current status." });

        notifyBuyerRfqRejected(data.buyer_id, data.product_name, reason);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}