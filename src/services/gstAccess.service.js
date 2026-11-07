// services/gstAccess.service.js
// Custom prices + visibility keyed by GST number, for buyers who may not be on BBM yet.
//  - buyer on BBM      -> the real tables (buyer_seller_custom_prices / seller_listing_visibility)
//  - buyer not on BBM  -> sales_customer_prices (price) / seller_listing_visibility_pending (access),
//                         promoted automatically when that GST number joins.
import { supabase, supabaseAdmin } from "../config/supabase.js";
import { resolveCompanyId } from "./team.service.js";
import { publishListingChange } from "./listingRealtime.service.js";
import { pingCustomersChanged } from "./salesSync.service.js";
import { resolveGstin, addOne } from "../controllers/sellerCustomers.controller.js";
import { saleUnits, cleanGstin, GSTIN_RE } from "./salesThreads.service.js";
import { priceFromLevel, violatesMinUnitPrice, derivePriceBreakdown, MIN_UNIT_PRICE } from "../../shared/customPricing.js";

const PENDING_VIS = "seller_listing_visibility_pending";
const MAX_PRICE = 9999999999.99;
const MAX_ABS_PERCENT = 9999999999;
const r6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const clampPercent = (p) => Math.max(-MAX_ABS_PERCENT, Math.min(MAX_ABS_PERCENT, Math.round(p * 1e6) / 1e6));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// stored: per listing unit incl. GST (same basis as the Sales module). canonical: per sale unit incl. GST.
export const unitPriceOf = (canonical, sub) => r6(Number(canonical) / saleUnits(sub.pack_size, sub.units_per_master_pack));
export const canonicalOf = (unitPrice, sub) => priceFromLevel(Number(unitPrice), "unit", sub.pack_size, sub.units_per_master_pack);

export function priceProblem(canonical, sub) {
    if (!(Number(canonical) > 0)) return "The price must be greater than ₹0.";
    if (Number(canonical) > MAX_PRICE) return "That price is too large to store.";
    if (violatesMinUnitPrice(canonical, sub.pack_size, sub.units_per_master_pack)) return `That works out to below ₹${MIN_UNIT_PRICE} per unit.`;
    return null;
}

// DB-only check. { companyId } | { self: true } | null
export async function findRegisteredCompany(gstin, sellerId) {
    const { data, error } = await supabaseAdmin.from("business_profiles")
        .select("user_id, profiles!inner(id, role, deleted_at)")
        .eq("gstin", gstin).is("profiles.deleted_at", null).eq("profiles.role", "user")
        .order("created_at", { ascending: false }).limit(1);
    if (error) throw error;
    const bp = data?.[0];
    if (!bp) return null;
    const companyId = String(await resolveCompanyId(bp.user_id));
    return companyId === String(sellerId) ? { self: true } : { companyId };
}

// Validates the GSTIN and returns the business name (+ companyId when on BBM).
export async function resolveTarget({ sellerId, gstin }) {
    const { data: sp } = await supabase.from("seller_profiles").select("user_id").eq("id", sellerId).maybeSingle();
    const sellerUserId = sp?.user_id || null;
    const r = await resolveGstin(gstin, sellerUserId);
    if (r.state === "invalid" || r.state === "self") return { ok: false, state: r.state, message: r.message };
    let companyId = null;
    if (r.state === "registered") {
        companyId = String(await resolveCompanyId(r.userId));
        if (companyId === String(sellerId)) return { ok: false, state: "self", message: "This is your own business." };
    }
    return { ok: true, state: r.state, gstin: r.gstin, name: r.name, location: r.location || null, companyId, sellerUserId };
}

export async function ownedSubmission(sellerId, submissionId) {
    const { data, error } = await supabase.from("seller_product_submissions")
        .select("id, price, pack_size, units_per_master_pack, visibility_mode")
        .eq("id", submissionId).eq("seller_id", sellerId).maybeSingle();
    if (error) throw error;
    return data || null;
}

