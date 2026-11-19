// controllers/adminProductImageRequests.controller.js
import { supabaseAdmin } from "../config/supabase.js";
import { publishListingChange } from "../services/listingRealtime.service.js";
import { MAX_PRODUCT_IMAGES, currentImages, notifyUserSafe, refreshSellersOfProduct } from "../services/productImages.service.js";
import { notifySellerSubmissionsChanged } from "../services/notifications.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["pending", "approved", "rejected", "cancelled"];
const clampInt = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const firstOrSelf = (x) => (Array.isArray(x) ? x[0] : x);
const fail = (res, code, message, extra = {}) => res.status(code).json({ success: false, message, ...extra });


async function profileNames(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const { data } = await supabaseAdmin.from("profiles").select("id, name").in("id", list);
    return new Map((data || []).map((p) => [p.id, p.name]));
}

// GET /api/admin/product-image-requests?status=pending&limit=30&offset=0
export async function listImageRequests(req, res) {
    try {
        const status = String(req.query.status || "pending");
        if (status !== "all" && !STATUSES.includes(status)) return fail(res, 400, "Invalid status.");
        const limit = clampInt(req.query.limit, 1, 100, 30);
        const offset = clampInt(req.query.offset, 0, 1_000_000, 0);

        let q = supabaseAdmin.from("product_image_requests").select(`
            id, brand_item_id, submission_id, seller_id, requested_by, action, image_url, replace_image_url,
            note, status, rejection_reason, resolved_by, resolved_at, created_at,
            brand:hs_generic_product_brands(id, name, brand_name, image, images)
        `, { count: "exact" });
        if (status !== "all") q = q.eq("status", status);

        const asc = status === "pending";          // oldest first for the work queue
        const { data, error, count } = await q
            .order("created_at", { ascending: asc }).order("id", { ascending: asc })
            .range(offset, offset + limit - 1);
        if (error) {
            if (error.code === "PGRST103") return res.json({ success: true, items: [], total: count ?? offset, hasMore: false, pendingCount: 0 });
            return fail(res, 500, error.message);
        }

        const sellerIds = [...new Set((data || []).map((r) => r.seller_id).filter(Boolean))];
        const [sellersRes, pendingRes, names] = await Promise.all([
            sellerIds.length
                ? supabaseAdmin.from("seller_profiles").select("id, display_name").in("id", sellerIds)
                : Promise.resolve({ data: [] }),
            supabaseAdmin.from("product_image_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
            profileNames((data || []).flatMap((r) => [r.requested_by, r.resolved_by])),
        ]);

        const sellerName = new Map((sellersRes.data || []).map((s) => [s.id, s.display_name]));

        const items = (data || []).map((r) => {
            const brand = firstOrSelf(r.brand) || null;
            const live = currentImages(brand);
            let blocked = null;
            if (r.status === "pending") {
                if (r.action === "replace" && !live.includes(r.replace_image_url)) blocked = "TARGET_MISSING";
                else if (r.action === "add" && !live.includes(r.image_url) && live.length >= MAX_PRODUCT_IMAGES) blocked = "LIMIT_REACHED";
            }
            return {
                ...r, brand: brand && { id: brand.id, name: brand.name, brand_name: brand.brand_name },
                currentImages: live, seller_name: sellerName.get(r.seller_id) || null, requested_by_name: names.get(r.requested_by) || null,
                resolved_by_name: names.get(r.resolved_by) || null, blocked,
            };
        });

        res.json({
            success: true, items, total: count ?? items.length, offset, limit,
            hasMore: offset + (data?.length || 0) < (count ?? 0), pendingCount: pendingRes.count ?? 0,
        });
    } catch (e) {
        console.error("[adminImageRequests] list:", e?.message || e);
        fail(res, 500, "Couldn't load photo requests.");
    }
}

// POST /api/admin/product-image-requests/:id/approve
export async function approveImageRequest(req, res) {
    try {
        const { id } = req.params;
        if (!UUID_RE.test(String(id))) return fail(res, 400, "Invalid request.");
        const { data, error } = await supabaseAdmin.rpc("approve_product_image_request", {
            p_request_id: id, p_admin_id: req.user.id, p_ip: req.ip || null,
        });
        if (error) { console.error("[adminImageRequests] approve rpc:", error.message); return fail(res, 500, "Couldn't approve this photo."); }

        if (!data?.ok) {
            const map = {
                NOT_FOUND: [404, "Request not found."],
                NOT_PENDING: [409, `This request was already ${data?.status || "decided"}.`],
                PRODUCT_GONE: [409, "The product no longer exists."],
                LIMIT_REACHED: [409, `The product already has ${MAX_PRODUCT_IMAGES} photos. Reject this one, or remove a photo first.`],
                TARGET_MISSING: [409, "The photo this was meant to replace is no longer on the product. Reject this request."],
            };
            const [code, message] = map[data?.code] || [500, "Couldn't approve this photo."];
            return fail(res, code, message, { code: data?.code });
        }

        if (data.submission_id) void publishListingChange(data.submission_id);
        // void notifySellerSubmissionsChanged(data.requested_by);
        void refreshSellersOfProduct(data.brand_item_id);
        void notifyUserSafe(data.requested_by, {
            type: "product_image_approved",
            title: "Your product photo was approved",
            message: `Your photo for "${data.product_name || "your product"}" is now live for buyers.`,
            link: "/sell/products",
        });
        res.json({ success: true, images: data.images });
    } catch (e) {
        console.error("[adminImageRequests] approve:", e?.message || e);
        fail(res, 500, "Couldn't approve this photo.");
    }
}

// POST /api/admin/product-image-requests/:id/reject   { reason }
export async function rejectImageRequest(req, res) {
    try {
        const { id } = req.params;
        if (!UUID_RE.test(String(id))) return fail(res, 400, "Invalid request.");
        const reason = String(req.body?.reason || "").trim().slice(0, 500);
        if (reason.length < 3) return fail(res, 400, "A rejection reason is required.");

        const { data, error } = await supabaseAdmin.from("product_image_requests")
            .update({
                status: "rejected", rejection_reason: reason, resolved_by: req.user.id,
                resolved_at: new Date().toISOString(), resolved_ip: req.ip || null,
            })
            .eq("id", id).eq("status", "pending")
            .select("id, requested_by, brand:hs_generic_product_brands(name)").maybeSingle();
        if (error) { console.error("[adminImageRequests] reject:", error.message); return fail(res, 500, "Couldn't reject this photo."); }
        if (!data) return fail(res, 409, "This request was already decided or doesn't exist.");

        void notifyUserSafe(data.requested_by, {
            type: "product_image_rejected",
            title: "Your product photo wasn't approved",
            message: `Your photo for "${firstOrSelf(data.brand)?.name || "your product"}" wasn't approved: ${reason}`,
            link: "/sell/products",
        });
        res.json({ success: true });
    } catch (e) {
        console.error("[adminImageRequests] reject:", e?.message || e);
        fail(res, 500, "Couldn't reject this photo.");
    }
}

// GET /api/admin/product-image-requests/audit?brandItemId=&requestId=&limit=50&offset=0
export async function listImageAudit(req, res) {
    try {
        const { brandItemId, requestId } = req.query;
        if (!brandItemId && !requestId) return fail(res, 400, "brandItemId or requestId is required.");
        if ((brandItemId && !UUID_RE.test(String(brandItemId))) || (requestId && !UUID_RE.test(String(requestId)))) {
            return fail(res, 400, "Invalid id.");
        }
        const limit = clampInt(req.query.limit, 1, 200, 50);
        const offset = clampInt(req.query.offset, 0, 100000, 0);

        let q = supabaseAdmin.from("product_image_audit_log").select("*", { count: "exact" });
        if (brandItemId) q = q.eq("brand_item_id", brandItemId);
        if (requestId) q = q.eq("request_id", requestId);
        const { data, error, count } = await q.order("created_at", { ascending: false }).order("id", { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return fail(res, 500, error.message);

        const sellerIds = [...new Set((data || []).map((r) => r.seller_id).filter(Boolean))];
        const { data: sellers } = sellerIds.length
            ? await supabaseAdmin.from("seller_profiles").select("id, display_name").in("id", sellerIds)
            : { data: [] };
        const names = new Map((sellers || []).map((s) => [s.id, s.display_name]));

        const actorNames = await profileNames((data || []).map((r) => r.actor_id));

        res.json({
            success: true, total: count ?? 0,
            items: (data || []).map((r) => ({ ...r, seller_name: names.get(r.seller_id) || null, actor_name: actorNames.get(r.actor_id) || null, })),
        });
    } catch (e) {
        console.error("[adminImageRequests] audit:", e?.message || e);
        fail(res, 500, "Couldn't load the history.");
    }
}

// GET /api/admin/product-image-requests/rollback-preview?brandItemId=
export async function rollbackPreview(req, res) {
    try {
        const { brandItemId } = req.query;
        if (!UUID_RE.test(String(brandItemId || ""))) return fail(res, 400, "Invalid product.");
        const [logRes, brandRes] = await Promise.all([
            supabaseAdmin.from("product_image_audit_log")
                .select("id, event, created_at, actor_role, images_before, images_after, detail")
                .eq("brand_item_id", brandItemId).in("event", ["approved", "admin_direct_edit", "rolled_back"])
                .order("id", { ascending: false }).limit(100),
            supabaseAdmin.from("hs_generic_product_brands").select("image, images").eq("id", brandItemId).is("deleted_at", null).maybeSingle(),
        ]);
        if (logRes.error || brandRes.error) return fail(res, 500, "Couldn't load rollback info.");
        const rows = logRes.data || [];
        const reversed = new Set(rows.filter((r) => r.event === "rolled_back").map((r) => Number(r.detail?.reverses)));
        const cand = rows.find((r) => r.event !== "rolled_back" && r.images_before && r.images_after && !reversed.has(r.id)) || null;
        const live = currentImages(brandRes.data);
        const consistent = !!cand && JSON.stringify(cand.images_after) === JSON.stringify(live);
        res.json({ success: true, candidate: cand, canRollback: consistent, drifted: !!cand && !consistent });
    } catch (e) {
        console.error("[adminImageRequests] rollbackPreview:", e?.message || e);
        fail(res, 500, "Couldn't load rollback info.");
    }
}

// POST /api/admin/product-image-requests/rollback   { brandItemId, logId }
export async function rollbackImages(req, res) {
    try {
        const { brandItemId, logId } = req.body || {};
        if (!UUID_RE.test(String(brandItemId || ""))) return fail(res, 400, "Invalid product.");
        const { data, error } = await supabaseAdmin.rpc("rollback_product_images", {
            p_brand_item_id: brandItemId, p_admin_id: req.user.id,
            p_expected_log_id: Number.isFinite(Number(logId)) ? Number(logId) : null, p_ip: req.ip || null,
        });
        if (error) { console.error("[adminImageRequests] rollback rpc:", error.message); return fail(res, 500, "Couldn't undo the change."); }
        if (!data?.ok) {
            const map = {
                PRODUCT_GONE: [409, "The product no longer exists."],
                NOTHING_TO_ROLL_BACK: [409, "There is no change left to undo."],
                STALE: [409, "A newer change happened meanwhile. Please reload and check again."],
                STATE_MISMATCH: [409, "The photos were changed after this entry, so it can't be undone safely."],
            };
            const [code, message] = map[data?.code] || [500, "Couldn't undo the change."];
            return fail(res, code, message, { code: data?.code });
        }
        void refreshSellersOfProduct(brandItemId);
        res.json({ success: true, images: data.images });
    } catch (e) {
        console.error("[adminImageRequests] rollback:", e?.message || e);
        fail(res, 500, "Couldn't undo the change.");
    }
}