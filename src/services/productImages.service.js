// services/productImages.service.js
import { supabaseAdmin } from "../config/supabase.js";
import { notifyUser } from "./notifications.service.js";   // replaces: import * as notif ...
import { bumpVer, sellerListScope } from "./cache.service.js";
import { notifySellerSubmissionsChanged } from "./notifications.service.js";

export const MAX_PRODUCT_IMAGES = 10;            // keep in sync with v_max in approve_product_image_request()
export const MAX_PENDING_PER_SELLER_PRODUCT = 5;

// Same rule the admin/feed code uses: images[] if present, otherwise the single cover.
export function currentImages(brand) {
    const imgs = Array.isArray(brand?.images) ? brand.images.filter((u) => typeof u === "string" && u) : [];
    if (imgs.length) return imgs;
    return brand?.image ? [brand.image] : [];
}

export function isAllowedImageUrl(u) {
    if (typeof u !== "string" || u.length < 8 || u.length > 2000) return false;
    try {
        const x = new URL(u);
        return x.protocol === "https:" || (process.env.NODE_ENV !== "production" && x.protocol === "http:");
    } catch { return false; }
}

// A photo changed on a shared product: every seller listing it must see it, not just the requester.
export async function refreshSellersOfProduct(brandItemId) {
    try {
        const { data: subs } = await supabaseAdmin
            .from("seller_product_submissions").select("seller_id").eq("generic_product_brand_id", brandItemId);
        const ids = [...new Set((subs || []).map((s) => s.seller_id).filter(Boolean))];
        if (!ids.length) return;

        const { data: profs } = await supabaseAdmin
            .from("seller_profiles").select("id, user_id")
            .or(`id.in.(${ids.join(",")}),user_id.in.(${ids.join(",")})`);

        const scopeIds = new Set(ids);          // seller_id as stored, whichever kind it is
        const userIds = new Set();
        for (const p of profs || []) {
            scopeIds.add(p.id);
            if (p.user_id) { scopeIds.add(p.user_id); userIds.add(p.user_id); }
        }
        await bumpVer(...[...scopeIds].map((id) => sellerListScope(id)));
        await Promise.all([...userIds].map((u) => notifySellerSubmissionsChanged(u)));  // also pushes the live refresh
    } catch (e) {
        console.error("[productImages] refreshSellersOfProduct failed:", e?.message || e);
    }
}

// Append-only audit entry. Never throws: logging must not break the user's action.
export async function logProductImageEvent({
    brandItemId, event, actorId = null, actorRole = null, sellerId = null, submissionId = null,
    requestId = null, imageUrl = null, replacedImageUrl = null, imagesBefore = null, imagesAfter = null,
    detail = null, ip = null,
}) {
    try {
        const { error } = await supabaseAdmin.from("product_image_audit_log").insert({
            brand_item_id: brandItemId, request_id: requestId, event, actor_id: actorId, actor_role: actorRole,
            seller_id: sellerId, submission_id: submissionId, image_url: imageUrl, replaced_image_url: replacedImageUrl,
            images_before: imagesBefore, images_after: imagesAfter, detail, ip,
        });
        if (error) console.error("[productImages] audit insert failed:", error.message);
    } catch (e) {
        console.error("[productImages] audit insert threw:", e?.message || e);
    }
}

// Best-effort notification. Your two controllers call notifyUser with different shapes,
// so this adapts to whichever one notifications.service.js really exports.
export async function notifyUserSafe(userId, { type, title, message, link }) {
    if (!userId) return;
    try { await notifyUser({ userId, type, title, body: message, link }); }
    catch (e) { console.error("[productImages] notify failed:", e?.message || e); }
}
