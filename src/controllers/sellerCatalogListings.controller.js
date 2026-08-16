// controllers/sellerCatalogListings.controller.js
//
// Full seller self-listing flow, rewritten around the complete
// commercial spec (Product / Pricing / Quantity / Packaging /
// Availability / Delivery / Tax & Legal / Commercial Terms / Quality /
// Marketplace). Buyer-facing "hot" columns (price, moq, unit,
// lead_time, image, stock_quantity) are computed FROM the richer
// fields below and kept in sync on every write — see toListingRow() —
// so every existing reader (browse, seller rows, cards, dashboards)
// keeps working completely unchanged.

import { supabase } from "../config/supabase.js";
import { notifyAdmins, notifyAdminSubmissionsChanged } from "../services/notifications.service.js";
import { slugify } from "../services/slugify.js";
import { getCommissionPercent, computeFinalPrice, computeMarketplaceFigures } from "../services/pricing.service.js";

const PICKER_LIMIT = 20;

export const ALLOWED_UNITS = [
    "Pieces", "Kg", "Grams", "Litres", "Millilitres", "Meters",
    "Boxes", "Dozen", "Tons", "Pack", "Bundle", "Set", "Units",
];
const GST_REG_STATUSES = ["regular", "composition", "unregistered"];
const STOCK_TYPES = ["ready_stock", "made_to_order"];

/* ------------------------- catalog pickers (unchanged) ------------------------- */

