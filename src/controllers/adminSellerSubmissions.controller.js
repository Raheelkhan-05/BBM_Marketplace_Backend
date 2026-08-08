import { supabase } from "../config/supabase.js";
import { notifyUser } from "../services/notifications.service.js";

// GET /api/admin/seller-submissions?status=pending_review&q=
export async function listSellerSubmissions(req, res) {
    const { status = "pending_review", q = "" } = req.query;
    let query = supabase
        .from("seller_product_submissions")
        .select(`
            id, product_name, brand_name, price, moq, unit, lead_time, image,
            review_status, rejection_reason, created_at,
            seller:seller_profiles(id, display_name, user_id),
            generic_product:hs_generic_products(id, name,
                subcategory:hs_subcategories(id, name, category:hs_categories(id, name))
            )
        `)
        .order("created_at", { ascending: false })
        .limit(200);
    if (status !== "all") query = query.eq("review_status", status);
    if (q.trim()) query = query.or(`product_name.ilike.%${q.trim()}%,brand_name.ilike.%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/admin/seller-submissions/:id
export async function getSellerSubmission(req, res) {
    const { id } = req.params;
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(`*, seller:seller_profiles(id, display_name, user_id), generic_product:hs_generic_products(id, name, subcategory:hs_subcategories(id, name, category:hs_categories(id, name)))`)
        .eq("id", id)
        .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, submission: data });
}

// POST /api/admin/seller-submissions/:id/approve
export async function approveSellerSubmission(req, res) {
    const { id } = req.params;
    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("id, product_name, seller:seller_profiles(user_id)")
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

    if (existing.seller?.user_id) {
        await notifyUser(existing.seller.user_id, {
            type: "listing_approved",
            title: "Your product listing was approved",
            message: `"${existing.product_name}" is now live on your shop.`,
            link: "/seller/dashboard",
        });
    }
    res.json({ success: true, submission: data });
}

// POST /api/admin/seller-submissions/:id/reject   { reason }
export async function rejectSellerSubmission(req, res) {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "A rejection reason is required." });

    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("id, product_name, seller:seller_profiles(user_id)")
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

    if (existing.seller?.user_id) {
        await notifyUser(existing.seller.user_id, {
            type: "listing_rejected",
            title: "Your product listing needs changes",
            message: `"${existing.product_name}" wasn't approved: ${reason.trim()}`,
            link: "/seller/dashboard",
        });
    }
    res.json({ success: true, submission: data });
}