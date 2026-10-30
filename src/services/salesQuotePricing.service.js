// services/salesQuotePricing.service.js
// Quotation / punched order -> per-buyer custom price on BBM.
// When a salesperson quotes (or punches an order at) a price for a customer who is a BBM buyer, the same price can be
// stored in buyer_seller_custom_prices (exactly like customPricing.controller.upsertCustomPricing does), so the buyer
// really sees / pays that price on the marketplace.
// Prices are always remembered per customer GST number (sales_customer_prices). When the customer is not on BBM yet,
// that is all that happens; applyPendingCustomPricesForBuyer() turns the remembered prices into real custom prices
// the moment a buyer joins with that GST number.
import { supabase, supabaseAdmin } from "../config/supabase.js";
import { resolveCompanyId } from "./team.service.js";
import { publishListingChange } from "./listingRealtime.service.js";
import { CATALOG_REMOVED_REJECTION_REASON } from "../controllers/sellerCatalogListings.controller.js";
import {
    priceFromLevel, resolveEffectiveBasePrice, violatesMinUnitPrice, MIN_UNIT_PRICE,
} from "../../shared/customPricing.js";
import { saleUnits, round4, listingProblem, cleanGstin, GSTIN_RE } from "./salesThreads.service.js";
import { cached } from "./cache.service.js";


const MAX_ABS_PERCENT = 9999999999;   // numeric(16,6)
const MAX_PRICE = 9999999999.99;      // numeric(12,2)
const PENDING_LIMIT = 1000;
const clampPercent = (p) => Math.max(-MAX_ABS_PERCENT, Math.min(MAX_ABS_PERCENT, Math.round(p * 1e6) / 1e6));
const r6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const nameOf = (bp) => bp?.display_name?.trim() || bp?.trade_name?.trim() || bp?.legal_name?.trim() || "this customer";
const NOT_LIVE = "This listing isn't live, so no BBM price was set.";


export async function findBuyerCompanyByGstin(gstin, ownerId) {
    if (!gstin) return null;
    return cached(`buyer:${gstin}:${ownerId}`, 120, () => lookupBuyerCompany(gstin, ownerId));
}
// GSTIN -> the buyer COMPANY id (same id custom pricing uses as buyer_id).
// Returns null when the GSTIN isn't on BBM, { self: true } when it is the seller's own company.
// Newest profile first, so the answer is the same every time even if a GSTIN were ever held twice.
export async function lookupBuyerCompany(gstin, ownerId) {
    if (!gstin) return null;
    const { data, error } = await supabaseAdmin
        .from("business_profiles")
        .select("user_id, display_name, trade_name, legal_name, profiles!inner(id, role, deleted_at)")
        .eq("gstin", gstin)
        .is("profiles.deleted_at", null)
        .eq("profiles.role", "user")
        .order("created_at", { ascending: false })
        .limit(1);
    if (error) throw error;
    const bp = data?.[0];
    if (!bp) return null;
    const companyId = String(await resolveCompanyId(bp.user_id));
    if (companyId === String(ownerId) || String(bp.user_id) === String(ownerId)) return { self: true };
    return { companyId, name: nameOf(bp) };
}

// The buyer's current custom prices (for this seller) on the given listings.
export async function fetchBuyerOverrides(sellerId, buyerId, submissionIds) {
    const ids = [...new Set((submissionIds || []).filter(Boolean))];
    if (!buyerId || !ids.length) return new Map();
    const { data, error } = await supabase
        .from("buyer_seller_custom_prices")
        .select("submission_id, override_type, discount_percent, fixed_price")
        .eq("seller_id", sellerId).eq("buyer_id", buyerId).in("submission_id", ids);
    if (error) throw error;
    return new Map((data || []).map((r) => [r.submission_id, r]));
}

// Current custom price of a buyer for one listing, per BASE unit incl. GST (same basis the quote sheet uses).
export function customUnitPriceOf(sub, override) {
    if (!override) return null;
    const eff = resolveEffectiveBasePrice(Number(sub.price), override);
    if (!(eff > 0)) return null;
    return round4(eff / saleUnits(sub.pack_size, sub.units_per_master_pack));
}

