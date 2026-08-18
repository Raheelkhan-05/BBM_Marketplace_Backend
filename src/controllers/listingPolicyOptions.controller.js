// controllers/listingPolicyOptions.controller.js
//
// Powers the Return/Replacement Policy and Warranty dropdowns — reads
// from listing_policy_options (already seeded by migration 002 you ran).

import { supabase } from "../config/supabase.js";

// GET /api/listing-policy-options?kind=return_policy|warranty
export async function listPolicyOptions(req, res) {
    const { kind } = req.query;
    if (!["return_policy", "warranty"].includes(kind)) {
        return res.status(400).json({ success: false, message: "kind must be 'return_policy' or 'warranty'." });
    }
    const { data, error } = await supabase
        .from("listing_policy_options")
        .select("key, label, full_text")
        .eq("kind", kind)
        .eq("is_active", true)
        .order("sort_order");
    if (error) return res.status(500).json({ success: false, message: error.message });


    res.json({ success: true, items: data || [] });
}