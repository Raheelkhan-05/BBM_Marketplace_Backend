// services/salesQuotePricing.service.js
// Quotation -> per-buyer custom price on BBM.
// When a salesperson quotes a price to a customer who is a BBM buyer, the same price can be stored in
// buyer_seller_custom_prices (exactly like customPricing.controller.upsertCustomPricing does), so the buyer
// really sees / pays that price on the marketplace.
import { supabase, supabaseAdmin } from "../config/supabase.js";
import { resolveCompanyId } from "./team.service.js";
import { publishListingChange } from "./listingRealtime.service.js";
import { CATALOG_REMOVED_REJECTION_REASON } from "../controllers/sellerCatalogListings.controller.js";
import {
    priceFromLevel, resolveEffectiveBasePrice, violatesMinUnitPrice, MIN_UNIT_PRICE,
} from "../../shared/customPricing.js";
import { saleUnits, round4 } from "./salesThreads.service.js";
import { cached } from "./cache.service.js";


const MAX_ABS_PERCENT = 9999999999;   // numeric(16,6)
const MAX_PRICE = 9999999999.99;      // numeric(12,2)
const clampPercent = (p) => Math.max(-MAX_ABS_PERCENT, Math.min(MAX_ABS_PERCENT, Math.round(p * 1e6) / 1e6));
const nameOf = (bp) => bp?.display_name?.trim() || bp?.trade_name?.trim() || bp?.legal_name?.trim() || "this customer";


export async function findBuyerCompanyByGstin(gstin, ownerId) {
    if (!gstin) return null;
    return cached(`buyer:${gstin}:${ownerId}`, 120, () => lookupBuyerCompany(gstin, ownerId));
}
// GSTIN -> the buyer COMPANY id (same id custom pricing uses as buyer_id).
// Returns null when the GSTIN isn't on BBM, { self: true } when it is the seller's own company.
export async function lookupBuyerCompany(gstin, ownerId) {
    if (!gstin) return null;
    const { data, error } = await supabaseAdmin
        .from("business_profiles")
        .select("user_id, display_name, trade_name, legal_name, profiles!inner(id, role, deleted_at)")
        .eq("gstin", gstin)
        .is("profiles.deleted_at", null)
        .eq("profiles.role", "user")
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

        // always stored as a percent of the listing price, so it follows future price changes
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
export async function syncQuoteCustomPrices({ sellerId, ownerId, gstin, items, subsById }) {
    const wanted = items.filter((i) => i.setCustomPrice);
    const empty = { applied: [], removed: [], unchanged: [], skipped: [] };
    if (!wanted.length) return { status: "none", buyerName: null, ...empty };
    try {
        const buyer = await findBuyerCompanyByGstin(gstin, ownerId);
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