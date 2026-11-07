// controllers/gstAccess.controller.js
import { supabase } from "../config/supabase.js";
import { cleanGstin, GSTIN_RE } from "../services/salesThreads.service.js";
import { isUuid } from "../services/rfqValidation.js";
import { hasOuterPack } from "../../shared/packUnits.js";
import { derivePriceBreakdown } from "../../shared/customPricing.js";
import { CATALOG_REMOVED_REJECTION_REASON } from "./sellerCatalogListings.controller.js";
import {
    listCustomPricingForBuyer, upsertCustomPricing, deleteCustomPricing, bulkClearCustomPricing,
} from "./customPricing.controller.js";
import {
    resolveTarget, findRegisteredCompany, ownedSubmission, setAccessOne, removeAccessOne, listPendingForListing,
    pendingPricesForCustomer, savePendingPrices, deletePendingPrices, canonicalOf, priceProblem,
} from "../services/gstAccess.service.js";

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const actorOf = (req) => req.actor?.id || req.user?.id || null;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// POST /lookup { gstin, submissionId? } -> preview of the business + whether it is already added to the listing
export async function lookup(req, res) {
    const g = cleanGstin(req.body?.gstin);
    if (!GSTIN_RE.test(g)) return fail(res, 400, "Enter all 15 characters of the GST number.");
    const t = await resolveTarget({ sellerId: req.sellerId, gstin: g });
    if (!t.ok) return res.json({ success: true, state: t.state, gstin: g, message: t.message });

    let already = { visibility: false, price: false };
    const sid = req.body?.submissionId;
    if (isUuid(sid)) {
        if (t.companyId) {
            const [v, p] = await Promise.all([
                supabase.from("seller_listing_visibility").select("submission_id").eq("submission_id", sid).eq("buyer_id", t.companyId).maybeSingle(),
                supabase.from("buyer_seller_custom_prices").select("submission_id").eq("submission_id", sid).eq("seller_id", req.sellerId).eq("buyer_id", t.companyId).maybeSingle(),
            ]);
            already = { visibility: !!v.data, price: !!p.data };
        } else {
            const [v, p] = await Promise.all([
                supabase.from("seller_listing_visibility_pending").select("submission_id").eq("submission_id", sid).eq("customer_gstin", g).maybeSingle(),
                supabase.from("sales_customer_prices").select("submission_id").eq("submission_id", sid).eq("seller_id", req.sellerId).eq("customer_gstin", g).maybeSingle(),
            ]);
            already = { visibility: !!v.data, price: !!p.data };
        }
    }
    res.json({
        success: true, state: t.state, gstin: t.gstin, name: t.name, location: t.location,
        companyId: t.companyId || null, onBbm: !!t.companyId, already,
    });
}

// GET /listing/:submissionId -> buyers still waiting for BBM
export async function listingPending(req, res) {
    if (!isUuid(req.params.submissionId)) return fail(res, 404, "Listing not found.");
    const sub = await ownedSubmission(req.sellerId, req.params.submissionId);
    if (!sub) return fail(res, 404, "Listing not found.");
    res.json({ success: true, buyers: await listPendingForListing({ sellerId: req.sellerId, sub }) });
}

// POST /listing/:submissionId/buyer { gstin, grantVisibility?, price?: { canonicalPrice } }
export async function listingAddBuyer(req, res) {
    const g = cleanGstin(req.body?.gstin);
    if (!GSTIN_RE.test(g)) return fail(res, 400, "Enter all 15 characters of the GST number.");
    if (!isUuid(req.params.submissionId)) return fail(res, 404, "Listing not found.");
    const sub = await ownedSubmission(req.sellerId, req.params.submissionId);
    if (!sub) return fail(res, 404, "Listing not found.");
    const raw = req.body?.price?.canonicalPrice;
    const canonical = raw != null && raw !== "" ? Number(raw) : null;
    if (canonical != null && !Number.isFinite(canonical)) return fail(res, 400, "Enter a valid price.");
    const out = await setAccessOne({
        sellerId: req.sellerId, actorId: actorOf(req), sub, gstin: g,
        grantVisibility: req.body?.grantVisibility === true, canonical,
    });
    if (!out.ok) return fail(res, out.status || 400, out.message);
    res.json({ success: true, registered: out.registered, name: out.name });
}

// DELETE /listing/:submissionId/buyer/:gstin?part=visibility|price|all
export async function listingRemoveBuyer(req, res) {
    const g = cleanGstin(req.params.gstin);
    if (!GSTIN_RE.test(g) || !isUuid(req.params.submissionId)) return fail(res, 400, "Invalid request.");
    if (!(await ownedSubmission(req.sellerId, req.params.submissionId))) return fail(res, 404, "Listing not found.");
    const part = ["visibility", "price"].includes(req.query.part) ? req.query.part : "all";
    await removeAccessOne({ sellerId: req.sellerId, submissionId: req.params.submissionId, gstin: g, part });
    res.json({ success: true });
}

/* ---------------- per customer (many products), by GST number ---------------- */
// If the GST number has joined BBM, the request is handed to the existing registered-buyer handlers.
async function customerGuard(req, res) {
    const g = cleanGstin(req.params.gstin);
    if (!GSTIN_RE.test(g)) { fail(res, 400, "Enter a valid GST number."); return null; }
    const reg = await findRegisteredCompany(g, req.sellerId);
    if (reg?.self) { fail(res, 400, "You can't set a price for your own company."); return null; }
    return { g, companyId: reg?.companyId || null };
}
const asBuyer = (req, companyId) => { req.params = { ...req.params, buyerId: companyId }; };

