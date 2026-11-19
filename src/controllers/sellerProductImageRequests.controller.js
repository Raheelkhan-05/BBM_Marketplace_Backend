// controllers/sellerProductImageRequests.controller.js
//
// A seller asks to ADD a photo to, or REPLACE a photo of, a product they list.
// Nothing here touches hs_generic_product_brands: the live photos stay exactly as they are
// until an admin approves (see adminProductImageRequests.controller.js).
import { supabaseAdmin } from "../config/supabase.js";
import { notifyAdmins } from "../services/notifications.service.js";
import {
    MAX_PRODUCT_IMAGES, MAX_PENDING_PER_SELLER_PRODUCT, currentImages, isAllowedImageUrl,
} from "../services/productImages.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (res, code, message, extra = {}) => res.status(code).json({ success: false, message, ...extra });

const shape = (r) => ({
    id: r.id, action: r.action, image_url: r.image_url, replace_image_url: r.replace_image_url,
    status: r.status, rejection_reason: r.rejection_reason, created_at: r.created_at, resolved_at: r.resolved_at,
});

// The listing must belong to this seller; the product comes from the listing, never from the client.
async function loadOwnedListing(req, res) {
    const id = req.params.id;
    if (!UUID_RE.test(String(id))) { fail(res, 400, "Invalid listing."); return null; }
    const { data: sub, error } = await supabaseAdmin
        .from("seller_product_submissions")
        .select("id, generic_product_brand_id")
        .eq("id", id).eq("seller_id", req.sellerId).maybeSingle();
    if (error) { fail(res, 500, "Couldn't load this listing."); return null; }
    if (!sub) { fail(res, 404, "Listing not found."); return null; }

    const { data: brand, error: bErr } = await supabaseAdmin
        .from("hs_generic_product_brands")
        .select("id, name, brand_name, image, images, deleted_at")
        .eq("id", sub.generic_product_brand_id).maybeSingle();
    if (bErr) { fail(res, 500, "Couldn't load this product."); return null; }
    if (!brand || brand.deleted_at) { fail(res, 404, "This product is no longer available."); return null; }
    return { sub, brand };
}

async function pendingForBrand(brandItemId) {
    const { data } = await supabaseAdmin
        .from("product_image_requests")
        .select("id, seller_id, action, image_url, replace_image_url")
        .eq("brand_item_id", brandItemId).eq("status", "pending");
    return data || [];
}

// GET /api/seller/catalog/submissions/:id/image-requests
export async function listImageRequests(req, res) {
    try {
        const ctx = await loadOwnedListing(req, res);
        if (!ctx) return;
        const { brand } = ctx;
        const live = currentImages(brand);

        const [pending, mineRes] = await Promise.all([
            pendingForBrand(brand.id),
            supabaseAdmin.from("product_image_requests")
                .select("id, action, image_url, replace_image_url, status, rejection_reason, created_at, resolved_at")
                .eq("brand_item_id", brand.id).eq("seller_id", req.sellerId)
                .order("created_at", { ascending: false }).limit(40),
        ]);
        if (mineRes.error) return fail(res, 500, "Couldn't load your photo requests.");

        const addsPending = pending.filter((p) => p.action === "add").length;
        res.json({
            success: true,
            product: { id: brand.id, name: brand.name, brand_name: brand.brand_name },
            images: live,
            requests: (mineRes.data || []).map(shape),
            slotsLeft: Math.max(0, MAX_PRODUCT_IMAGES - live.length - addsPending),
            replaceLocked: pending.filter((p) => p.action === "replace").map((p) => p.replace_image_url),
            limits: { maxImages: MAX_PRODUCT_IMAGES, maxPending: MAX_PENDING_PER_SELLER_PRODUCT },
        });
    } catch (e) {
        console.error("[imageRequests] list:", e?.message || e);
        fail(res, 500, "Couldn't load photos. Please try again.");
    }
}

