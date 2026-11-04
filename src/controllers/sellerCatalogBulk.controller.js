// controllers/sellerCatalogBulk.controller.js
//
// Bulk actions on a seller's own listings. One request = one batch (max 200 ids);
// the client splits bigger selections into chunks.
//
// Every endpoint:
//   - only touches rows owned by req.sellerId (ownership is part of every query),
//   - never fails the whole batch because of one bad listing: it returns
//     { success, updated: [...], skipped: [{ id, reason }], message },
//   - calls publishListingChange so buyers see the change in realtime.
//
// Marketing & promotion bulk edits already exist (PATCH /marketing/bulk, bulkUpdateMarketing).
//
// PRICE NOTE (verified against the DB trigger sync_seller_submission_final_price):
//   on every INSERT/UPDATE the DB sets  price = round(base_price * (1 + gst_percent/100), 2).
//   So a bulk price change writes ONLY base_price (GST-exclusive, per sale unit) and lets
//   the trigger derive `price`. Percent-based custom buyer prices are computed as
//   price * (1 - discount%), so they follow the new price automatically.
import { supabase } from "../config/supabase.js";
import { publishListingChange } from "../services/listingRealtime.service.js";
import { resolveCompanyIds } from "../services/team.service.js";
import { isListingExpired } from "../../shared/listingValidity.js";
import { violatesMinUnitPrice } from "../../shared/customPricing.js";
import { round2 } from "../../shared/marketingServices.js";

const MAX_IDS = 200;
const MAX_BUYERS = 20;
const WRITE_CONCURRENCY = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMISSIONS = "seller_product_submissions";

const MAX_INCREASE_PERCENT = 500;
const MAX_DECREASE_PERCENT = 90;

function cleanIds(raw) {
    if (!Array.isArray(raw)) return { error: "Select at least one listing." };
    const ids = [...new Set(raw.filter((x) => typeof x === "string" && UUID_RE.test(x)))];
    if (!ids.length) return { error: "Select at least one listing." };
    if (ids.length > MAX_IDS) return { error: `Update at most ${MAX_IDS} listings at a time.` };
    return { ids };
}

async function loadOwned(sellerId, ids, columns) {
    const { data, error } = await supabase.from(SUBMISSIONS).select(columns).eq("seller_id", sellerId).in("id", ids);
    return { rows: data || [], error };
}

function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

// Ids that were asked for but don't belong to this seller (or no longer exist).
function addMissing(ids, rows, skipped) {
    const found = new Set(rows.map((r) => String(r.id)));
    for (const id of ids) if (!found.has(id)) skipped.push({ id, reason: "Listing not found." });
}

const REMOVED = "This listing was removed.";

/* ------------------------------------------------------------------ */
/* PATCH /api/seller/catalog/bulk/price   { submissionIds, percent }   */
/* percent > 0 raises prices, percent < 0 lowers them.                 */
/* ------------------------------------------------------------------ */
export async function bulkChangePrice(req, res) {
    const sellerId = req.sellerId;
    const { ids, error: idErr } = cleanIds(req.body?.submissionIds);
    if (idErr) return res.status(400).json({ success: false, message: idErr });

    const percent = Math.round(Number(req.body?.percent) * 100) / 100;
    if (!Number.isFinite(percent) || percent === 0) {
        return res.status(400).json({ success: false, message: "Enter a percentage to change the price by." });
    }
    if (percent > MAX_INCREASE_PERCENT) return res.status(400).json({ success: false, message: `You can raise prices by at most ${MAX_INCREASE_PERCENT}% at once.` });
    if (percent < -MAX_DECREASE_PERCENT) return res.status(400).json({ success: false, message: `You can lower prices by at most ${MAX_DECREASE_PERCENT}% at once.` });

    const { rows, error } = await loadOwned(sellerId, ids, "id, review_status, base_price, gst_percent, pack_size, units_per_master_pack, deleted_at");
    if (error) return res.status(500).json({ success: false, message: error.message });

    const skipped = [];
    addMissing(ids, rows, skipped);

    const factor = 1 + percent / 100;
    const toWrite = [];
    for (const r of rows) {
        const id = String(r.id);
        if (r.deleted_at) { skipped.push({ id, reason: REMOVED }); continue; }
        if (r.review_status === "rejected") { skipped.push({ id, reason: "Rejected. Edit and resubmit it first." }); continue; }
        const base = Number(r.base_price);
        if (!(base > 0)) { skipped.push({ id, reason: "No price set." }); continue; }
        const next = round2(base * factor);
        if (!(next > 0)) { skipped.push({ id, reason: "New price would be zero." }); continue; }
        if (next === round2(base)) { skipped.push({ id, reason: "Price doesn't change after rounding." }); continue; }
        if (violatesMinUnitPrice(next, r.pack_size, r.units_per_master_pack)) { skipped.push({ id, reason: "New price is below the ₹1 per unit minimum." }); continue; }
        toWrite.push({ id, next });
    }

    const updated = [];
    for (const part of chunk(toWrite, WRITE_CONCURRENCY)) {
        const results = await Promise.all(part.map(async (w) => {
            const { data, error: e } = await supabase.from(SUBMISSIONS)
                .update({ base_price: w.next })
                .eq("id", w.id).eq("seller_id", sellerId)
                .select("id, price, base_price").maybeSingle();
            return { w, data, error: e };
        }));
        for (const r of results) {
            if (r.error || !r.data) { skipped.push({ id: r.w.id, reason: "Couldn't be saved. Try again." }); continue; }
            updated.push(r.data);
            void publishListingChange(r.data.id);
        }
    }

    res.json({
        success: true, updated, skipped,
        message: `Updated ${updated.length} listing${updated.length === 1 ? "" : "s"}.`,
    });
}

