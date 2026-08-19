// controllers/sellerCatalogListings.controller.js — REWRITTEN
//
// FIX (this pass): createSubmission's admin notification for a brand-new
// product used to link to /admin/catalog/brand_item/:id. Approving there
// only flips the brand item's own review_status — it never touches the
// seller_product_submissions row that actually carries price/MOQ/etc. and
// makes a seller show up as available to buy from. That meant every
// brand-new submission needed two separate admin trips: one to map +
// "approve" the catalog node, then a second to find the listing under
// "New listing submission" and approve THAT. Both notification paths now
// point at the same place — /admin/listings — which already has
// inline hierarchy mapping and refuses to approve until that mapping
// exists, so one visit is enough.
import { supabase } from "../config/supabase.js";
import { notifyAdmins, notifyAdminSubmissionsChanged } from "../services/notifications.service.js";
import { slugify } from "../services/slugify.js";
import {
    getCommissionPercent, computeMarketplaceFigures,
    normalizeEnteredPrice, round2,
} from "../services/pricing.service.js";

export const ALLOWED_UNITS = [
    "Pieces", "Kg", "Grams", "Litres", "Millilitres", "Meters",
    "Boxes", "Dozen", "Tons", "Pack", "Bundle", "Set", "Units",
];
const STOCK_TYPES = ["ready_stock", "made_to_order"];
const PRICE_BASES = ["per_unit", "per_pack", "per_master_pack"];
const GROUP_FIELD_MAP = {
    delivery: ["dispatchPincode", "dispatchingLocations", "freightIncluded"],
};

const SUBMISSION_LIST_COLUMNS = `
    id, created_at, updated_at, review_status, rejection_reason,
    reviewed_at, is_active, generic_product_brand_id,
    product_name, brand_name, image, price, base_price, moq, unit,
    stock_type, stock_quantity, production_lead_time_days,
    hs_generic_product_brands ( id, name, brand_name, image, images )
`;

const SUBMISSION_DETAIL_COLUMNS = `*, hs_generic_product_brands ( id, name, brand_name, image, images, brand_not_applicable )`;

async function autoSaveDeliveryDefaults(sellerId, body) {
    const keys = GROUP_FIELD_MAP.delivery;
    const data = Object.fromEntries(keys.map((k) => [k, body[k]]));
    const hasValue = Object.values(data).some((v) => v !== "" && v != null && !(Array.isArray(v) && v.length === 0));
    if (!hasValue) return;
    try {
        const { data: existingTpl } = await supabase
            .from("seller_listing_templates")
            .select("id").eq("seller_id", sellerId).eq("group_type", "delivery").eq("is_default", true)
            .maybeSingle();
        if (existingTpl) {
            await supabase.from("seller_listing_templates").update({ data }).eq("id", existingTpl.id);
        } else {
            await supabase.from("seller_listing_templates").insert({ seller_id: sellerId, group_type: "delivery", name: "Default", data, is_default: true });
        }
    } catch { /* best-effort */ }
}

/* ------------------------- brand resolution ------------------------- */

async function resolveOrCreateBrandItem({ productName, brandName, brandImage, brandNotApplicable, images }) {
    const trimmedProduct = productName.trim();

    if (brandNotApplicable) {
        const { data: created, error } = await supabase
            .from("hs_generic_product_brands")
            .insert({
                generic_product_id: null,
                name: trimmedProduct,
                brand_name: null,
                brand_not_applicable: true,
                slug: slugify(`${trimmedProduct}-${Date.now()}`),
                image: images[0] || null,
                images,
                is_ai_generated: false,
                review_status: "pending_review",
            })
            .select("id, name, brand_name")
            .single();
        if (error) throw error;
        return created;
    }

    const trimmedBrand = brandName.trim();

    const { data: existing } = await supabase
        .from("hs_generic_product_brands")
        .select("id, name, brand_name")
        .ilike("name", trimmedProduct)
        .ilike("brand_name", trimmedBrand)
        .maybeSingle();
    if (existing) return existing;

    const { data: created, error } = await supabase
        .from("hs_generic_product_brands")
        .insert({
            generic_product_id: null,
            name: trimmedProduct,
            brand_name: trimmedBrand,
            brand_image: brandImage || null,
            brand_not_applicable: false,
            slug: slugify(`${trimmedProduct}-${trimmedBrand}`),
            image: images[0] || null,
            images,
            is_ai_generated: false,
            review_status: "pending_review",
        })
        .select("id, name, brand_name")
        .single();
    if (error && error.code !== "23505") throw error;
    if (error) {
        const { data: raced } = await supabase.from("hs_generic_product_brands").select("id, name, brand_name")
            .ilike("name", trimmedProduct).ilike("brand_name", trimmedBrand).maybeSingle();
        return raced;
    }
    return created;
}

