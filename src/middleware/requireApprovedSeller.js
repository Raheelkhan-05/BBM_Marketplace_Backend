// backend/middleware/requireApprovedSeller.js
//
// Builds on your existing requireAuth (JWT verified against
// AUTH_JWT_SECRET, sets req.user = { id: payload.sub }) rather than
// duplicating token verification. Use it as a second middleware AFTER
// requireAuth on any route that needs an approved seller:
//
//   router.post("/listings", requireAuth, requireApprovedSeller, createListing);

import { supabase } from "../config/supabase.js";
import jwt from "jsonwebtoken";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

export async function requireApprovedSeller(req, res, next) {
    try {
        // req.user.id is already set by requireAuth, which must run first
        if (!req.user?.id) {
            return res.status(401).json({ success: false, message: "Missing authorization token.", code: "NOT_AUTHENTICATED" });
        }

        const { data: seller, error: sellerErr } = await supabase
            .from("seller_profiles")
            .select("id, status, display_name")
            .eq("user_id", req.user.id)
            .maybeSingle();

        if (sellerErr) return res.status(500).json({ success: false, message: sellerErr.message });

        if (!seller) {
            return res.status(403).json({
                success: false,
                message: "You need to set up your seller shop before you can publish a product.",
                code: "SELLER_NOT_ONBOARDED",
            });
        }

        if (seller.status !== "approved") {
            return res.status(403).json({
                success: false,
                message:
                    seller.status === "pending_review"
                        ? "Your seller account is still under review. You'll be able to publish products once it's approved."
                        : "Your seller account isn't currently approved to publish products.",
                code: "SELLER_NOT_APPROVED",
                sellerStatus: seller.status,
            });
        }

        req.sellerId = seller.id;
        req.sellerProfile = seller;
        next();
    } catch (err) {
        console.error("requireApprovedSeller error:", err);
        res.status(500).json({ success: false, message: "Authentication check failed." });
    }
}

// GET /api/seller/catalog/access-status — never blocks, no requireAuth in
// front of it, since an anonymous visitor is a valid state ("please sign
// in") rather than an error. Verifies the token itself (same secret/logic
// as requireAuth) only if one was sent.
export async function getSellerAccessStatus(req, res) {
    try {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;

        if (!token || token === "undefined" || token === "null") {
            return res.json({ success: true, canPublish: false, reason: "NOT_AUTHENTICATED" });
        }

        let userId;
        try {
            const payload = jwt.verify(token, AUTH_JWT_SECRET);
            userId = payload.sub;
        } catch {
            return res.json({ success: true, canPublish: false, reason: "NOT_AUTHENTICATED" });
        }

        const { data: seller } = await supabase
            .from("seller_profiles")
            .select("id, status, display_name")
            .eq("user_id", userId)
            .maybeSingle();

        if (!seller) {
            return res.json({ success: true, canPublish: false, reason: "SELLER_NOT_ONBOARDED" });
        }
        if (seller.status !== "approved") {
            return res.json({ success: true, canPublish: false, reason: "SELLER_NOT_APPROVED", sellerStatus: seller.status });
        }
        return res.json({ success: true, canPublish: true, sellerId: seller.id, displayName: seller.display_name });
    } catch (err) {
        console.error("getSellerAccessStatus error:", err);
        res.status(500).json({ success: false, message: "Couldn't check seller status." });
    }
}