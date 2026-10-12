// services/rfqQuotes.service.js — shared quote helpers (rfq.controller + rfqQuote.controller)
import { supabase } from "../config/supabase.js";
import { round2, round4, breakdownFromUnitIncl, moqInUnits } from "../../shared/rfqQuoteMath.js";

export { round2 };

export function perBaseUnit(salePrice, packSize, masterPackSize) {
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(masterPackSize) > 0 ? Number(masterPackSize) : 1;
    return Number(salePrice) / (pack * master);
}
export const sameUnit = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Same formula as the catalog SQL functions. Returns GST-inclusive price per SALE unit.
export function customSalePrice(basePrice, cp) {
    if (!cp) return null;
    if (cp.override_type === "fixed") return cp.fixed_price != null ? Number(cp.fixed_price) : null;
    return round2(Number(basePrice) * (1 - (Number(cp.discount_percent) || 0) / 100));
}

// quote row (+ seller join) -> API shape. `enquiry` is the rfq_enquiries row.
// Delivery estimate is buyer-only: sellers never receive it.
export function quoteToDto(row, enquiry, { forBuyer = false } = {}) {
    const packSize = Number(enquiry.pack_size) || 1;
    const qty = Number(enquiry.quantity) || 0;
    const totalUnits = qty * packSize;
    const unitIncl = Number(row.price_per_unit);
    const g = Number(row.gst_percent) || 0;
    const bd = breakdownFromUnitIncl(unitIncl, g, totalUnits);
    const lp = Number(row.listing_pack_size) || null;
    const lm = Number(row.listing_master_pack_size) || null;

    const dto = {
        id: row.id,
        enquiryId: row.enquiry_id,
        price: round2(unitIncl * packSize),            // per ENQUIRY pack, GST-inclusive
        pricePerUnit: round4(unitIncl),                // GST-inclusive
        unitPriceExGst: bd.unitExcl,
        taxableValue: bd.taxable,
        gstPercent: g,
        gstAmount: bd.gstAmount,
        total: bd.total,                               // GST-inclusive
        totalUnits,
        unit: enquiry.unit,
        priceSource: row.price_source,
        priceBasis: row.price_basis || "per_unit",
        gstInclusiveInput: row.gst_inclusive_input !== false,
        enteredPrice: row.entered_price != null ? Number(row.entered_price) : null,
        validUntil: row.valid_until || null,
        lifetime: !row.valid_until,
        validityOption: row.validity_option || null,
        status: row.status,
        productName: row.product_name || "",
        brandName: row.brand_name || "",
        image: row.image || null,
        moq: row.moq != null ? Number(row.moq) : null,
        moqUnits: row.moq != null && lp ? moqInUnits(row.moq, lp, lm || 1) : null,
        freightIncluded: row.freight_included,
        listingUnit: row.listing_unit || null,
        listingPackSize: lp,
        listingMasterPackSize: lm,
        checkoutMatches: row.checkout_matches !== false,
        submissionId: row.submission_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (forBuyer) {
        dto.deliveryDays = row.delivery_days;
        dto.deliveryDaysMin = row.delivery_days_min ?? row.delivery_days;
        dto.sellerName = row.seller?.display_name || "Supplier";
        dto.city = row.seller?.city || null;
        dto.state = row.seller?.state || null;
    }
    return dto;
}

const live = (r) => r.status === "active" && (!r.valid_until || new Date(r.valid_until).getTime() > Date.now());
const notExpired = (q) => q.or(`valid_until.is.null,valid_until.gt.${new Date().toISOString()}`);

async function sellerProfilesById(ids) {
    const uniq = [...new Set((ids || []).filter(Boolean))];
    if (!uniq.length) return new Map();
    const { data, error } = await supabase.from("seller_profiles").select("id, display_name, city, state").in("id", uniq);
    if (error) { console.error("[rfq] seller lookup failed:", error.message); return new Map(); }
    return new Map((data || []).map((s) => [s.id, s]));
}

export async function fetchActiveQuotes(enquiryIds) {
    if (!enquiryIds.length) return new Map();
    const { data, error } = await notExpired(
        supabase.from("rfq_quotes").select("*").in("enquiry_id", enquiryIds).eq("status", "active")
    ).order("price_per_unit", { ascending: true });
    if (error) throw error;
    const rows = (data || []).filter(live);
    const sellers = await sellerProfilesById(rows.map((r) => r.seller_id));
    const map = new Map();
    rows.forEach((r) => {
        r.seller = sellers.get(r.seller_id) || null;
        if (!map.has(r.enquiry_id)) map.set(r.enquiry_id, []);
        map.get(r.enquiry_id).push(r);
    });
    return map;
}

// This seller's own live quotes, keyed by enquiry id. `sellerIds` may be one id or an array.
export async function fetchMyQuotes(enquiryIds, sellerIds) {
    const sids = [...new Set([].concat(sellerIds || []).filter(Boolean))];
    if (!enquiryIds.length || !sids.length) return new Map();
    const { data, error } = await notExpired(
        supabase.from("rfq_quotes").select("*").in("enquiry_id", enquiryIds).in("seller_id", sids).eq("status", "active")
    );
    if (error) throw error;
    return new Map((data || []).filter(live).map((r) => [r.enquiry_id, r]));
}

export async function attachQuotes(items, rows, userId, sellerIds = [userId]) {
    const ids = rows.map((r) => r.id);
    const mineIds = rows.filter((r) => r.buyer_id === userId).map((r) => r.id);
    const mineSet = new Set(mineIds);
    const otherIds = ids.filter((id) => !mineSet.has(id));
    const [all, mine] = await Promise.all([fetchActiveQuotes(mineIds), fetchMyQuotes(otherIds, sellerIds)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return items.map((it) => {
        const row = byId.get(it.id);
        if (it.isMine) {
            const qs = (all.get(it.id) || []).map((q) => quoteToDto(q, row, { forBuyer: true }));
            return { ...it, quotes: qs, quotesCount: qs.length };
        }
        const my = mine.get(it.id);
        return { ...it, myQuote: my ? quoteToDto(my, row) : null };
    });
}

export async function countQuotesForBuyer(buyerId) {
    const { data: enq, error } = await supabase.from("rfq_enquiries").select("id").eq("buyer_id", buyerId);
    if (error) throw error;
    const ids = (enq || []).map((e) => e.id);
    if (!ids.length) return 0;
    const { count, error: e2 } = await notExpired(
        supabase.from("rfq_quotes").select("id", { count: "exact", head: true }).in("enquiry_id", ids).eq("status", "active")
    );
    if (e2) throw e2;
    return count || 0;
}