/* ------------------------- validation ------------------------- */

function validateListingPayload(body) {
    const missing = [];

    if (!body.productName?.trim()) missing.push("Product name");
    if (!body.brandNotApplicable && !body.brandName?.trim()) missing.push("Brand");
    if (!(Array.isArray(body.images) && body.images.length)) missing.push("Product image");

    if (!body.unit || !ALLOWED_UNITS.includes(body.unit)) missing.push("Unit of measurement");
    if (!(Number(body.packSize) > 0)) missing.push("Pack size");
    if (!(Number(body.masterPackSize) > 0)) missing.push("Master pack size");
    if (!(Number(body.moq) > 0)) missing.push("MOQ");
    if (!body.hsnCode?.trim()) missing.push("HSN Code");
    if (body.gstPercent === undefined || body.gstPercent === null || Number(body.gstPercent) < 0) missing.push("GST %");

    if (!(Number(body.basePrice) > 0)) missing.push("Base price");
    if (!PRICE_BASES.includes(body.priceBasis)) missing.push("Price basis (per unit / pack / master pack)");
    if (typeof body.gstInclusive !== "boolean") missing.push("Whether price includes GST");
    if (typeof body.freightIncluded !== "boolean") missing.push("Whether freight is included");

    if (body.sampleAvailable) {
        if (!(Number(body.sampleQuantity) > 0)) missing.push("Sample quantity");
        if (!PRICE_BASES.includes(body.sampleUnitBasis)) missing.push("Sample quantity basis");
    }

    if (!STOCK_TYPES.includes(body.stockType)) missing.push("Ready stock / Made-to-order");
    if (body.stockType === "ready_stock" && !(Number(body.stockQuantity) >= 0)) missing.push("Available stock");
    if (body.stockType === "made_to_order" && !(Number(body.productionLeadTimeDays) >= 0)) missing.push("Lead time");

    if (!body.dispatchPincode?.trim()) missing.push("Dispatch pincode");
    if (!(Array.isArray(body.dispatchingLocations) && body.dispatchingLocations.length)) missing.push("Dispatching locations");

    if (!body.returnPolicyKey?.trim()) missing.push("Return / replacement policy");
    if (!body.warrantyKey?.trim()) missing.push("Warranty");

    return missing;
}

function toListingRow(body) {
    const { basePricePerUnit, finalPricePerUnit } = normalizeEnteredPrice(
        body.basePrice, body.gstPercent, body.gstInclusive, body.priceBasis,
        body.packSize, body.masterPackSize
    );
    const effectiveLeadTime = body.stockType === "made_to_order"
        ? Number(body.productionLeadTimeDays || 0)
        : Number(body.dispatchTimeDays || 0);
    const images = Array.isArray(body.images) ? body.images : [];

    return {
        product_name: body.productName?.trim() || null,
        brand_name: body.brandNotApplicable ? null : (body.brandName?.trim() || null),

        price: finalPricePerUnit,
        base_price: basePricePerUnit,
        moq: Number(body.moq),
        unit: body.unit,
        lead_time: effectiveLeadTime,
        image: images[0] || null,
        stock_quantity: body.stockType === "ready_stock" && body.stockQuantity !== "" ? Number(body.stockQuantity) : null,

        gst_percent: Number(body.gstPercent),
        price_basis: body.priceBasis,
        gst_inclusive_input: Boolean(body.gstInclusive),
        freight_included: Boolean(body.freightIncluded),

        pack_size: Number(body.packSize),
        units_per_master_pack: Number(body.masterPackSize),

        sample_available: Boolean(body.sampleAvailable),
        sample_quantity: body.sampleAvailable ? Number(body.sampleQuantity) : null,
        sample_unit_basis: body.sampleAvailable ? body.sampleUnitBasis : null,

        price_slabs: [],
        quantity_discounts: Array.isArray(body.priceSlabs) ? body.priceSlabs.filter((s) => s?.minQty && s?.discountPercent) : [],

        stock_type: body.stockType,
        production_lead_time_days: body.stockType === "made_to_order" ? Number(body.productionLeadTimeDays) : null,

        dispatch_district: body.dispatchDistrict?.trim() || null,
        dispatch_state: body.dispatchState?.trim() || null,
        dispatch_pincode: body.dispatchPincode?.trim() || null,
        dispatching_locations: Array.isArray(body.dispatchingLocations) ? body.dispatchingLocations : [],

        hsn_code: body.hsnCode?.trim() || null,

        return_policy_key: body.returnPolicyKey,
        warranty_key: body.warrantyKey,

        note_to_admin: body.noteToAdmin?.trim() || null,

        quality_certificates: Array.isArray(body.qualityCertificates) ? body.qualityCertificates.filter((c) => c?.url) : [],
    };
}