// Grant access and/or set a price for ONE buyer on ONE listing, by GST number.
export async function setAccessOne({ sellerId, actorId, sub, gstin, grantVisibility, canonical }) {
    const t = await resolveTarget({ sellerId, gstin });
    if (!t.ok) return { ok: false, status: 400, message: t.message || "This GST number can't be used." };
    if (canonical != null) {
        const why = priceProblem(canonical, sub);
        if (why) return { ok: false, status: 400, message: why };
    }
    const now = new Date().toISOString();

    if (t.companyId) { // already on BBM: the real tables
        if (grantVisibility) {
            const { error } = await supabase.from("seller_listing_visibility")
                .upsert({ submission_id: sub.id, seller_id: sellerId, buyer_id: t.companyId }, { onConflict: "submission_id,buyer_id", ignoreDuplicates: true });
            if (error) throw error;
        }
        const base = Number(sub.price);
        if (canonical != null && base > 0) {
            const { error } = await supabase.from("buyer_seller_custom_prices").upsert({
                seller_id: sellerId, buyer_id: t.companyId, submission_id: sub.id, override_type: "percent",
                discount_percent: clampPercent(((base - Number(canonical)) / base) * 100), fixed_price: null,
                base_price_at_set: base, updated_at: now,
            }, { onConflict: "seller_id,buyer_id,submission_id" });
            if (error) throw error;
        }
        void publishListingChange(sub.id, { buyerIds: [t.companyId] });
        return { ok: true, registered: true, name: t.name };
    }

    // not on BBM yet: remembered against the GST number
    if (grantVisibility) {
        const { error } = await supabaseAdmin.from(PENDING_VIS)
            .upsert({ submission_id: sub.id, seller_id: sellerId, customer_gstin: t.gstin, created_by: actorId || null }, { onConflict: "submission_id,customer_gstin", ignoreDuplicates: true });
        if (error) throw error;
    }
    if (canonical != null) {
        const { error } = await supabase.from("sales_customer_prices").upsert({
            seller_id: sellerId, customer_gstin: t.gstin, submission_id: sub.id,
            unit_price_incl: unitPriceOf(canonical, sub), updated_by: actorId || null, updated_at: now,
        }, { onConflict: "seller_id,customer_gstin,submission_id" });
        if (error) throw error;
    }
    // the buyer may have joined while we were writing: promote right away instead of leaving the rows stranded
    const nowReg = await findRegisteredCompany(t.gstin, sellerId);
    if (nowReg?.companyId) {
        await promotePendingVisibilityForBuyer({ userId: nowReg.companyId, gstin: t.gstin });
        const { applyPendingCustomPricesForBuyer } = await import("./salesQuotePricing.service.js"); // lazy: avoids an import cycle
        await applyPendingCustomPricesForBuyer({ userId: nowReg.companyId, gstin: t.gstin });
        return { ok: true, registered: true, name: t.name };
    }
    // keep the business in the seller's customer list (best effort, like quotations do)
    try {
        const out = await addOne(sellerId, t.sellerUserId, t.gstin, "gst", {});
        if (out?.result === "invited" || out?.result === "added") await pingCustomersChanged(sellerId, []);
    } catch (e) { console.error("[gst access] add customer failed:", e?.message || e); }
    return { ok: true, registered: false, name: t.name };
}

// part: "visibility" | "price" | "all". Handles both the pending rows and (if they have joined) the real rows.
export async function removeAccessOne({ sellerId, submissionId, gstin, part = "all" }) {
    const vis = part !== "price", price = part !== "visibility";
    const reg = await findRegisteredCompany(gstin, sellerId);
    if (vis) {
        const { error } = await supabaseAdmin.from(PENDING_VIS).delete().eq("seller_id", sellerId).eq("submission_id", submissionId).eq("customer_gstin", gstin);
        if (error) throw error;
    }
    if (price) {
        const { error } = await supabase.from("sales_customer_prices").delete().eq("seller_id", sellerId).eq("submission_id", submissionId).eq("customer_gstin", gstin);
        if (error) throw error;
    }
    if (reg?.companyId) {
        if (vis) await supabase.from("seller_listing_visibility").delete().eq("seller_id", sellerId).eq("submission_id", submissionId).eq("buyer_id", reg.companyId);
        if (price) await supabase.from("buyer_seller_custom_prices").delete().eq("seller_id", sellerId).eq("submission_id", submissionId).eq("buyer_id", reg.companyId);
        void publishListingChange(submissionId, { buyerIds: [reg.companyId] });
    }
}

