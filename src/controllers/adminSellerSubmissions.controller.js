import { supabase } from "../config/supabase.js";
import { notifyUser } from "../services/notifications.service.js";

// Shared select fragment — pulls product_name/brand_name/image from the
// brand item (hs_generic_product_brands) via generic_product_brand_id,
// since seller_product_submissions no longer carries those directly.
const BRAND_EMBED = `
    id, price, moq, unit, lead_time,
    review_status, rejection_reason, created_at,
    seller:seller_profiles(id, display_name, user_id),
    brand:hs_generic_product_brands(
        id, name, brand_name, image, images,
        generic_product:hs_generic_products(id, name,
            subcategory:hs_subcategories(id, name, category:hs_categories(id, name))
        )
    )
`;

// Normalizes a row so the frontend (which expects product_name/brand_name/
// image/generic_product directly on the item) keeps working unchanged,
// regardless of whether the row uses the new brand-linked shape or an
// older row that still has its own product_name/brand_name/image set.
function normalizeSubmission(row) {
    if (!row) return row;
    const brand = row.brand || {};
    return {
        ...row,
        product_name: row.product_name || brand.name || null,
        brand_name: row.brand_name || brand.brand_name || null,
        image: row.image || brand.image || null,
        images: (brand.images && brand.images.length ? brand.images : (row.image || brand.image ? [row.image || brand.image] : [])),
        generic_product: row.generic_product || brand.generic_product || null,
    };
}

// GET /api/admin/seller-submissions?status=pending_review&q=
export async function listSellerSubmissions(req, res) {
    const { status = "pending_review", q = "" } = req.query;
    let query = supabase
        .from("seller_product_submissions")
        .select(BRAND_EMBED)
        .order("created_at", { ascending: false })
        .limit(200);
    if (status !== "all") query = query.eq("review_status", status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    let items = (data || []).map(normalizeSubmission);

    // Filtering by product/brand name now has to happen after the join
    // (can't ilike across a related table in one PostgREST query), so we
    // filter in memory once rows are normalized.
    if (q.trim()) {
        const term = q.trim().toLowerCase();
        items = items.filter(
            (it) =>
                it.product_name?.toLowerCase().includes(term) ||
                it.brand_name?.toLowerCase().includes(term)
        );
    }

    res.json({ success: true, items });
}

// GET /api/admin/seller-submissions/:id
export async function getSellerSubmission(req, res) {
    const { id } = req.params;
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(`*, ${BRAND_EMBED}`)
        .eq("id", id)
        .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, submission: normalizeSubmission(data) });
}

// PATCH /api/admin/seller-submissions/:id
// Admin fixes typos, a wrong price, or swaps a bad photo before/after
// review, without forcing the seller to resubmit. Two things get
// touched: the submission's own commercial terms (price/moq/unit/lead
// time/cover image), and — since product_name/brand_name/images are the
// brand item's identity, not the submission's — hs_generic_product_brands
// itself when those fields are provided. review_status is intentionally
// never touched here; use approve/reject for that.
export async function updateSellerSubmission(req, res) {
    const { id } = req.params;
    const body = req.body || {};

    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("id, generic_product_brand_id")
        .eq("id", id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    const submissionUpdate = {};
    if (body.price !== undefined) submissionUpdate.price = Number(body.price);
    if (body.moq !== undefined) submissionUpdate.moq = Number(body.moq);
    if (body.unit !== undefined) submissionUpdate.unit = body.unit;
    if (body.leadTime !== undefined) submissionUpdate.lead_time = body.leadTime.trim();

    const brandUpdate = {};
    if (body.productName !== undefined) brandUpdate.name = body.productName.trim();
    if (body.brandName !== undefined) brandUpdate.brand_name = body.brandName.trim();
    if (Array.isArray(body.images)) {
        brandUpdate.images = body.images;
        brandUpdate.image = body.images[0] || null;
        submissionUpdate.image = body.images[0] || null; // keep the submission's cover in sync too
    }

    if (!Object.keys(submissionUpdate).length && !Object.keys(brandUpdate).length) {
        return res.status(400).json({ success: false, message: "No editable fields provided." });
    }

    if (Object.keys(submissionUpdate).length) {
        const { error } = await supabase.from("seller_product_submissions").update(submissionUpdate).eq("id", id);
        if (error) return res.status(500).json({ success: false, message: error.message });
    }
    if (Object.keys(brandUpdate).length && existing.generic_product_brand_id) {
        const { error } = await supabase.from("hs_generic_product_brands").update(brandUpdate).eq("id", existing.generic_product_brand_id);
        if (error) {
            if (error.code === "23505") return res.status(409).json({ success: false, message: "That product + brand name already exists." });
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(`*, ${BRAND_EMBED}`)
        .eq("id", id)
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, submission: normalizeSubmission(data) });
}

// POST /api/admin/seller-submissions/:id/approve
export async function approveSellerSubmission(req, res) {
    const { id } = req.params;
    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("id, product_name, generic_product_brand_id, seller:seller_profiles(user_id), brand:hs_generic_product_brands(name, review_status)")
        .eq("id", id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    const { data, error } = await supabase
        .from("seller_product_submissions")
        .update({ review_status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: req.user.id, rejection_reason: null })
        .eq("id", id)
        .select()
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    // Approving a submission is the only path that brought this brand
    // item into existence when the seller proposed a new one, so approve
    // the brand item alongside it if it's still sitting pending — without
    // this, buyers never see the product on the catalog-search hierarchy
    // (which only reads approved rows from hs_generic_product_brands).
    if (existing.generic_product_brand_id && existing.brand?.review_status === "pending_review") {
        const { error: brandErr } = await supabase
            .from("hs_generic_product_brands")
            .update({ review_status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: req.user.id, rejection_reason: null })
            .eq("id", existing.generic_product_brand_id);
        if (brandErr) return res.status(500).json({ success: false, message: brandErr.message });
    }

    const displayName = existing.product_name || existing.brand?.name || "Your product";
    if (existing.seller?.user_id) {
        await notifyUser(existing.seller.user_id, {
            type: "listing_approved",
            title: "Your product listing was approved",
            message: `"${displayName}" is now live on your shop.`,
            link: "/seller/dashboard",
        });
    }
    res.json({ success: true, submission: normalizeSubmission(data) });
}

// POST /api/admin/seller-submissions/:id/reject   { reason }
export async function rejectSellerSubmission(req, res) {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "A rejection reason is required." });

    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("id, product_name, seller:seller_profiles(user_id), brand:hs_generic_product_brands(name)")
        .eq("id", id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    const { data, error } = await supabase
        .from("seller_product_submissions")
        .update({ review_status: "rejected", rejection_reason: reason.trim(), reviewed_at: new Date().toISOString(), reviewed_by: req.user.id })
        .eq("id", id)
        .select()
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    const displayName = existing.product_name || existing.brand?.name || "Your product";
    if (existing.seller?.user_id) {
        await notifyUser(existing.seller.user_id, {
            type: "listing_rejected",
            title: "Your product listing needs changes",
            message: `"${displayName}" wasn't approved: ${reason.trim()}`,
            link: "/seller/dashboard",
        });
    }
    res.json({ success: true, submission: normalizeSubmission(data) });
}