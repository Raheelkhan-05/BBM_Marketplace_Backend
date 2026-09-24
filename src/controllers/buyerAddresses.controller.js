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

    // Add: check for an existing near-duplicate before inserting
    const norm = (s) => String(s || "").trim().toLowerCase();
    const { data: existingRows } = await supabase.from("buyer_addresses").select("*").eq("user_id", req.user.id);
    const dup = (existingRows || []).find((a) =>
        norm(a.contact_phone) === norm(body.contact_phone) &&
        norm(a.address_line1) === norm(body.address_line1) &&
        norm(a.pincode) === norm(body.pincode)
    );
    if (dup) {
        // The buyer asked for this address to become the default — honour that
        // even though we're reusing the existing row.
        if (body.is_default && !dup.is_default) {
            const { error: defErr } = await supabase.rpc("set_default_buyer_address", { p_user_id: req.user.id, p_address_id: dup.id });
            if (!defErr) dup.is_default = true;
        }
        return res.json({ success: true, address: dup, deduped: true });
    }

    const isFirst = !(existingRows || []).length;
    const wantsDefault = !!body.is_default || isFirst;

    // IMPORTANT: always insert as NOT default. The table has a unique index
    // allowing only one default address per user
    // (buyer_addresses_one_default_per_user), so inserting a second row with
    // is_default = true fails while the old default still exists. The
    // set_default_buyer_address RPC below demotes the old default and
    // promotes this one in a single step.
    const { data, error } = await supabase
        .from("buyer_addresses")
        .insert({
            user_id: req.user.id, label: body.label?.trim() || "Office",
            contact_name: body.contact_name.trim(), contact_phone: body.contact_phone.trim(),
            address_line1: body.address_line1.trim(), address_line2: body.address_line2?.trim() || null,
            city: body.city.trim(), state: body.state.trim(), pincode: body.pincode.trim(),
            is_default: false,
        })
        .select("*").single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    if (wantsDefault) {
        const { error: defErr } = await supabase.rpc("set_default_buyer_address", { p_user_id: req.user.id, p_address_id: data.id });
        if (defErr) console.error("[addresses] set default after create failed:", defErr.message);
        else data.is_default = true;
    }
    res.json({ success: true, address: data });
}

export async function updateAddress(req, res) {
    const { data: existing } = await supabase.from("buyer_addresses").select("*").eq("id", req.params.id).maybeSingle();
    if (!existing || existing.user_id !== req.user.id) return res.status(404).json({ success: false, message: "Address not found." });

    const body = req.body || {};
    const patch = {};
    for (const key of ["label", "contact_name", "contact_phone", "address_line1", "address_line2", "city", "state", "pincode"]) {
        if (body[key] !== undefined) patch[key] = String(body[key]).trim() || null;
    }

    // Validate against the MERGED result, not just the raw patch — a
    // partial update must never leave a required field blank.
    const merged = { ...existing, ...patch };
    const missing = validateAddress(merged);
    if (missing.length) return res.status(400).json({ success: false, message: `Please fill: ${missing.join(", ")}` });

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