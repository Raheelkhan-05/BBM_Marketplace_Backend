// Resolves a GSTIN to a seller and publishes staged listings through the SAME controllers sellers use.
import { supabase } from "../config/supabase.js";
import { createSubmission, createListingForExistingBrand } from "../controllers/sellerCatalogListings.controller.js";
import { genericProductUsable, mapBrandItems } from "./catalogMapping.service.js";


const TABLE = "admin_staged_listings";
const STALE_MS = 10 * 60 * 1000;
const CONCURRENCY = Math.max(1, Math.min(Number(process.env.PUBLISH_CONCURRENCY) || 5, 10));
const BATCH = 10;          // rows a worker claims at a time
const MAX_QUEUE = 5000;    // rows picked up per run

// GSTINs being published right now on this server instance
const running = new Set();

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

// sellerId must be seller_profiles.id (what seller_product_submissions.seller_id references),
// while user.id stays the account's user id.
const makeReq = (userId, sellerId, payload) => ({
    sellerId, user: { id: userId }, params: {}, query: {},
    body: structuredClone(payload), adminForceApprove: true,
});

async function publishOne(userId, sellerId, payload) {
    const first = payload.genericProductBrandId ? createListingForExistingBrand : createSubmission;
    let out = await runController(first, makeReq(userId, sellerId, payload));
    // the catalogue item it pointed to is gone: let createSubmission resolve / create it again
    if (!out.body?.success && out.status === 400 && payload.genericProductBrandId && /wasn't found|isn't available/i.test(out.body?.message || "")) {
        out = await runController(createSubmission, makeReq(userId, sellerId, { ...payload, genericProductBrandId: null }));
    }
    return out;
}

// Publishes one claimed row and records the result on it.
async function processRow(r, row, sum) {
    let out;
    try {
        out = await publishOne(r.userId, r.seller.id, row.payload || {});
    } catch (e) {
        out = { status: 500, body: { success: false, message: e?.message || "Could not publish." } };
    }
    const ok = !!out.body?.success, dup = out.status === 409;
    const mapNote = ok && row.map_parent_id ? await applyStagedMapping(out.body.submission?.id, row.map_parent_id) : null;
    const { error } = await supabase.from(TABLE).update({
        status: ok ? "published" : dup ? "skipped" : "failed",
        error: ok ? mapNote : (out.body?.message || "Could not publish."),
        submission_id: ok ? (out.body.submission?.id ?? null) : null,
        published_at: ok ? new Date().toISOString() : null,
        claimed_at: null, updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (error) console.error("[stagedListings] result save:", error.message);
    if (ok) sum.published += 1; else if (dup) sum.skipped += 1; else sum.failed += 1;
}

// The publish run: several workers, each claiming a few rows at a time.
async function runPublish(gstin, r) {
    const sum = { waiting: false, published: 0, failed: 0, skipped: 0 };

    // free rows a crashed worker left in "publishing"
    await supabase.from(TABLE).update({ status: "staged", claimed_at: null })
        .eq("gstin", gstin).eq("status", "publishing").lt("claimed_at", new Date(Date.now() - STALE_MS).toISOString());

    // snapshot of what to publish, oldest first (rows that fail now are not re-picked in this run)
    const { data: idRows, error } = await supabase.from(TABLE).select("id")
        .eq("gstin", gstin).in("status", ["staged", "failed"])
        .order("created_at", { ascending: true }).limit(MAX_QUEUE);
    if (error) throw error;
    const queue = (idRows || []).map((x) => x.id);
    let next = 0;

    const worker = async () => {
        while (next < queue.length) {
            const slice = queue.slice(next, next + BATCH);
            next += slice.length;
            // atomic claim: a concurrent run matches zero rows
            const { data: claimed, error: cErr } = await supabase.from(TABLE)
                .update({ status: "publishing", claimed_at: new Date().toISOString(), error: null })
                .in("id", slice).in("status", ["staged", "failed"])
                .select("id, payload, map_parent_id, created_at");
            if (cErr) { console.error("[stagedListings] claim:", cErr.message); continue; }
            const rows = (claimed || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            for (const row of rows) await processRow(r, row, sum);
        }
    };
    const workers = Math.min(CONCURRENCY, Math.ceil(queue.length / BATCH));
    await Promise.all(Array.from({ length: workers }, worker));
    return sum;
}

// Waits for the whole run. Used by the onboarding hook.
export async function publishQueuedForGstin(gstin) {
    const r = await resolveSellerByGstin(gstin);
    if (r.kind !== "live" || !r.seller?.id) return { waiting: true, published: 0, failed: 0, skipped: 0 };
    if (running.has(gstin)) return { waiting: false, alreadyRunning: true, published: 0, failed: 0, skipped: 0 };
    running.add(gstin);
    try { return await runPublish(gstin, r); }
    finally { running.delete(gstin); }
}

// Returns immediately; the publishing continues in the background. Used by the admin "Publish" button.
export async function startPublishInBackground(gstin) {
    const r = await resolveSellerByGstin(gstin);
    if (r.kind !== "live" || !r.seller?.id) return { waiting: true };
    if (running.has(gstin)) return { started: false, alreadyRunning: true };

    const { count } = await supabase.from(TABLE).select("id", { count: "exact", head: true })
        .eq("gstin", gstin).in("status", ["staged", "failed"]);
    if (!count) return { started: false, queued: 0 };

    running.add(gstin);
    runPublish(gstin, r)
        .then((sum) => console.log(`[stagedListings] ${gstin} done:`, JSON.stringify(sum)))
        .catch((e) => console.error("[stagedListings] run failed:", e?.message || e))
        .finally(() => running.delete(gstin));
    return { started: true, queued: count };
}

// Called when someone finishes seller onboarding.
export async function publishQueuedForUser(userId) {
    const { data } = await supabase.from("business_profiles").select("gstin").eq("user_id", userId).maybeSingle();
    if (data?.gstin) return publishQueuedForGstin(data.gstin);
    return null;
}