export async function listApprovedCategories(req, res) {
    const { q = "" } = req.query;
    let query = supabase.from("hs_categories").select("id, name, slug, image").eq("review_status", "approved").order("name").limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

export async function listApprovedSubcategories(req, res) {
    const { categoryId, q = "" } = req.query;
    if (!categoryId) return res.status(400).json({ success: false, message: "categoryId is required." });
    let query = supabase.from("hs_subcategories").select("id, name, slug, image, category_id").eq("category_id", categoryId).eq("review_status", "approved").order("name").limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

export async function listApprovedGenericProducts(req, res) {
    const { subcategoryId, q = "" } = req.query;
    if (!subcategoryId) return res.status(400).json({ success: false, message: "subcategoryId is required." });
    let query = supabase.from("hs_generic_products").select("id, name, slug, image, subcategory_id").eq("subcategory_id", subcategoryId).eq("review_status", "approved").order("name").limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

/* ------------------------- commission info (public, cached) ------------------------- */

// GET /api/seller/catalog/commission-info — the frontend fetches this
// once per form load, then computes the live price/payout preview in
// the browser on every keystroke instead of round-tripping to the API.
export async function getCommissionInfo(req, res) {
    const commissionPercent = await getCommissionPercent();
    res.json({ success: true, commissionPercent });
}

/* ------------------------- validation + row mapping ------------------------- */

function validateListingPayload(body, { requireIdentity }) {
    const missing = [];

    if (requireIdentity) {
        if (!body.productName?.trim()) missing.push("Product name");
        if (!body.brandName?.trim()) missing.push("Brand name");
    }
    if (!body.manufacturer?.trim()) missing.push("Manufacturer");
    if (!body.modelNo?.trim()) missing.push("Model / Part No. / SKU");
    if (!(Array.isArray(body.images) && body.images.length)) missing.push("Product image");

    if (!(Number(body.basePrice) > 0)) missing.push("Base price (excl. GST)");
    if (body.gstPercent === undefined || body.gstPercent === null || Number(body.gstPercent) < 0) missing.push("GST %");
    if (!body.priceValidityTill) missing.push("Price validity");

    if (!(Number(body.moq) > 0)) missing.push("MOQ");

    if (!(Number(body.packSize) > 0)) missing.push("Pack size");
    if (!body.unit || !ALLOWED_UNITS.includes(body.unit)) missing.push("Unit of measurement");
    if (Number(body.packSize) > 1 && !(Number(body.ratePerPack) > 0)) missing.push("Rate per pack");

    if (body.stockQuantity === undefined || body.stockQuantity === null || body.stockQuantity === "" || Number(body.stockQuantity) < 0) missing.push("Stock available");
    if (!STOCK_TYPES.includes(body.stockType)) missing.push("Ready stock / Made-to-order");
    if (!(Number(body.dispatchTimeDays) >= 0)) missing.push("Expected dispatch time");
    if (body.stockType === "made_to_order" && !(Number(body.productionLeadTimeDays) >= 0)) missing.push("Production lead time");

    if (!body.sellerLocation?.trim()) missing.push("Seller location");
    if (!body.dispatchLocation?.trim()) missing.push("Dispatch location");
    if (!body.deliveryTimeline?.trim()) missing.push("Delivery timeline");

    if (!body.hsnCode?.trim()) missing.push("HSN Code");
    if (!GST_REG_STATUSES.includes(body.gstRegistrationStatus)) missing.push("GST registration status");
    if (typeof body.taxInvoiceAvailable !== "boolean") missing.push("Tax invoice available");

    if (!body.paymentTerms?.trim()) missing.push("Payment terms");
    if (!body.returnPolicy?.trim()) missing.push("Return / replacement policy");

    return missing;
}

function toListingRow(body) {
    const finalPrice = computeFinalPrice(body.basePrice, body.gstPercent);
    const effectiveLeadTime = body.stockType === "made_to_order"
        ? Number(body.productionLeadTimeDays || 0)
        : Number(body.dispatchTimeDays || 0);
    const images = Array.isArray(body.images) ? body.images : [];

    return {
        // canonical buyer-facing fields — unchanged shape on purpose
        price: finalPrice,
        moq: Number(body.moq),
        unit: body.unit,
        lead_time: effectiveLeadTime,
        image: images[0] || null,
        stock_quantity: body.stockQuantity === "" || body.stockQuantity == null ? null : Number(body.stockQuantity),

        // product
        manufacturer: body.manufacturer?.trim() || null,
        model_no: body.modelNo?.trim() || null,
        grade_variant: body.gradeVariant?.trim() || null,
        specifications: Array.isArray(body.specifications) ? body.specifications.filter((s) => s?.key?.trim()) : [],

        // pricing
        base_price: Number(body.basePrice),
        gst_percent: Number(body.gstPercent),
        rate_per_pack: body.ratePerPack ? Number(body.ratePerPack) : null,
        rate_per_master_pack: body.ratePerMasterPack ? Number(body.ratePerMasterPack) : null,
        price_validity_till: body.priceValidityTill || null,

        // quantity
        sample_available: Boolean(body.sampleAvailable),
        sample_price: body.sampleAvailable && body.samplePrice ? Number(body.samplePrice) : null,
        price_slabs: Array.isArray(body.priceSlabs) ? body.priceSlabs.filter((s) => s?.minQty) : [],
        quantity_discounts: Array.isArray(body.quantityDiscounts) ? body.quantityDiscounts.filter((s) => s?.minQty) : [],

        // packaging
        pack_size: Number(body.packSize),
        units_per_master_pack: body.unitsPerMasterPack ? Number(body.unitsPerMasterPack) : null,
        master_pack_size: body.masterPackSize ? Number(body.masterPackSize) : null,
        packaging_type: body.packagingType?.trim() || null,

        // availability
        stock_type: body.stockType,
        dispatch_time_days: body.dispatchTimeDays !== "" && body.dispatchTimeDays != null ? Number(body.dispatchTimeDays) : null,
        production_lead_time_days: body.productionLeadTimeDays !== "" && body.productionLeadTimeDays != null ? Number(body.productionLeadTimeDays) : null,

        // delivery
        seller_location: body.sellerLocation?.trim() || null,
        dispatch_location: body.dispatchLocation?.trim() || null,
        delivery_timeline: body.deliveryTimeline?.trim() || null,
        freight_terms: body.freightTerms?.trim() || "Freight charges are extra, borne by the buyer unless otherwise agreed.",

        // tax & legal
        hsn_code: body.hsnCode?.trim() || null,
        gst_registration_status: GST_REG_STATUSES.includes(body.gstRegistrationStatus)
            ? body.gstRegistrationStatus
            : null,
        tax_invoice_available: Boolean(body.taxInvoiceAvailable),

        // commercial terms
        payment_terms: body.paymentTerms?.trim() || null,
        return_policy: body.returnPolicy?.trim() || null,
        warranty: body.warranty?.trim() || null,

        // quality
        quality_certificates: Array.isArray(body.qualityCertificates) ? body.qualityCertificates.filter((c) => c?.url) : [],
        tds_msds_coa: Array.isArray(body.tdsMsdsCoa) ? body.tdsMsdsCoa.filter((c) => c?.url) : [],
        other_certifications: Array.isArray(body.otherCertifications) ? body.otherCertifications.filter((c) => c?.url) : [],
    };
}

async function findOrCreateBrand({ genericProductId, productName, brandName, images }) {
    const trimmedName = productName.trim();
    const trimmedBrand = brandName.trim();

    let { data: brand } = await supabase
        .from("hs_generic_product_brands")
        .select("id")
        .eq("generic_product_id", genericProductId)
        .ilike("name", trimmedName)
        .ilike("brand_name", trimmedBrand)
        .maybeSingle();

    if (!brand) {
        const { data: newBrand, error: createErr } = await supabase
            .from("hs_generic_product_brands")
            .insert({
                generic_product_id: genericProductId,
                name: trimmedName,
                brand_name: trimmedBrand,
                slug: slugify(`${trimmedName}-${trimmedBrand}`),
                image: images[0] || null,
                images,
                is_ai_generated: false,
                review_status: "pending_review",
            })
            .select("id")
            .single();
        if (createErr && createErr.code !== "23505") throw createErr;
        if (createErr) {
            const { data: raced } = await supabase.from("hs_generic_product_brands").select("id")
                .eq("generic_product_id", genericProductId).ilike("name", trimmedName).ilike("brand_name", trimmedBrand).maybeSingle();
            brand = raced;
        } else {
            brand = newBrand;
        }
    }
    return brand;
}

/* ------------------------- submissions ------------------------- */

// POST /api/seller/catalog/submissions
export async function createSubmission(req, res) {
    const sellerId = req.sellerId;
    const body = req.body || {};

    if (!body.genericProductId) return res.status(400).json({ success: false, message: "Please choose a product from the catalog." });
    const missing = validateListingPayload(body, { requireIdentity: true });
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    const { data: generic, error: genericErr } = await supabase
        .from("hs_generic_products")
        .select("id, review_status")
        .eq("id", body.genericProductId)
        .maybeSingle();
    if (genericErr) return res.status(500).json({ success: false, message: genericErr.message });
    if (!generic) return res.status(400).json({ success: false, message: "Selected product wasn't found." });
    if (generic.review_status !== "approved") return res.status(400).json({ success: false, message: "This product isn't available to list under yet." });

    let brand;
    try {
        brand = await findOrCreateBrand({
            genericProductId: generic.id,
            productName: body.productName,
            brandName: body.brandName,
            images: Array.isArray(body.images) ? body.images : [],
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }

    const { data: existingRow, error: existingErr } = await supabase
        .from("seller_product_submissions")
        .select("id, review_status")
        .eq("seller_id", sellerId)
        .eq("generic_product_brand_id", brand.id)
        .maybeSingle();
    if (existingErr) return res.status(500).json({ success: false, message: existingErr.message });
    if (existingRow && existingRow.review_status !== "rejected") {
        return res.status(409).json({ success: false, message: "You're already listing this item." });
    }

    const row = toListingRow(body);
    let inserted, error;
    if (existingRow) {
        ({ data: inserted, error } = await supabase
            .from("seller_product_submissions")
            .update({ ...row, review_status: "pending_review", rejection_reason: null, reviewed_at: null, reviewed_by: null })
            .eq("id", existingRow.id)
            .select("id, created_at, price")
            .single());
    } else {
        ({ data: inserted, error } = await supabase
            .from("seller_product_submissions")
            .insert({ seller_id: sellerId, generic_product_brand_id: brand.id, ...row })
            .select("id, created_at, price")
            .single());
    }
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You're already listing this item." });
        console.log("Error from here", error.code, error.message);

        return res.status(500).json({ success: false, message: error.message });
    }

    await notifyAdmins({
        type: "seller_submission",
        title: existingRow ? "Listing resubmitted for review" : "New product submission",
        message: `${body.brandName.trim()} — ${body.productName.trim()} ${existingRow ? "was resubmitted after rejection" : "is awaiting review"}.`,
        link: `/admin/listings?highlight=${inserted.id}`,
    });
    await notifyAdminSubmissionsChanged();

    const marketplace = await computeMarketplaceFigures(inserted.price);
    res.json({ success: true, submission: inserted, marketplace, message: "Submitted for review. We'll notify you once it's approved." });
}

// POST /api/seller/catalog/listings — "I want to sell this" (existing, already-approved brand item)
export async function createListingForExistingBrand(req, res) {
    const sellerId = req.sellerId;
    const body = req.body || {};
    const { genericProductBrandId } = body;

    if (!genericProductBrandId) return res.status(400).json({ success: false, message: "Missing brand item." });

    // Pull the FULL brand record — product identity comes from here, never
    // from the client, since this whole flow is "the identity is already
    // approved, only commercial terms are new."
    const { data: brand, error: brandErr } = await supabase
        .from("hs_generic_product_brands")
        .select("id, name, brand_name, image, images, manufacturer, model_no, grade_variant, specifications, review_status")
        .eq("id", genericProductBrandId)
        .maybeSingle();
    if (brandErr) return res.status(500).json({ success: false, message: brandErr.message });
    if (!brand) return res.status(400).json({ success: false, message: "That item wasn't found." });
    if (brand.review_status !== "approved") return res.status(400).json({ success: false, message: "This item isn't available to list under yet." });

    // Overwrite any client-submitted identity fields with the brand's own
    // stored data — this is what actually makes them "uneditable": the
    // server enforces it, the read-only UI is just a courtesy.
    const mergedBody = {
        ...body,
        productName: brand.name,
        brandName: brand.brand_name,
        manufacturer: brand.manufacturer,
        modelNo: brand.model_no,
        gradeVariant: brand.grade_variant,
        specifications: Array.isArray(brand.specifications) ? brand.specifications : [],
        images: brand.images?.length ? brand.images : (brand.image ? [brand.image] : []),
    };

    const missing = validateListingPayload(mergedBody, { requireIdentity: false });
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    const { data: existingRow, error: existingErr } = await supabase
        .from("seller_product_submissions")
        .select("id, review_status")
        .eq("seller_id", sellerId)
        .eq("generic_product_brand_id", brand.id)
        .maybeSingle();
    if (existingErr) return res.status(500).json({ success: false, message: existingErr.message });
    if (existingRow && existingRow.review_status !== "rejected") {
        return res.status(409).json({ success: false, message: "You're already listing this item." });
    }

    const row = toListingRow(mergedBody);
    let result, error;
    if (existingRow) {
        ({ data: result, error } = await supabase
            .from("seller_product_submissions")
            .update({ ...row, review_status: "pending_review", rejection_reason: null, reviewed_at: null, reviewed_by: null })
            .eq("id", existingRow.id)
            .select("id, created_at, price")
            .single());
    } else {
        ({ data: result, error } = await supabase
            .from("seller_product_submissions")
            .insert({ seller_id: sellerId, generic_product_brand_id: brand.id, ...row })
            .select("id, created_at, price")
            .single());
    }
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You're already listing this item." });
        return res.status(500).json({ success: false, message: error.message });
    }

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

// GET /api/seller/catalog/submissions?status=
export async function listMySubmissions(req, res) {
    const sellerId = req.sellerId;
    const { status } = req.query;
    let query = supabase
        .from("seller_product_submissions")
        .select(`
            id, price, base_price, gst_percent, moq, unit, lead_time, image, is_active, stock_quantity,
            stock_type, hsn_code, price_validity_till, review_status, rejection_reason, created_at, updated_at,
            brand:hs_generic_product_brands (
                id, name, brand_name, image, images,
                generic_product:hs_generic_products (
                id, name,
                subcategory:hs_subcategories (
                    id, name,
                    category:hs_categories ( id, name )
                )
                )
            )
            `)
        .eq("seller_id", sellerId)
        .order("created_at", { ascending: false });
    if (status) query = query.eq("review_status", status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/seller/catalog/submissions/:id — full record, powers the edit form
export async function getSubmissionDetail(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(`*, brand:hs_generic_product_brands (
            id, name, brand_name, image, images,
            generic_product:hs_generic_products ( id, name,
                subcategory:hs_subcategories ( id, name, category:hs_categories ( id, name ) )
            )
        )`)
        .eq("id", id)
        .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data || data.seller_id !== sellerId) return res.status(404).json({ success: false, message: "Listing not found." });

    const marketplace = await computeMarketplaceFigures(data.price);
    res.json({ success: true, submission: data, marketplace });
}

// PATCH /api/seller/catalog/submissions/:id/active
export async function setSubmissionActive(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;
    const { isActive } = req.body || {};

    if (typeof isActive !== "boolean") {
        return res.status(400).json({ success: false, message: "isActive must be true or false." });
    }

    const { data: existing, error: findErr } = await supabase
        .from("seller_product_submissions")
        .select("id, seller_id, is_active")
        .eq("id", id)
        .maybeSingle();
    if (findErr) return res.status(500).json({ success: false, message: findErr.message });
    if (!existing || existing.seller_id !== sellerId) {
        return res.status(404).json({ success: false, message: "Listing not found." });
    }
    if (existing.is_active === isActive) {
        return res.json({ success: true, submission: existing, message: isActive ? "Already active." : "Already deactivated." });
    }

    const { data: updated, error } = await supabase
        .from("seller_product_submissions")
        .update({ is_active: isActive })
        .eq("id", id)
        .select("id, price, moq, unit, lead_time, image, stock_quantity, review_status, rejection_reason, is_active, updated_at")
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({
        success: true,
        submission: updated,
        message: isActive ? "Listing is live again." : "Listing hidden from buyers. You can reactivate it anytime.",
    });
}

// DELETE /api/seller/catalog/submissions/:id
export async function deleteSubmission(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;

    const { data: existing, error: findErr } = await supabase
        .from("seller_product_submissions")
        .select("id, seller_id")
        .eq("id", id)
        .maybeSingle();
    if (findErr) return res.status(500).json({ success: false, message: findErr.message });
    if (!existing || existing.seller_id !== sellerId) {
        return res.status(404).json({ success: false, message: "Listing not found." });
    }

    const { error } = await supabase.from("seller_product_submissions").delete().eq("id", id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: "Listing removed." });
}

// PATCH /api/seller/catalog/submissions/:id — full commercial-spec edit.
//
// IMPORTANT — backward compatibility: SellerQuickManageListings.jsx's
// existing 4-field inline editor (price, moq, lead_time, stock_quantity)
// still posts that old flat shape. Rather than force-touch that working
// component, we normalize its legacy keys onto the new camelCase
// contract right here, so both the old quick-edit and the new full edit
// form hit the exact same endpoint safely.
//
// Product identity (name/brand/category chain) is fixed once the
// listing exists — this only ever touches commercial fields, so it
// never resets review_status EXCEPT when the listing was rejected,
// where any edit is treated as a resubmission.
export async function updateSubmission(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;

    const { data: existing, error: findErr } = await supabase
        .from("seller_product_submissions")
        .select("*, brand:hs_generic_product_brands(name)")
        .eq("id", id)
        .maybeSingle();
    if (findErr) return res.status(500).json({ success: false, message: findErr.message });
    if (!existing || existing.seller_id !== sellerId) {
        return res.status(404).json({ success: false, message: "Listing not found." });
    }

    // --- legacy quick-edit shim ---
    const rawBody = { ...(req.body || {}) };
    if (rawBody.price !== undefined && rawBody.basePrice === undefined) {
        const gstForCalc = rawBody.gstPercent ?? existing.gst_percent ?? 0;
        rawBody.basePrice = Math.round((Number(rawBody.price) / (1 + Number(gstForCalc) / 100) + Number.EPSILON) * 100) / 100;
    }
    if (rawBody.lead_time !== undefined) {
        if ((existing.stock_type || "ready_stock") === "made_to_order" && rawBody.productionLeadTimeDays === undefined) {
            rawBody.productionLeadTimeDays = rawBody.lead_time;
        } else if (rawBody.dispatchTimeDays === undefined) {
            rawBody.dispatchTimeDays = rawBody.lead_time;
        }
    }
    if (rawBody.stock_quantity !== undefined && rawBody.stockQuantity === undefined) {
        rawBody.stockQuantity = rawBody.stock_quantity;
    }
    // --- end shim ---

    const camelFromExisting = {
        manufacturer: existing.manufacturer, modelNo: existing.model_no, gradeVariant: existing.grade_variant,
        specifications: existing.specifications, images: existing.image ? [existing.image] : [],
        basePrice: existing.base_price, gstPercent: existing.gst_percent, ratePerPack: existing.rate_per_pack,
        ratePerMasterPack: existing.rate_per_master_pack, priceValidityTill: existing.price_validity_till,
        moq: existing.moq, sampleAvailable: existing.sample_available, samplePrice: existing.sample_price,
        priceSlabs: existing.price_slabs, quantityDiscounts: existing.quantity_discounts,
        packSize: existing.pack_size, unit: existing.unit, unitsPerMasterPack: existing.units_per_master_pack,
        masterPackSize: existing.master_pack_size, packagingType: existing.packaging_type,
        stockQuantity: existing.stock_quantity, stockType: existing.stock_type,
        dispatchTimeDays: existing.dispatch_time_days, productionLeadTimeDays: existing.production_lead_time_days,
        sellerLocation: existing.seller_location, dispatchLocation: existing.dispatch_location,
        deliveryTimeline: existing.delivery_timeline, freightTerms: existing.freight_terms,
        hsnCode: existing.hsn_code, gstRegistrationStatus: existing.gst_registration_status,
        taxInvoiceAvailable: existing.tax_invoice_available,
        paymentTerms: existing.payment_terms, returnPolicy: existing.return_policy, warranty: existing.warranty,
        qualityCertificates: existing.quality_certificates, tdsMsdsCoa: existing.tds_msds_coa,
        otherCertifications: existing.other_certifications,
    };
    const merged = { ...camelFromExisting, ...rawBody };
    if (!Array.isArray(rawBody.images)) merged.images = existing.image ? [existing.image] : [];

    const missing = validateListingPayload(merged, { requireIdentity: false });
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    const row = toListingRow(merged);
    const wasRejected = existing.review_status === "rejected";
    const patch = { ...row };
    if (wasRejected) {
        patch.review_status = "pending_review";
        patch.rejection_reason = null;
        patch.reviewed_at = null;
        patch.reviewed_by = null;
    }

    const { data: updated, error } = await supabase
        .from("seller_product_submissions")
        .update(patch)
        .eq("id", id)
        .select("id, price, updated_at, review_status")
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    if (wasRejected) {
        await notifyAdmins({
            type: "seller_submission",
            title: "Listing resubmitted for review",
            message: `"${existing.brand?.name || "A listing"}" was edited and resubmitted after rejection.`,
            link: `/admin/listings?highlight=${id}`,
        });
        await notifyAdminSubmissionsChanged();
    }

    const marketplace = await computeMarketplaceFigures(updated.price);
    res.json({ success: true, submission: updated, marketplace, message: wasRejected ? "Resubmitted for review." : "Listing updated." });
}