// POST /api/seller/catalog/submissions/:id/image-requests
// body: { action: "add" | "replace", imageUrl, replaceImageUrl?, note? }
export async function createImageRequest(req, res) {
    try {
        const ctx = await loadOwnedListing(req, res);
        if (!ctx) return;
        const { sub, brand } = ctx;
        const b = req.body || {};

        const action = b.action;
        if (action !== "add" && action !== "replace") return fail(res, 400, "Invalid request type.");
        const imageUrl = typeof b.imageUrl === "string" ? b.imageUrl.trim() : "";
        if (!isAllowedImageUrl(imageUrl)) return fail(res, 400, "That photo link isn't valid. Please upload the photo again.");
        const note = typeof b.note === "string" ? b.note.trim().slice(0, 300) || null : null;
        const replaceUrl = action === "replace" ? String(b.replaceImageUrl || "").trim() : null;

        const live = currentImages(brand);
        if (live.includes(imageUrl)) return fail(res, 409, "This photo is already on the product.");

        const pending = await pendingForBrand(brand.id);
        if (pending.some((p) => p.image_url === imageUrl)) return fail(res, 409, "This photo is already waiting for review.");
        if (pending.filter((p) => p.seller_id === req.sellerId).length >= MAX_PENDING_PER_SELLER_PRODUCT) {
            return fail(res, 409, `You can have up to ${MAX_PENDING_PER_SELLER_PRODUCT} photos waiting for review on one product. Please wait for a decision first.`);
        }

        if (action === "add") {
            const addsPending = pending.filter((p) => p.action === "add").length;
            if (live.length + addsPending >= MAX_PRODUCT_IMAGES) {
                return fail(res, 409, `A product can have up to ${MAX_PRODUCT_IMAGES} photos. Try replacing an existing photo instead.`);
            }
        } else {
            if (!replaceUrl || !live.includes(replaceUrl)) return fail(res, 409, "The photo you want to replace is no longer on this product. Please reload.");
            if (pending.some((p) => p.replace_image_url === replaceUrl)) {
                return fail(res, 409, "A change for this photo is already waiting for review.");
            }
        }

        const { data: row, error } = await supabaseAdmin.from("product_image_requests").insert({
            brand_item_id: brand.id, submission_id: sub.id, seller_id: req.sellerId,
            requested_by: req.user?.id || null, action, image_url: imageUrl,
            replace_image_url: replaceUrl, note, request_ip: req.ip || null,
        }).select("id, action, image_url, replace_image_url, status, rejection_reason, created_at, resolved_at").single();

        if (error) {
            if (error.code === "23505") return fail(res, 409, "That photo or photo change is already waiting for review.");
            console.error("[imageRequests] insert:", error.message);
            return fail(res, 500, "Couldn't send the photo for review. Please try again.");
        }

        // One notification per product while it has a queue (a batch upload must not spam admins).
        if (pending.length === 0) {
            try {
                await notifyAdmins({
                    type: "seller_submission",
                    title: "Product photo awaiting approval",
                    body: `${brand.brand_name || "(No brand)"} — ${brand.name} has new photo(s) to review.`,
                    link: "/image-requests",
                });
            } catch (e) { console.error("[imageRequests] notifyAdmins:", e?.message || e); }
        }

        res.json({ success: true, request: shape(row), message: "Sent for approval. The current photos stay live until it's approved." });
    } catch (e) {
        console.error("[imageRequests] create:", e?.message || e);
        fail(res, 500, "Couldn't send the photo for review. Please try again.");
    }
}

// DELETE /api/seller/catalog/submissions/:id/image-requests/:requestId  (cancels own pending request)
export async function cancelImageRequest(req, res) {
    try {
        const { requestId } = req.params;
        if (!UUID_RE.test(String(requestId)) || !UUID_RE.test(String(req.params.id))) return fail(res, 400, "Invalid request.");
        const { data, error } = await supabaseAdmin.from("product_image_requests")
            .update({
                status: "cancelled", resolved_by: req.user?.id || null,
                resolved_at: new Date().toISOString(), resolved_ip: req.ip || null,
            })
            .eq("id", requestId).eq("seller_id", req.sellerId).eq("status", "pending")
            .select("id").maybeSingle();
        if (error) return fail(res, 500, "Couldn't cancel this request.");
        if (!data) return fail(res, 409, "This request was already decided or doesn't exist.");
        res.json({ success: true, message: "Request cancelled." });
    } catch (e) {
        console.error("[imageRequests] cancel:", e?.message || e);
        fail(res, 500, "Couldn't cancel this request.");
    }
}