/* ------------------------------------------------------------------ */
/* PATCH /api/seller/catalog/bulk/active   { submissionIds, isActive } */
/* Same rules as setSubmissionActive: an expired listing can't go live */
/* until it's renewed; pending / rejected listings aren't switchable.  */
/* ------------------------------------------------------------------ */
export async function bulkSetActive(req, res) {
    const sellerId = req.sellerId;
    const { ids, error: idErr } = cleanIds(req.body?.submissionIds);
    if (idErr) return res.status(400).json({ success: false, message: idErr });
    const isActive = req.body?.isActive;
    if (typeof isActive !== "boolean") return res.status(400).json({ success: false, message: "isActive must be true or false." });

    const { rows, error } = await loadOwned(sellerId, ids, "id, review_status, is_active, expires_at, expired_at, deleted_at");
    if (error) return res.status(500).json({ success: false, message: error.message });

    const skipped = [];
    addMissing(ids, rows, skipped);

    const okIds = [];
    for (const r of rows) {
        const id = String(r.id);
        if (r.deleted_at) { skipped.push({ id, reason: REMOVED }); continue; }
        if (r.review_status === "pending_review") { skipped.push({ id, reason: "Still in review." }); continue; }
        if (r.review_status === "rejected") { skipped.push({ id, reason: "Rejected. Edit and resubmit it first." }); continue; }
        if (isActive && isListingExpired(r)) { skipped.push({ id, reason: "Expired. Reactivate it first." }); continue; }
        if ((r.is_active !== false) === isActive) { skipped.push({ id, reason: isActive ? "Already live." : "Already paused." }); continue; }
        okIds.push(id);
    }

    let updated = [];
    if (okIds.length) {
        const { data, error: e } = await supabase.from(SUBMISSIONS)
            .update({ is_active: isActive })
            .eq("seller_id", sellerId).in("id", okIds)
            .select("id, is_active");
        if (e) return res.status(500).json({ success: false, message: e.message });
        updated = data || [];
        updated.forEach((u) => void publishListingChange(u.id));
        const got = new Set(updated.map((u) => String(u.id)));
        okIds.filter((id) => !got.has(id)).forEach((id) => skipped.push({ id, reason: "Couldn't be saved. Try again." }));
    }

    res.json({
        success: true, updated, skipped,
        message: `${updated.length} listing${updated.length === 1 ? "" : "s"} ${isActive ? "taken live" : "paused"}.`,
    });
}

