import { supabaseAdmin } from "../config/supabase.js";

// Must run AFTER optionalAuth — depends on req.user being set already.
// Resolves the signed-in user's seller_profiles.id (if they have one) and
// attaches it as req.sellerProfileId, the way catalog RPCs (catalog_browse,
// catalog_browse_feed) expect for p_seller_id — used to compute
// has_own_listing. A buyer with no seller profile, or no auth at all,
// just gets req.sellerProfileId = null — this never blocks the request.
export async function optionalSellerProfile(req, res, next) {
    if (!req.user?.id) {
        req.sellerProfileId = null;
        return next();
    }

    try {
        const { data, error } = await supabaseAdmin
            .from("seller_profiles")
            .select("id")
            .eq("user_id", req.user.id) // adjust column name if yours differs (e.g. owner_id)
            .maybeSingle();

        if (error) {
            console.log("optionalSellerProfile: lookup failed:", error.message);
            req.sellerProfileId = null;
        } else {
            req.sellerProfileId = data?.id || null;
        }
    } catch (err) {
        console.log("optionalSellerProfile: unexpected error:", err.message);
        req.sellerProfileId = null;
    }

    next();
}