async function resolvePolicyText(kind, key) {
    if (!key) return null;
    const { data } = await supabase
        .from("listing_policy_options")
        .select("full_text").eq("kind", kind).eq("key", key).maybeSingle();
    return data?.full_text || null;
}

/* ------------------------- create submission ------------------------- */

// POST /api/seller/catalog/submissions
export async function createSubmission(req, res) {
    const sellerId = req.sellerId;
    const body = req.body || {};

    const missing = validateListingPayload(body);
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    let brand;
    try {
        brand = await resolveOrCreateBrandItem({
            productName: body.productName,
            brandName: body.brandName,
            brandImage: body.brandImage,
            brandNotApplicable: Boolean(body.brandNotApplicable),
            images: Array.isArray(body.images) ? body.images : [],
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }

    const { data: existingRow } = await supabase
        .from("seller_product_submissions")
        .select("id, review_status")
        .eq("seller_id", sellerId).eq("generic_product_brand_id", brand.id)
        .maybeSingle();
    if (existingRow && existingRow.review_status !== "rejected") {
        return res.status(409).json({ success: false, message: "You're already listing this item." });
    }

    const row = toListingRow(body);
    const [returnText, warrantyText] = await Promise.all([
        resolvePolicyText("return_policy", body.returnPolicyKey),
        resolvePolicyText("warranty", body.warrantyKey),
    ]);
    row.return_policy = returnText;
    row.warranty = warrantyText;

    let inserted, error;
    if (existingRow) {
        ({ data: inserted, error } = await supabase
            .from("seller_product_submissions")
            .update({ ...row, review_status: "pending_review", rejection_reason: null, reviewed_at: null, reviewed_by: null })
            .eq("id", existingRow.id).select("id, created_at, price").single());
    } else {
        ({ data: inserted, error } = await supabase
            .from("seller_product_submissions")
            .insert({ seller_id: sellerId, generic_product_brand_id: brand.id, ...row })
            .select("id, created_at, price").single());
    }
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You're already listing this item." });
        return res.status(500).json({ success: false, message: error.message });
    }

    await autoSaveDeliveryDefaults(sellerId, body);

    // Single admin entry point for every submission, new-brand or not: the
    // Listings review page, never the catalog page. Hierarchy mapping now
    // happens inline there, and approval is server-side blocked until it's
    // done — so this is the only notification, and the only trip needed.
    await notifyAdmins({
        type: "seller_submission",
        title: existingRow ? "Listing resubmitted for review" : "New listing submitted",
        message: `${brand.brand_name || "(No brand)"} — ${brand.name} ${existingRow ? "was resubmitted after rejection" : "is a brand-new product — map it to a category before approving"}.`,
        link: `/admin/listings?highlight=${inserted.id}`,
    });
    await notifyAdminSubmissionsChanged();

    const marketplace = await computeMarketplaceFigures(inserted.price);
    res.json({ success: true, submission: inserted, marketplace, message: "Submitted for review. We'll notify you once it's approved." });
}

// GET /api/seller/catalog/commission-info
export async function getCommissionInfo(req, res) {
    const commissionPercent = await getCommissionPercent();
    res.json({ success: true, commissionPercent });
}

export async function createListingForExistingBrand(req, res) {
    const sellerId = req.sellerId;
    const body = req.body || {};
    const { genericProductBrandId } = body;
    if (!genericProductBrandId) return res.status(400).json({ success: false, message: "Missing brand item." });

    const { data: brand, error: brandErr } = await supabase
        .from("hs_generic_product_brands")
        .select("id, name, brand_name, image, images, review_status")
        .eq("id", genericProductBrandId).maybeSingle();
    if (brandErr) return res.status(500).json({ success: false, message: brandErr.message });
    if (!brand) return res.status(400).json({ success: false, message: "That item wasn't found." });
    if (brand.review_status !== "approved") return res.status(400).json({ success: false, message: "This item isn't available to list under yet." });

    const merged = { ...body, productName: brand.name, brandName: brand.brand_name, images: brand.images?.length ? brand.images : (brand.image ? [brand.image] : []) };

    const missing = validateListingPayload(merged).filter((m) => !["Product name", "Brand", "Product image"].includes(m));
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    const { data: existingRow } = await supabase
        .from("seller_product_submissions").select("id, review_status")
        .eq("seller_id", sellerId).eq("generic_product_brand_id", brand.id).maybeSingle();
    if (existingRow && existingRow.review_status !== "rejected") {
        return res.status(409).json({ success: false, message: "You're already listing this item." });
    }

    const row = toListingRow(merged);
    const [returnText, warrantyText] = await Promise.all([
        resolvePolicyText("return_policy", body.returnPolicyKey),
        resolvePolicyText("warranty", body.warrantyKey),
    ]);
    row.return_policy = returnText;
    row.warranty = warrantyText;

    let result, error;
    if (existingRow) {
        ({ data: result, error } = await supabase.from("seller_product_submissions")
            .update({ ...row, review_status: "pending_review", rejection_reason: null, reviewed_at: null, reviewed_by: null })
            .eq("id", existingRow.id).select("id, created_at, price").single());
    } else {
        ({ data: result, error } = await supabase.from("seller_product_submissions")
            .insert({ seller_id: sellerId, generic_product_brand_id: brand.id, ...row })
            .select("id, created_at, price").single());
    }
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You're already listing this item." });
        return res.status(500).json({ success: false, message: error.message });
    }

    await autoSaveDeliveryDefaults(sellerId, body);
    // Already-approved brand item, so no mapping step is needed here — but
    // still funnels through the same single review page as every other
    // submission notification, for one consistent admin workflow.
    await notifyAdmins({
        type: "seller_submission",
        title: existingRow ? "Listing resubmitted for review" : "New listing submitted",
        message: existingRow ? `A seller resubmitted "${brand.name}" after rejection.` : `A seller wants to list "${brand.name}".`,
        link: `/admin/listings?highlight=${result.id}`,
    });
    await notifyAdminSubmissionsChanged();

    const marketplace = await computeMarketplaceFigures(result.price);
    res.json({ success: true, submission: result, marketplace, message: `You're now listing "${brand.name}"${existingRow ? " again" : ""}. We'll notify you once it's approved.` });
}