// lines: [{ submissionId, productName, unitPriceIncl, sub }]  (sub = seller_product_submissions row)
async function applyLines({ sellerId, buyerId, lines }) {
    const out = { applied: [], removed: [], unchanged: [], skipped: [] };
    const rows = [], same = [];
    const skip = (l, reason) => out.skipped.push({ submissionId: l.submissionId, productName: l.productName, reason });

    for (const l of lines) {
        const s = l.sub;
        const base = Number(s.price);
        if (!(base > 0)) { skip(l, "The listing has no valid price."); continue; }
        if (s.rejection_reason === CATALOG_REMOVED_REJECTION_REASON) { skip(l, "This listing was removed from the catalog."); continue; }

        // quote price is per base unit incl. GST -> per sale unit, the basis the listing price is stored in
        const canonical = priceFromLevel(l.unitPriceIncl, "unit", s.pack_size, s.units_per_master_pack);
        if (!(canonical > 0)) { skip(l, "The price must be greater than ₹0."); continue; }
        if (canonical > MAX_PRICE) { skip(l, "That price is too large to store."); continue; }
        if (violatesMinUnitPrice(canonical, s.pack_size, s.units_per_master_pack)) { skip(l, `That works out to below ₹${MIN_UNIT_PRICE} per unit.`); continue; }

        if (Math.abs(canonical - base) < 0.005) { same.push(l); continue; }

        // Stored as a percent of the listing price (so it follows future price changes), but only when that
        // percent resolves back to EXACTLY the quoted price. Otherwise store the exact fixed price.
        const percent = clampPercent(((base - canonical) / base) * 100);   // +ve = discount, -ve = markup
        const viaPercent = resolveEffectiveBasePrice(base, { override_type: "percent", discount_percent: percent });
        const exact = Math.abs(viaPercent - canonical) < 0.005;
        rows.push({
            seller_id: sellerId, buyer_id: buyerId, submission_id: l.submissionId,
            override_type: exact ? "percent" : "fixed",
            discount_percent: exact ? percent : null,
            fixed_price: exact ? null : canonical,
            base_price_at_set: base,
            _line: l,
        });
    }

    try {
        if (rows.length) {
            const { error } = await supabase.from("buyer_seller_custom_prices")
                .upsert(rows.map(({ _line, ...r }) => r), { onConflict: "seller_id,buyer_id,submission_id" });
            if (error) throw error;
            rows.forEach((r) => out.applied.push({ submissionId: r.submission_id, productName: r._line.productName, unitPriceIncl: r._line.unitPriceIncl }));
        }
    } catch (e) {
        console.error("[sales quote] custom price upsert failed:", e?.message || e);
        rows.forEach((r) => skip(r._line, "Couldn't be saved. Set it from the Customers page."));
        rows.length = 0;
    }

    try {
        if (same.length) {
            // The quoted price equals the listing price: a leftover custom price would contradict the quotation.
            const { data, error } = await supabase.from("buyer_seller_custom_prices").delete()
                .eq("seller_id", sellerId).eq("buyer_id", buyerId).in("submission_id", same.map((l) => l.submissionId))
                .select("submission_id");
            if (error) throw error;
            const gone = new Set((data || []).map((d) => d.submission_id));
            same.forEach((l) => {
                const item = { submissionId: l.submissionId, productName: l.productName };
                (gone.has(l.submissionId) ? out.removed : out.unchanged).push(item);
            });
        }
    } catch (e) {
        console.error("[sales quote] custom price delete failed:", e?.message || e);
        same.forEach((l) => skip(l, "The old custom price couldn't be removed."));
    }

    [...out.applied, ...out.removed].forEach((x) => { void publishListingChange(x.submissionId, { buyerIds: [buyerId] }); });
    return out;
}

// Never throws: the quotation must be sent even if this step fails.
// status: "none" | "done" | "not_on_bbm" | "own_company" | "failed"
// The buyer is looked up fresh (not from the 2-minute cache), so a buyer who has just joined BBM is never missed.
export async function syncQuoteCustomPrices({ sellerId, ownerId, gstin, items, subsById }) {
    const wanted = items.filter((i) => i.setCustomPrice);
    const empty = { applied: [], removed: [], unchanged: [], skipped: [] };
    if (!wanted.length) return { status: "none", buyerName: null, ...empty };
    try {
        const buyer = await lookupBuyerCompany(gstin, ownerId);
        if (!buyer) return { status: "not_on_bbm", buyerName: null, ...empty };
        if (buyer.self) return { status: "own_company", buyerName: null, ...empty };

        const lines = wanted.map((i) => ({
            submissionId: i.submissionId, productName: i.productName, unitPriceIncl: i.unitPriceIncl, sub: subsById.get(i.submissionId),
        })).filter((l) => l.sub);
        const res = await applyLines({ sellerId, buyerId: buyer.companyId, lines });
        return { status: "done", buyerName: buyer.name, buyerId: buyer.companyId, ...res };
    } catch (e) {
        console.error("[sales quote] custom price sync failed:", e?.message || e);
        return { status: "failed", buyerName: null, ...empty };
    }
}

