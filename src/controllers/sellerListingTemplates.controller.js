// controllers/sellerListingTemplates.controller.js
//
// "Groups" — named, reusable field sets a seller saves once (e.g. a
// "Standard Delivery" group, or a default GST/Tax profile) and reuses
// across every future listing. One group per (seller, group_type) can
// be marked default, and the listing form prefills from the defaults
// automatically on a brand new listing — see useSellerListingTemplates.js
// and GroupTemplateBar.jsx on the frontend.

import { supabase } from "../config/supabase.js";

const GROUP_TYPES = ["packaging", "delivery", "tax_legal", "commercial_terms", "quality"];

function assertGroupType(groupType, res) {
    if (!GROUP_TYPES.includes(groupType)) {
        res.status(400).json({ success: false, message: `Invalid group type "${groupType}".` });
        return false;
    }
    return true;
}

// GET /api/seller/catalog/templates?groupType=
export async function listTemplates(req, res) {
    const sellerId = req.sellerId;
    const { groupType } = req.query;
    let query = supabase
        .from("seller_listing_templates")
        .select("*")
        .eq("seller_id", sellerId)
        .order("is_default", { ascending: false })
        .order("name");
    if (groupType) {
        if (!assertGroupType(groupType, res)) return;
        query = query.eq("group_type", groupType);
    }
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/seller/catalog/templates/defaults — one default template per
// group_type in a single round trip, for prefilling a brand-new listing.
export async function listDefaultTemplates(req, res) {
    const sellerId = req.sellerId;
    const { data, error } = await supabase
        .from("seller_listing_templates")
        .select("*")
        .eq("seller_id", sellerId)
        .eq("is_default", true);
    if (error) return res.status(500).json({ success: false, message: error.message });
    const byGroup = {};
    (data || []).forEach((t) => { byGroup[t.group_type] = t; });
    res.json({ success: true, defaults: byGroup });
}

// POST /api/seller/catalog/templates  { groupType, name, data, isDefault }
export async function createTemplate(req, res) {
    const sellerId = req.sellerId;
    const { groupType, name, data, isDefault } = req.body || {};
    if (!assertGroupType(groupType, res)) return;
    const trimmed = (name || "").trim();
    if (trimmed.length < 2) return res.status(400).json({ success: false, message: "Give this group a short name (e.g. \"Standard Delivery\")." });

    if (isDefault) {
        await supabase.from("seller_listing_templates").update({ is_default: false }).eq("seller_id", sellerId).eq("group_type", groupType);
    }

    const { data: inserted, error } = await supabase
        .from("seller_listing_templates")
        .insert({ seller_id: sellerId, group_type: groupType, name: trimmed, data: data || {}, is_default: Boolean(isDefault) })
        .select()
        .single();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You already have a group with that name." });
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true, template: inserted });
}

// PATCH /api/seller/catalog/templates/:id  { name, data, isDefault }
export async function updateTemplate(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;
    const { data: existing, error: findErr } = await supabase.from("seller_listing_templates").select("id, seller_id, group_type").eq("id", id).maybeSingle();
    if (findErr) return res.status(500).json({ success: false, message: findErr.message });
    if (!existing || existing.seller_id !== sellerId) return res.status(404).json({ success: false, message: "Group not found." });

    const { name, data, isDefault } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name.trim();
    if (data !== undefined) patch.data = data;
    if (isDefault !== undefined) patch.is_default = Boolean(isDefault);

    if (patch.is_default) {
        await supabase.from("seller_listing_templates").update({ is_default: false }).eq("seller_id", sellerId).eq("group_type", existing.group_type).neq("id", id);
    }

    const { data: updated, error } = await supabase.from("seller_listing_templates").update(patch).eq("id", id).select().single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, template: updated });
}

// DELETE /api/seller/catalog/templates/:id
export async function deleteTemplate(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;
    const { data: existing, error: findErr } = await supabase.from("seller_listing_templates").select("id, seller_id").eq("id", id).maybeSingle();
    if (findErr) return res.status(500).json({ success: false, message: findErr.message });
    if (!existing || existing.seller_id !== sellerId) return res.status(404).json({ success: false, message: "Group not found." });
    const { error } = await supabase.from("seller_listing_templates").delete().eq("id", id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}