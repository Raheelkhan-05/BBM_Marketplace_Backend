// services/rfqValidation.js
export const RFQ_UNITS = ["Pieces", "Kg", "Grams", "Litres", "Millilitres", "Dozen", "Tons"];
export const RFQ_STATUSES = ["pending_review", "approved", "rejected", "closed"];
const PAYMENT = ["advance", "credit", "flexible"];
const FREQ = ["monthly", "quarterly", "yearly"];

const fail = (message) => ({ ok: false, message });
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v) => (v === "" || v == null ? NaN : Number(v));

export const isUuid = (v) =>
    typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// Whitelists the flat dispatching-locations shape used by the seller listing form.
function cleanLocations(v) {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > 600) return null;
    const strs = (a) =>
        Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, 500).map((x) => x.trim().slice(0, 100)) : undefined;
    const out = [];
    for (const e of v) {
        if (!e || typeof e !== "object" || !["country", "state"].includes(e.type)) return null;
        if (typeof e.name !== "string" || !e.name.trim()) return null;
        const o = { type: e.type, name: e.name.trim().slice(0, 100) };
        if (typeof e.code === "string") o.code = e.code.slice(0, 10);
        if (e.includeOnly === true) o.includeOnly = true;
        for (const k of ["excludedStates", "includedCities", "excludedCities"]) {
            const a = strs(e[k]);
            if (a !== undefined) o[k] = a;
        }
        out.push(o);
    }
    return out;
}

// Validates a full enquiry payload (camelCase from the client) -> snake_case DB columns.
export function sanitizeEnquiry(b = {}) {
    const productName = str(b.productName, 200);
    if (productName.length < 2) return fail("Product name must be at least 2 characters.");

    const quantity = num(b.quantity);
    if (!(quantity > 0) || quantity > 1e9) return fail("Enter a valid quantity.");

    if (!RFQ_UNITS.includes(b.unit)) return fail("Select a valid unit.");

    const packSize = num(b.packSize);
    if (!(packSize > 0) || packSize > 1e9) return fail("Enter a valid pack size.");

    if (!PAYMENT.includes(b.paymentTerms)) return fail("Select the expected payment terms.");
    let creditDays = null;
    if (b.paymentTerms === "credit" && b.creditDays !== "" && b.creditDays != null) {
        creditDays = Math.round(num(b.creditDays));
        if (!(creditDays >= 1 && creditDays <= 365)) return fail("Credit days must be between 1 and 365.");
    }

    const deliveryCity = str(b.deliveryCity, 100);
    const deliveryState = str(b.deliveryState, 100);
    const deliveryPincode = str(b.deliveryPincode, 6);
    if (!deliveryCity || !deliveryState) return fail("Delivery city and state are required.");
    if (!/^\d{6}$/.test(deliveryPincode)) return fail("Enter a valid 6-digit delivery pincode.");

    const supplierLocations = cleanLocations(b.supplierLocations);
    if (supplierLocations === null) return fail("Supplier locations are invalid.");

    const consumptionType = b.consumptionType === "regular" ? "regular" : "one_time";
    let recurringFrequency = null;
    let recurringQuantity = null;
    if (consumptionType === "regular") {
        if (!FREQ.includes(b.recurringFrequency)) return fail("Select how often you need this (monthly, quarterly or yearly).");
        recurringQuantity = num(b.recurringQuantity);
        if (!(recurringQuantity > 0) || recurringQuantity > 1e10) return fail("Enter the recurring quantity.");
        recurringFrequency = b.recurringFrequency;
    }

    const images = (Array.isArray(b.images) ? b.images : [])
        .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u) && u.length < 1000)
        .slice(0, 5);

    return {
        ok: true,
        row: {
            product_name: productName,
            images,
            quantity,
            unit: b.unit,
            pack_size: packSize,
            accept_equivalent: b.acceptEquivalent === true,
            specifications: str(b.specifications, 2000) || null,
            payment_terms: b.paymentTerms,
            credit_days: creditDays,
            delivery_city: deliveryCity,
            delivery_state: deliveryState,
            delivery_pincode: deliveryPincode,
            delivery_address: str(b.deliveryAddress, 300) || null,
            supplier_locations: supplierLocations,
            consumption_type: consumptionType,
            recurring_frequency: recurringFrequency,
            recurring_quantity: recurringQuantity,
        },
    };
}

// DB row -> API shape. Public viewers never see the poster or the exact address.
export function toDto(row, { owner = false, admin = false } = {}) {
    const dto = {
        id: row.id,
        productName: row.product_name,
        images: row.images || [],
        quantity: Number(row.quantity),
        unit: row.unit,
        packSize: Number(row.pack_size),
        acceptEquivalent: !!row.accept_equivalent,
        specifications: row.specifications || "",
        paymentTerms: row.payment_terms,
        creditDays: row.credit_days,
        deliveryCity: row.delivery_city,
        deliveryState: row.delivery_state,
        supplierLocations: row.supplier_locations || [],
        consumptionType: row.consumption_type,
        recurringFrequency: row.recurring_frequency,
        recurringQuantity: row.recurring_quantity != null ? Number(row.recurring_quantity) : null,
        status: row.status,
        publishedAt: row.published_at,
        createdAt: row.created_at,
    };
    if (owner || admin) {
        dto.deliveryPincode = row.delivery_pincode;
        dto.deliveryAddress = row.delivery_address || "";
        dto.reviewNote = row.review_note || "";
        dto.reviewedAt = row.reviewed_at;
    }
    if (admin) {
        dto.buyerId = row.buyer_id;
        dto.hierarchy = {
            category: row.hs_categories ? { id: row.hs_categories.id, name: row.hs_categories.name } : null,
            subcategory: row.hs_subcategories ? { id: row.hs_subcategories.id, name: row.hs_subcategories.name } : null,
            genericProduct: row.hs_generic_products ? { id: row.hs_generic_products.id, name: row.hs_generic_products.name } : null,
        };
    }
    return dto;
}