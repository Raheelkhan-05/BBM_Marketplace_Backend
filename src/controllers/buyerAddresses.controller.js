import { supabase } from "../config/supabase.js";

const REQUIRED = ["contact_name", "contact_phone", "address_line1", "city", "state", "pincode"];
const validateAddress = (body) => REQUIRED.filter((k) => !String(body[k] || "").trim());

export async function listAddresses(req, res) {
    const { data, error } = await supabase
        .from("buyer_addresses").select("*").eq("user_id", req.user.id)
        .order("is_default", { ascending: false }).order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, addresses: data || [] });
}

export async function createAddress(req, res) {
    const body = req.body || {};
    const missing = validateAddress(body);
    if (missing.length) return res.status(400).json({ success: false, message: `Please fill: ${missing.join(", ")}` });

    const { count } = await supabase.from("buyer_addresses").select("id", { count: "exact", head: true }).eq("user_id", req.user.id);
    const isFirst = !count;

    const { data, error } = await supabase
        .from("buyer_addresses")
        .insert({
            user_id: req.user.id, label: body.label?.trim() || "Office",
            contact_name: body.contact_name.trim(), contact_phone: body.contact_phone.trim(),
            address_line1: body.address_line1.trim(), address_line2: body.address_line2?.trim() || null,
            city: body.city.trim(), state: body.state.trim(), pincode: body.pincode.trim(),
            is_default: !!body.is_default || isFirst,
        })
        .select("*").single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    if (data.is_default) await supabase.rpc("set_default_buyer_address", { p_user_id: req.user.id, p_address_id: data.id });
    res.json({ success: true, address: data });
}

export async function updateAddress(req, res) {
    const { data: existing } = await supabase.from("buyer_addresses").select("id, user_id").eq("id", req.params.id).maybeSingle();
    if (!existing || existing.user_id !== req.user.id) return res.status(404).json({ success: false, message: "Address not found." });

    const body = req.body || {};
    const patch = {};
    for (const key of ["label", "contact_name", "contact_phone", "address_line1", "address_line2", "city", "state", "pincode"]) {
        if (body[key] !== undefined) patch[key] = String(body[key]).trim() || null;
    }
    const { data, error } = await supabase.from("buyer_addresses").update(patch).eq("id", req.params.id).select("*").single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, address: data });
}

export async function deleteAddress(req, res) {
    const { data: existing } = await supabase.from("buyer_addresses").select("id, user_id").eq("id", req.params.id).maybeSingle();
    if (!existing || existing.user_id !== req.user.id) return res.status(404).json({ success: false, message: "Address not found." });

    const { error } = await supabase.from("buyer_addresses").delete().eq("id", req.params.id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: "Address removed." });
}

export async function setDefaultAddress(req, res) {
    const { data: existing } = await supabase.from("buyer_addresses").select("id, user_id").eq("id", req.params.id).maybeSingle();
    if (!existing || existing.user_id !== req.user.id) return res.status(404).json({ success: false, message: "Address not found." });

    const { error } = await supabase.rpc("set_default_buyer_address", { p_user_id: req.user.id, p_address_id: req.params.id });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}