// Buyers on ONE listing that are still waiting for BBM (access and/or price).
export async function listPendingForListing({ sellerId, sub }) {
    const [vis, prices] = await Promise.all([
        supabaseAdmin.from(PENDING_VIS).select("customer_gstin").eq("seller_id", sellerId).eq("submission_id", sub.id),
        supabase.from("sales_customer_prices").select("customer_gstin, unit_price_incl, updated_at").eq("seller_id", sellerId).eq("submission_id", sub.id),
    ]);
    if (vis.error) throw vis.error;
    if (prices.error) throw prices.error;
    const gst = [...new Set([...(vis.data || []).map((r) => r.customer_gstin), ...(prices.data || []).map((r) => r.customer_gstin)])];
    if (!gst.length) return [];

    const [reg, names] = await Promise.all([
        supabaseAdmin.from("business_profiles").select("gstin, profiles!inner(id, role, deleted_at)")
            .in("gstin", gst).is("profiles.deleted_at", null).eq("profiles.role", "user"),
        supabase.from("seller_customers").select("gstin, business_name").eq("seller_id", sellerId).in("gstin", gst),
    ]);
    if (reg.error) throw reg.error;
    const joined = new Set((reg.data || []).map((r) => r.gstin)); // these use the real tables
    const nameBy = new Map((names.data || []).map((r) => [r.gstin, r.business_name]));
    const hasVis = new Set((vis.data || []).map((r) => r.customer_gstin));
    const priceBy = new Map((prices.data || []).map((r) => [r.customer_gstin, r]));

    return gst.filter((g) => !joined.has(g)).map((g) => {
        const p = priceBy.get(g);
        const eff = p ? canonicalOf(p.unit_price_incl, sub) : null;
        return {
            gstin: g, name: nameBy.get(g) || `GSTIN ${g}`, hasVisibilityGrant: hasVis.has(g),
            override: p ? { effectivePrice: eff, effectiveBreakdown: derivePriceBreakdown(eff, sub.pack_size, sub.units_per_master_pack), updatedAt: p.updated_at } : null,
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function pendingPricesForCustomer(sellerId, gstin) {
    const { data, error } = await supabase.from("sales_customer_prices")
        .select("submission_id, unit_price_incl, updated_at").eq("seller_id", sellerId).eq("customer_gstin", gstin);
    if (error) throw error;
    return new Map((data || []).map((r) => [r.submission_id, r]));
}

// entries: [{ sub, canonical }] -> { saved, rejected: [{ submissionId, reason }] }
export async function savePendingPrices({ sellerId, actorId, gstin, entries }) {
    const rows = [], rejected = [], now = new Date().toISOString();
    for (const { sub, canonical } of entries) {
        const why = priceProblem(canonical, sub);
        if (why) { rejected.push({ submissionId: sub.id, reason: why }); continue; }
        rows.push({ seller_id: sellerId, customer_gstin: gstin, submission_id: sub.id, unit_price_incl: unitPriceOf(canonical, sub), updated_by: actorId || null, updated_at: now });
    }
    if (rows.length) {
        const { error } = await supabase.from("sales_customer_prices").upsert(rows, { onConflict: "seller_id,customer_gstin,submission_id" });
        if (error) throw error;
    }
    return { saved: rows.length, rejected };
}

export async function deletePendingPrices({ sellerId, gstin, submissionIds }) {
    let q = supabase.from("sales_customer_prices").delete().eq("seller_id", sellerId).eq("customer_gstin", gstin);
    if (Array.isArray(submissionIds) && submissionIds.length) q = q.in("submission_id", submissionIds);
    const { error } = await q;
    if (error) throw error;
}

// Create flow: GST-only buyers of a just-created listing. Never throws.
export async function savePendingFromDraft({ sellerId, submissionId, buyers }) {
    try {
        const sub = await ownedSubmission(sellerId, submissionId);
        if (!sub) return;
        for (const b of buyers) {
            const g = cleanGstin(b.gstin);
            if (!GSTIN_RE.test(g)) continue;
            try {
                const canonical = b.override?.canonicalPrice != null ? Number(b.override.canonicalPrice) : null;
                const r = await setAccessOne({ sellerId, actorId: null, sub, gstin: g, grantVisibility: true, canonical });
                if (!r.ok) console.error("[gst access] draft buyer skipped:", g, r.message);
            } catch (e) { console.error("[gst access] draft buyer failed:", g, e?.message || e); }
        }
    } catch (e) { console.error("[gst access] draft failed:", e?.message || e); }
}

// A buyer just joined with this GST number: pending access becomes real access. Idempotent, never throws.
export async function promotePendingVisibilityForBuyer({ userId, gstin }) {
    const done = { granted: 0 };
    try {
        const g = cleanGstin(gstin);
        if (!userId || !GSTIN_RE.test(g)) return done;
        const buyerId = String(await resolveCompanyId(userId));
        const { data: rows, error } = await supabaseAdmin.from(PENDING_VIS).select("submission_id, seller_id").eq("customer_gstin", g).limit(1000);
        if (error) throw error;
        if (!rows?.length) return done;

        const sellerIds = [...new Set(rows.map((r) => r.seller_id))];
        const { data: sellers, error: sErr } = await supabase.from("seller_profiles").select("id, user_id").in("id", sellerIds);
        if (sErr) throw sErr;
        const own = new Set();
        await Promise.all((sellers || []).map(async (s) => { if (String(await resolveCompanyId(s.user_id)) === buyerId) own.add(String(s.id)); }));

        const grants = rows.filter((r) => !own.has(String(r.seller_id)))
            .map((r) => ({ submission_id: r.submission_id, seller_id: r.seller_id, buyer_id: buyerId }));
        for (const part of chunk(grants, 500)) {
            const { error: e } = await supabase.from("seller_listing_visibility").upsert(part, { onConflict: "submission_id,buyer_id", ignoreDuplicates: true });
            if (e) throw e; // keep the pending rows so a later call can retry
        }
        for (const part of chunk(rows.map((r) => r.submission_id), 100)) {
            await supabaseAdmin.from(PENDING_VIS).delete().eq("customer_gstin", g).in("submission_id", part);
        }
        done.granted = grants.length;
        for (const part of chunk(grants, 5)) {
            await Promise.allSettled(part.map((x) => publishListingChange(x.submission_id, { buyerIds: [buyerId] })));
        }
        return done;
    } catch (e) {
        console.error("[gst access] promoting pending access failed:", e?.message || e);
        return done;
    }
}