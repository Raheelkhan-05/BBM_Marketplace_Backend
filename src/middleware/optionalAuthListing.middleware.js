// backend/middleware/optionalAuthListing.middleware.js
//
// Same token verification as requireAuth/requireApprovedSeller
// (AUTH_JWT_SECRET, payload.sub), but never blocks the request. Used on
// public catalog routes that behave slightly differently for a logged-in
// seller (e.g. hiding their own listing from their own seller list) but
// must stay accessible to anonymous buyers.

import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.js";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

export async function optionalAuthListing(req, res, next) {
    try {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;

        if (!token || token === "undefined" || token === "null") return next();

        let userId;
        try {
            const payload = jwt.verify(token, AUTH_JWT_SECRET);
            userId = payload.sub;
        } catch {
            return next(); // invalid/expired token on a public route — proceed anonymously
        }

        req.user = { id: userId };

        const { data: seller } = await supabase
            .from("seller_profiles")
            .select("id")
            .eq("user_id", userId)
            .maybeSingle();

        if (seller) req.sellerId = seller.id;
    } catch (err) {
        console.error("optionalAuth error:", err);
        // don't fail a public route over this
    }
    next();
}