// controllers/buyerBusinessProfile.controller.js
import { supabase } from "../config/supabase.js";

export async function getBusinessProfile(req, res) {
    const [{ data: businessProfile, error: bpError }, { data: profile, error: pError }] = await Promise.all([
        supabase.from("business_profiles").select("*").eq("user_id", req.user.id).maybeSingle(),
        supabase.from("profiles").select("name, phone").eq("id", req.user.id).maybeSingle(),
    ]);

    if (bpError) return res.status(500).json({ success: false, message: bpError.message });
    if (pError) return res.status(500).json({ success: false, message: pError.message });

    // Either or both can legitimately be null — a buyer may have a GST
    // profile with no contact filled in yet, or a plain profile with no
    // GST profile at all. The frontend merges whatever's present.
    res.json({ success: true, profile: businessProfile || null, contact: profile || null });
}