export async function customerList(req, res) {
    const c = await customerGuard(req, res); if (!c) return;
    if (c.companyId) { asBuyer(req, c.companyId); return listCustomPricingForBuyer(req, res); }

    const sellerId = req.sellerId;
    const [subsRes, prices] = await Promise.all([
        supabase.from("seller_product_submissions")
            .select("id, product_name, brand_name, image, price, unit, is_active, pack_size, units_per_master_pack, gst_percent, hs_generic_product_brands!inner ( deleted_at )")
            .eq("seller_id", sellerId).eq("review_status", "approved")
            .is("hs_generic_product_brands.deleted_at", null)
            .or(`rejection_reason.is.null,rejection_reason.neq.${CATALOG_REMOVED_REJECTION_REASON}`)
            .order("product_name", { ascending: true }),
        pendingPricesForCustomer(sellerId, c.g),
    ]);
    if (subsRes.error) return fail(res, 500, subsRes.error.message);

    const items = (subsRes.data || []).map((s) => {
        const p = prices.get(s.id);
        const defaultPrice = Number(s.price);
        const effectivePrice = p ? canonicalOf(p.unit_price_incl, s) : defaultPrice;
        return {
            submissionId: s.id, name: s.product_name, brandName: s.brand_name, image: s.image, unit: s.unit,
            packSize: Number(s.pack_size) || 1, masterPackSize: Number(s.units_per_master_pack) || 1,
            hasMasterPack: hasOuterPack(s.units_per_master_pack), isActive: s.is_active, gstPercent: Number(s.gst_percent) || 0,
            defaultPrice, effectivePrice,
            defaultBreakdown: derivePriceBreakdown(defaultPrice, s.pack_size, s.units_per_master_pack),
            effectiveBreakdown: derivePriceBreakdown(effectivePrice, s.pack_size, s.units_per_master_pack),
            override: p ? { overrideType: "fixed", discountPercent: null, fixedPrice: effectivePrice, basePriceAtSet: defaultPrice, updatedAt: p.updated_at } : null,
        };
    });
    res.json({ success: true, items, customPricedCount: items.filter((i) => i.override).length });
}

// body: { items: [{ submissionId, overrideType: "percent"|"fixed", value, inputMode }] } (same as the registered endpoint)
export async function customerSave(req, res) {
    const c = await customerGuard(req, res); if (!c) return;
    if (c.companyId) { asBuyer(req, c.companyId); return upsertCustomPricing(req, res); }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return fail(res, 400, "No items provided.");
    const ids = [...new Set(items.map((i) => i.submissionId).filter(isUuid))];
    const { data: subs, error } = await supabase.from("seller_product_submissions")
        .select("id, price, pack_size, units_per_master_pack, hs_generic_product_brands!inner ( deleted_at )")
        .eq("seller_id", req.sellerId).eq("review_status", "approved")
        .is("hs_generic_product_brands.deleted_at", null)
        .or(`rejection_reason.is.null,rejection_reason.neq.${CATALOG_REMOVED_REJECTION_REASON}`)
        .in("id", ids);
    if (error) return fail(res, 500, error.message);
    const byId = new Map((subs || []).map((s) => [s.id, s]));

    const entries = [], rejected = [];
    for (const it of items) {
        const sub = byId.get(it.submissionId);
        const base = Number(sub?.price);
        if (!sub || !(base > 0)) { rejected.push({ submissionId: it.submissionId, reason: "not_found_or_not_eligible" }); continue; }
        const v = Number(it.value);
        if (!Number.isFinite(v)) { rejected.push({ submissionId: it.submissionId, reason: "invalid_price" }); continue; }
        const fixed = it.overrideType === "fixed" || it.inputMode === "fixed_price" || it.inputMode === "typed_price";
        entries.push({ sub, canonical: fixed ? round2(v) : round2(base * (1 - v / 100)) });
    }
    if (!entries.length) return res.status(400).json({ success: false, message: "Nothing valid to save.", rejected });
    const out = await savePendingPrices({ sellerId: req.sellerId, actorId: actorOf(req), gstin: c.g, entries });
    res.json({ success: true, saved: out.saved, rejected: [...rejected, ...out.rejected] });
}

export async function customerDeleteOne(req, res) {
    const c = await customerGuard(req, res); if (!c) return;
    if (c.companyId) { asBuyer(req, c.companyId); return deleteCustomPricing(req, res); }
    if (!isUuid(req.params.submissionId)) return fail(res, 404, "Listing not found.");
    await deletePendingPrices({ sellerId: req.sellerId, gstin: c.g, submissionIds: [req.params.submissionId] });
    res.json({ success: true });
}

export async function customerBulkClear(req, res) {
    const c = await customerGuard(req, res); if (!c) return;
    if (c.companyId) { asBuyer(req, c.companyId); return bulkClearCustomPricing(req, res); }
    const ids = Array.isArray(req.body?.submissionIds) ? req.body.submissionIds.filter(isUuid) : [];
    await deletePendingPrices({ sellerId: req.sellerId, gstin: c.g, submissionIds: ids });
    res.json({ success: true });
}