// Order Book: a punched order's catalog lines become the customer's price, by GST number.
//   items    : the order lines built by orderBook.controller (unitPrice is per pack / master pack, GST included;
//              unitsPerSaleUnit says how many listing units that pack holds)
//   subsById : Map(submissionId -> seller_product_submissions row)
// 1) remembers the price per GST number (sales_customer_prices), whether or not the customer is on BBM;
// 2) when the customer is on BBM, sets the real custom price right now.
// The remembered price is saved BEFORE the buyer lookup: if the buyer signs up at the same moment, either this step sees
// the new buyer, or applyPendingCustomPricesForBuyer sees this remembered price. Never throws.
// Same result shape as syncQuoteCustomPrices.
export async function applyOrderCustomPrices({ sellerId, ownerId, actorId, gstin, items, subsById }) {
    const none = { status: "none", buyerName: null, applied: [], removed: [], unchanged: [], skipped: [] };
    try {
        if (!gstin) return none;
        const eligible = [], notLive = [];
        for (const i of items || []) {
            if (!i.submissionId || !(Number(i.unitsPerSaleUnit) > 0) || !(Number(i.unitPrice) > 0)) continue;
            const sub = subsById.get(i.submissionId);
            if (!sub) continue;
            if (listingProblem(sub)) { notLive.push({ submissionId: i.submissionId, productName: i.productName, reason: NOT_LIVE }); continue; }
            eligible.push({
                submissionId: i.submissionId, productName: i.productName,
                unitPriceIncl: r6(Number(i.unitPrice) / Number(i.unitsPerSaleUnit)),   // per listing unit, GST included
                setCustomPrice: true,
            });
        }
        if (!eligible.length) return { ...none, skipped: notLive };

        const { error } = await supabase.from("sales_customer_prices").upsert(
            eligible.map((i) => ({
                seller_id: sellerId, customer_gstin: gstin, submission_id: i.submissionId,
                unit_price_incl: i.unitPriceIncl, updated_by: actorId || null, updated_at: new Date().toISOString(),
            })), { onConflict: "seller_id,customer_gstin,submission_id" });
        if (error) console.error("[order book] customer price save failed:", error.message);

        const res = await syncQuoteCustomPrices({ sellerId, ownerId, gstin, items: eligible, subsById });
        return { ...res, skipped: [...(res.skipped || []), ...notLive] };
    } catch (e) {
        console.error("[order book] custom price step failed:", e?.message || e);
        return { ...none, status: "failed" };
    }
}

// A buyer just joined BBM (or changed their GST number): turn every price remembered for that GST number
// (quotations and punched orders of ANY seller) into real custom prices. Idempotent, never throws, never overwrites a
// custom price the seller has already set for this buyer, and never gives a seller's own company a price on its own
// listings. Called from auth.controller.completeProfile after the GSTIN is saved:
//     void applyPendingCustomPricesForBuyer({ userId, gstin });
export async function applyPendingCustomPricesForBuyer({ userId, gstin }) {
    const done = { applied: 0, sellers: 0 };
    try {
        const g = cleanGstin(gstin);
        if (!userId || !GSTIN_RE.test(g)) return done;
        const buyerId = String(await resolveCompanyId(userId));

        const { data: pending, error } = await supabase.from("sales_customer_prices")
            .select("seller_id, submission_id, unit_price_incl")
            .eq("customer_gstin", g).limit(PENDING_LIMIT);
        if (error) throw error;
        const rows = pending || [];
        if (!rows.length) return done;

        const ids = [...new Set(rows.map((p) => p.submission_id))];
        const sellerIds = [...new Set(rows.map((p) => p.seller_id))];
        const [subsRes, haveRes, sellersRes] = await Promise.all([
            supabase.from("seller_product_submissions")
                .select("id, seller_id, product_name, price, pack_size, units_per_master_pack, rejection_reason, review_status, is_active, expires_at, hs_generic_product_brands!inner(deleted_at)")
                .in("id", ids).is("hs_generic_product_brands.deleted_at", null),
            supabase.from("buyer_seller_custom_prices").select("submission_id").eq("buyer_id", buyerId).in("submission_id", ids),
            supabase.from("seller_profiles").select("id, user_id").in("id", sellerIds),
        ]);
        if (subsRes.error) throw subsRes.error;
        if (haveRes.error) throw haveRes.error;
        if (sellersRes.error) throw sellersRes.error;
        const subById = new Map((subsRes.data || []).map(({ hs_generic_product_brands, ...s }) => [s.id, s]));
        const has = new Set((haveRes.data || []).map((r) => r.submission_id));

        // sellers whose own company is this buyer: they never get a custom price on their own listings
        const own = new Set();
        await Promise.all((sellersRes.data || []).map(async (s) => {
            if (String(await resolveCompanyId(s.user_id)) === buyerId) own.add(String(s.id));
        }));

        const bySeller = new Map();
        for (const p of rows) {
            const sub = subById.get(p.submission_id);
            if (!sub || own.has(String(p.seller_id)) || has.has(p.submission_id)) continue;
            if (String(sub.seller_id) !== String(p.seller_id) || listingProblem(sub)) continue;
            const list = bySeller.get(p.seller_id) || [];
            list.push({ submissionId: p.submission_id, productName: sub.product_name, unitPriceIncl: Number(p.unit_price_incl), sub });
            bySeller.set(p.seller_id, list);
        }

        for (const [sellerId, lines] of bySeller) {
            const res = await applyLines({ sellerId, buyerId, lines });
            done.applied += res.applied.length;
            if (res.applied.length) done.sellers += 1;
        }
        return done;
    } catch (e) {
        console.error("[custom price] applying remembered prices for a new buyer failed:", e?.message || e);
        return done;
    }
}