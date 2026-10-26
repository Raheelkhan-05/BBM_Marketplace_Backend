// Resolves a GSTIN to a seller and publishes staged listings through the SAME controllers sellers use.
import { supabase } from "../config/supabase.js";
import { createSubmission, createListingForExistingBrand } from "../controllers/sellerCatalogListings.controller.js";
import { genericProductUsable, mapBrandItems } from "./catalogMapping.service.js";


const TABLE = "admin_staged_listings";
const STALE_MS = 10 * 60 * 1000;

export async function resolveSellerByGstin(gstin) {
    const { data: business, error } = await supabase
        .from("business_profiles")
        .select("user_id, gstin, legal_name, trade_name, display_name, registered_address, pincode, district, state, profiles!inner(deleted_at)")
        .eq("gstin", gstin).is("profiles.deleted_at", null).maybeSingle();
    if (error) throw error;
    if (!business) return { kind: "no_account" };
    const { data: seller } = await supabase
        .from("seller_profiles").select("id, status, display_name, shop_slug").eq("user_id", business.user_id).maybeSingle();
    return { kind: seller?.status === "approved" ? "live" : "no_seller", userId: business.user_id, business, seller };
}

// After a successful publish: put the new catalog item under the admin's chosen generic product.
// Never throws. Returns a note to store on the row, or null.
async function applyStagedMapping(submissionId, parentId) {
    try {
        if (!submissionId) return "Published, but the listing could not be found to map it.";
        const { data, error } = await supabase.from("seller_product_submissions")
            .select("generic_product_brand_id").eq("id", submissionId).maybeSingle();
        if (error) throw error;
        if (!data?.generic_product_brand_id) return "Published, but it has no catalog item to map.";
        if (!(await genericProductUsable(parentId))) return "Published, but the chosen generic product is no longer available. Map it from the catalog.";
        await mapBrandItems([data.generic_product_brand_id], parentId, { onlyUnmapped: true });
        return null;
    } catch (e) {
        console.error("[stagedListings] mapping:", e?.message || e);
        return "Published, but mapping failed. Map it from the catalog.";
    }
}

// Runs an express controller without HTTP and returns { status, body }.
function runController(fn, req) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); return this; },
        };
        Promise.resolve(fn(req, res))
            .then(() => resolve({ status: res.statusCode, body: null }))
            .catch((e) => resolve({ status: 500, body: { success: false, message: e?.message || "Failed." } }));
    });
}

const makeReq = (userId, payload) => ({
    sellerId: userId, user: { id: userId }, params: {}, query: {},
    body: structuredClone(payload), adminForceApprove: true,
});

async function publishOne(userId, payload) {
    const first = payload.genericProductBrandId ? createListingForExistingBrand : createSubmission;
    let out = await runController(first, makeReq(userId, payload));
    // the catalogue item it pointed to is gone: let createSubmission resolve / create it again
    if (!out.body?.success && out.status === 400 && payload.genericProductBrandId && /wasn't found|isn't available/i.test(out.body?.message || "")) {
        out = await runController(createSubmission, makeReq(userId, { ...payload, genericProductBrandId: null }));
    }
    return out;
}

export async function publishQueuedForGstin(gstin) {
    const r = await resolveSellerByGstin(gstin);
    if (r.kind !== "live") return { waiting: true, published: 0, failed: 0, skipped: 0 };

    const now = new Date().toISOString();
    // free rows a crashed worker left in "publishing"
    await supabase.from(TABLE).update({ status: "staged", claimed_at: null })
        .eq("gstin", gstin).eq("status", "publishing").lt("claimed_at", new Date(Date.now() - STALE_MS).toISOString());
    // atomic claim: a concurrent run matches zero rows.
    // NOTE: no .order() here. On an UPDATE, PostgREST orders only the returned columns,
    // so ordering by a column that isn't selected fails. We sort in JS instead.
    const { data: claimed, error } = await supabase.from(TABLE)
        .update({ status: "publishing", claimed_at: now, error: null })
        .eq("gstin", gstin).in("status", ["staged", "failed"]).select("id, payload, map_parent_id, created_at");
    if (error) throw error;
    const rows = (claimed || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const sum = { waiting: false, published: 0, failed: 0, skipped: 0 };
    for (const row of rows) {
        const out = await publishOne(r.userId, row.payload || {});
        const ok = !!out.body?.success, dup = out.status === 409;
        const mapNote = ok && row.map_parent_id ? await applyStagedMapping(out.body.submission?.id, row.map_parent_id) : null;
        await supabase.from(TABLE).update({
            status: ok ? "published" : dup ? "skipped" : "failed",
            error: ok ? mapNote : (out.body?.message || "Could not publish."),
            submission_id: ok ? (out.body.submission?.id ?? null) : null,
            published_at: ok ? new Date().toISOString() : null,
            claimed_at: null, updated_at: new Date().toISOString(),
        }).eq("id", row.id);
        if (ok) sum.published += 1; else if (dup) sum.skipped += 1; else sum.failed += 1;
    }
    return sum;
}

// Called when someone finishes seller onboarding.
export async function publishQueuedForUser(userId) {
    const { data } = await supabase.from("business_profiles").select("gstin").eq("user_id", userId).maybeSingle();
    if (data?.gstin) return publishQueuedForGstin(data.gstin);
    return null;
}