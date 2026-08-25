// controllers/admin/productCommission.controller.js
import { supabase } from "../config/supabase.js";

// GET /api/admin/products/commissions?search=&overriddenOnly=true
export async function listProductCommissions(req, res) {
    const { search = "", overriddenOnly } = req.query;
    let query = supabase
        .from("hs_generic_product_brands")
        .select("id, name, brand_name, slug, commission_percent, review_status")
        .eq("review_status", "approved")
        .order("name");

    if (search.trim()) query = query.ilike("name", `%${search.trim()}%`);
    if (overriddenOnly === "true") query = query.not("commission_percent", "is", null);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const { data: settings } = await supabase.from("platform_settings").select("commission_percent").eq("id", true).maybeSingle();
    const defaultPercent = Number(settings?.commission_percent ?? 0.25);

    res.json({
        success: true,
        defaultPercent,
        products: (data || []).map(p => ({
            id: p.id,
            name: p.name,
            brandName: p.brand_name,
            slug: p.slug,
            commissionPercent: p.commission_percent, // null = using default
            effectivePercent: p.commission_percent ?? defaultPercent,
            isOverridden: p.commission_percent != null,
        })),
    });
}

// PATCH /api/admin/products/:id/commission — { commissionPercent } or { commissionPercent: null } to clear override
export async function setProductCommission(req, res) {
    const { commissionPercent } = req.body ?? {};
    if (commissionPercent !== null && !(Number(commissionPercent) >= 0 && Number(commissionPercent) <= 100)) {
        return res.status(400).json({ success: false, message: "Enter a valid commission percent between 0 and 100, or leave blank to use the platform default." });
    }
    const { error } = await supabase
        .from("hs_generic_product_brands")
        .update({ commission_percent: commissionPercent === null ? null : Number(commissionPercent) })
        .eq("id", req.params.id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: commissionPercent === null ? "Reverted to platform default." : `Commission set to ${commissionPercent}%.` });
}