/* ------------------------- list / detail / update / active ------------------------- */

export async function listMySubmissions(req, res) {
    const sellerId = req.sellerId;
    const { status, is_active } = req.query;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
        .from("seller_product_submissions")
        .select(SUBMISSION_LIST_COLUMNS, { count: "exact" })
        .eq("seller_id", sellerId)
        .order("created_at", { ascending: false })
        .range(from, to);

    if (status) {
        const allowedStatuses = ["pending_review", "approved", "rejected"];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status filter." });
        }
        query = query.eq("review_status", status);
    }
    if (is_active !== undefined) {
        query = query.eq("is_active", is_active === "true");
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const items = (data || []).map(({ hs_generic_product_brands, ...rest }) => ({
        ...rest,
        brand: hs_generic_product_brands || null,
    }));

    res.json({
        success: true,
        items,
        pagination: { page, pageSize, total: count ?? items.length, totalPages: Math.ceil((count ?? items.length) / pageSize) },
    });
}

export async function getSubmissionDetail(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;

    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(SUBMISSION_DETAIL_COLUMNS)
        .eq("id", id)
        .eq("seller_id", sellerId)
        .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Submission not found." });

    const { hs_generic_product_brands, ...rest } = data;
    const submission = { ...rest, brand: hs_generic_product_brands || null };

    res.json({ success: true, submission });
}