/* ------------------------------------------------------------------ */
/* PATCH /api/seller/catalog/bulk/visibility                           */
/*   { submissionIds, action: "add" | "remove" | "set_mode", ... }     */
/*   add:      buyerIds, discountPercent?, makeRestricted?             */
/*   remove:   buyerIds, clearPrice?                                   */
/*   set_mode: mode: "public" | "restricted"                           */
/* Mirrors the single-listing endpoints in sellerListingVisibility.    */
/* ------------------------------------------------------------------ */
export async function bulkVisibility(req, res) {
    const sellerId = String(req.sellerId);
    const { ids, error: idErr } = cleanIds(req.body?.submissionIds);
    if (idErr) return res.status(400).json({ success: false, message: idErr });

    const action = req.body?.action;
    if (!["add", "remove", "set_mode"].includes(action)) return res.status(400).json({ success: false, message: "Invalid action." });

    const { rows, error } = await loadOwned(sellerId, ids, "id, price, deleted_at");
    if (error) return res.status(500).json({ success: false, message: error.message });

    const skipped = [];
    addMissing(ids, rows, skipped);
    const valid = [];
    for (const r of rows) {
        if (r.deleted_at) skipped.push({ id: String(r.id), reason: REMOVED });
        else valid.push(r);
    }
    const validIds = valid.map((r) => String(r.id));
    if (!validIds.length) return res.json({ success: true, updated: [], skipped, visibilityMode: null, message: "Nothing to update." });

    let visibilityMode = null;
    let buyerIdsForRealtime = [];

    /* ---------- public / restricted ---------- */
    if (action === "set_mode") {
        const mode = req.body?.mode;
        if (!["public", "restricted"].includes(mode)) return res.status(400).json({ success: false, message: "mode must be 'public' or 'restricted'." });

        if (mode === "restricted") {
            // Same backfill as setVisibilityMode: a buyer with a custom price keeps visibility.
            const { data: overrides, error: ovErr } = await supabase.from("buyer_seller_custom_prices")
                .select("submission_id, buyer_id").eq("seller_id", sellerId).in("submission_id", validIds);
            if (ovErr) return res.status(500).json({ success: false, message: ovErr.message });
            const backfill = (overrides || []).map((o) => ({ submission_id: o.submission_id, seller_id: sellerId, buyer_id: o.buyer_id }));
            for (const part of chunk(backfill, 500)) {
                const { error: e } = await supabase.from("seller_listing_visibility")
                    .upsert(part, { onConflict: "submission_id,buyer_id", ignoreDuplicates: true });
                if (e) return res.status(500).json({ success: false, message: e.message });
            }
        }
        const { error: e } = await supabase.from(SUBMISSIONS).update({ visibility_mode: mode }).eq("seller_id", sellerId).in("id", validIds);
        if (e) return res.status(500).json({ success: false, message: e.message });
        visibilityMode = mode;
    } else {
        /* ---------- add / remove buyers ---------- */
        const raw = [...new Set((Array.isArray(req.body?.buyerIds) ? req.body.buyerIds : []).filter((x) => typeof x === "string" && UUID_RE.test(x)))];
        if (!raw.length) return res.status(400).json({ success: false, message: "Choose at least one buyer." });
        if (raw.length > MAX_BUYERS) return res.status(400).json({ success: false, message: `Choose at most ${MAX_BUYERS} buyers at a time.` });

        const companyOf = await resolveCompanyIds(raw);           // team member -> company owner
        const companies = [...new Set(raw.map((b) => String(companyOf.get(String(b)) || b)))].filter((c) => c !== sellerId);
        if (!companies.length) return res.status(400).json({ success: false, message: "You can't add yourself as a buyer." });
        buyerIdsForRealtime = companies;

        if (action === "add") {
            const { data: profs, error: pErr } = await supabase.from("profiles").select("id, deleted_at").in("id", companies);
            if (pErr) return res.status(500).json({ success: false, message: pErr.message });
            const buyers = (profs || []).filter((p) => !p.deleted_at).map((p) => String(p.id));
            if (!buyers.length) return res.status(400).json({ success: false, message: "These buyers aren't available to add." });
            buyerIdsForRealtime = buyers;

            const grants = [];
            for (const sid of validIds) for (const b of buyers) grants.push({ submission_id: sid, seller_id: sellerId, buyer_id: b });
            for (const part of chunk(grants, 500)) {
                const { error: e } = await supabase.from("seller_listing_visibility")
                    .upsert(part, { onConflict: "submission_id,buyer_id", ignoreDuplicates: true });
                if (e) return res.status(500).json({ success: false, message: e.message });
            }

            const rawDiscount = req.body?.discountPercent;
            if (rawDiscount !== undefined && rawDiscount !== null && rawDiscount !== "") {
                const d = Number(rawDiscount);
                if (!Number.isFinite(d) || d < 0 || d > 95) return res.status(400).json({ success: false, message: "Discount must be between 0% and 95%." });
                const now = new Date().toISOString();
                const priceRows = [];
                for (const r of valid) {
                    const base = Number(r.price);
                    if (!(base > 0)) { skipped.push({ id: String(r.id), reason: "Buyers added, but no price is set for a custom price." }); continue; }
                    for (const b of buyers) {
                        priceRows.push({
                            seller_id: sellerId, submission_id: r.id, buyer_id: b,
                            override_type: "percent", discount_percent: Math.round(d * 1e6) / 1e6, fixed_price: null,
                            base_price_at_set: base, updated_at: now,
                        });
                    }
                }
                for (const part of chunk(priceRows, 500)) {
                    const { error: e } = await supabase.from("buyer_seller_custom_prices").upsert(part, { onConflict: "seller_id,buyer_id,submission_id" });
                    if (e) return res.status(500).json({ success: false, message: e.message });
                }
            }

            if (req.body?.makeRestricted === true) {
                const { error: e } = await supabase.from(SUBMISSIONS).update({ visibility_mode: "restricted" }).eq("seller_id", sellerId).in("id", validIds);
                if (e) return res.status(500).json({ success: false, message: e.message });
                visibilityMode = "restricted";
            }
        } else {
            const both = [...new Set([...raw.map(String), ...companies])];
            const { error: e } = await supabase.from("seller_listing_visibility").delete()
                .eq("seller_id", sellerId).in("submission_id", validIds).in("buyer_id", both);
            if (e) return res.status(500).json({ success: false, message: e.message });

            if (req.body?.clearPrice === true) {
                const { error: e2 } = await supabase.from("buyer_seller_custom_prices").delete()
                    .eq("seller_id", sellerId).in("submission_id", validIds).in("buyer_id", both);
                if (e2) return res.status(500).json({ success: false, message: e2.message });
            }
        }
    }

    validIds.forEach((id) => void publishListingChange(id, buyerIdsForRealtime.length ? { buyerIds: buyerIdsForRealtime } : undefined));

    const n = validIds.length;
    res.json({
        success: true,
        updated: validIds.map((id) => ({ id })),
        skipped,
        visibilityMode,
        message: `Updated ${n} listing${n === 1 ? "" : "s"}.`,
    });
}