export async function updateSubmission(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;
    const body = req.body || {};

    // Fetch the FULL existing row, not just identity columns — we need
    // every field as a fallback so a partial PATCH (e.g. the row-level
    // "Resubmit" quick-edit, which only sends price/moq/lead_time/stock)
    // doesn't get rejected for "missing" fields that are already saved.
    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("*")
        .eq("id", id).eq("seller_id", sellerId).maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Submission not found." });

    // Build the payload validateListingPayload/toListingRow expect,
    // preferring anything explicitly sent in `body`, and otherwise
    // falling back to what's already saved on the row. This makes the
    // endpoint behave like a real PATCH (partial update) instead of
    // requiring the entire form on every call.
    const merged = {
        productName: existing.product_name,
        brandName: existing.brand_name,
        brandNotApplicable: !existing.brand_name,
        images: Array.isArray(body.images) && body.images.length ? body.images : [existing.image].filter(Boolean),

        unit: body.unit ?? existing.unit,
        packSize: body.packSize ?? existing.pack_size,
        masterPackSize: body.masterPackSize ?? existing.units_per_master_pack,
        moq: body.moq ?? existing.moq,
        hsnCode: body.hsnCode ?? existing.hsn_code,
        gstPercent: body.gstPercent ?? existing.gst_percent,

        basePrice: body.basePrice ?? existing.base_price,
        priceBasis: body.priceBasis ?? existing.price_basis,
        gstInclusive: body.gstInclusive ?? existing.gst_inclusive_input,
        freightIncluded: body.freightIncluded ?? existing.freight_included,

        sampleAvailable: body.sampleAvailable ?? existing.sample_available,
        sampleQuantity: body.sampleQuantity ?? existing.sample_quantity,
        sampleUnitBasis: body.sampleUnitBasis ?? existing.sample_unit_basis,

        priceSlabs: body.priceSlabs ?? existing.quantity_discounts,

        stockType: body.stockType ?? existing.stock_type,
        stockQuantity: body.stockQuantity ?? existing.stock_quantity,
        productionLeadTimeDays: body.productionLeadTimeDays ?? existing.production_lead_time_days,
        dispatchTimeDays: body.dispatchTimeDays ?? existing.dispatch_time_days,

        dispatchPincode: body.dispatchPincode ?? existing.dispatch_pincode,
        dispatchDistrict: body.dispatchDistrict ?? existing.dispatch_district,
        dispatchState: body.dispatchState ?? existing.dispatch_state,
        dispatchingLocations: body.dispatchingLocations ?? existing.dispatching_locations,

        returnPolicyKey: body.returnPolicyKey ?? existing.return_policy_key,
        warrantyKey: body.warrantyKey ?? existing.warranty_key,

        noteToAdmin: body.noteToAdmin ?? existing.note_to_admin,
        qualityCertificates: body.qualityCertificates ?? existing.quality_certificates,
    };

    const missing = validateListingPayload(merged).filter((m) => !["Product name", "Brand", "Product image"].includes(m));
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    const row = toListingRow(merged);
    const [returnText, warrantyText] = await Promise.all([
        resolvePolicyText("return_policy", merged.returnPolicyKey),
        resolvePolicyText("warranty", merged.warrantyKey),
    ]);
    row.return_policy = returnText;
    row.warranty = warrantyText;

    const { data: updated, error } = await supabase
        .from("seller_product_submissions")
        .update({ ...row, review_status: "pending_review", rejection_reason: null, reviewed_at: null, reviewed_by: null })
        .eq("id", id).eq("seller_id", sellerId)
        .select("id, created_at, price").single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    await autoSaveDeliveryDefaults(sellerId, body);

    await notifyAdmins({
        type: "seller_submission",
        title: "Listing edited and resubmitted for review",
        message: `${existing.brand_name || "(No brand)"} — ${existing.product_name} was edited and needs review.`,
        link: `/admin/listings?highlight=${updated.id}`,
    });
    await notifyAdminSubmissionsChanged();

    const marketplace = await computeMarketplaceFigures(updated.price);
    res.json({ success: true, submission: updated, marketplace, message: "Changes submitted for review." });
}

export async function setSubmissionActive(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;
    const { isActive } = req.body || {};

    if (typeof isActive !== "boolean") {
        return res.status(400).json({ success: false, message: "isActive must be true or false." });
    }

    const { data: updated, error } = await supabase
        .from("seller_product_submissions")
        .update({ is_active: isActive })
        .eq("id", id).eq("seller_id", sellerId)
        .select("id, is_active").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!updated) return res.status(404).json({ success: false, message: "Submission not found." });

    res.json({ success: true, submission: updated, message: isActive ? "Listing is now active." : "Listing is now inactive." });
}

export async function deleteSubmission(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;

    const { data: deleted, error } = await supabase
        .from("seller_product_submissions")
        .delete()
        .eq("id", id).eq("seller_id", sellerId)
        .select("id").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!deleted) return res.status(404).json({ success: false, message: "Submission not found." });

    await notifyAdminSubmissionsChanged();
    res.json({ success: true, message: "Listing deleted." });
}