// controllers/adminSellerSubmissions.controller.js
//
// Admin review + edit for seller listings. Rewritten around the full
// commercial spec now stored on seller_product_submissions (Product /
// Pricing / Quantity / Packaging / Availability / Delivery / Tax & Legal /
// Commercial Terms / Quality) — same field set the seller's own listing
// form (SellerListingForm.jsx) collects. Admin can now see and correct
// everything a seller filled in, not just the old 5-field shape
// (price/moq/unit/lead_time/image).
//
// Product identity (name/brand/images) still lives on the linked brand
// item (hs_generic_product_brands) and is edited there when it needs to
// change — this controller edits identity ONLY when the admin explicitly
// supplies productName/brandName/images, exactly as before.

import { supabase } from "../config/supabase.js";
import { notifyUser, notifySellerSubmissionsChanged, notifyAdminSubmissionsChanged } from "../services/notifications.service.js";
import { computeFinalPrice, computeMarketplaceFigures } from "../services/pricing.service.js";

// See listSubmissionsForBrandItem() at the bottom of this file for the
// endpoint that powers AdminCatalogDetailPage's new "Seller listings"
// panel on the brand_item level.

// Full row — every commercial-spec column plus the brand-item embed.
// Used for the list view (lighter columns) and detail/edit view (full *).
const BRAND_EMBED = `
    id, price, base_price, gst_percent, moq, unit, lead_time, image, stock_quantity,
    stock_type, hsn_code, price_validity_till,
    review_status, rejection_reason, created_at, updated_at, is_active,
    seller:seller_profiles(id, display_name, user_id),
    brand:hs_generic_product_brands(
        id, name, brand_name, image, images,
        
        generic_product:hs_generic_products(id, name,
            subcategory:hs_subcategories(id, name, category:hs_categories(id, name))
        )
    )
`;

const FULL_DETAIL_EMBED = `*, ${BRAND_EMBED}`;

const GST_REG_STATUSES = ["regular", "composition", "unregistered"];
const STOCK_TYPES = ["ready_stock", "made_to_order"];

// Normalizes a row so the frontend (which expects product_name/brand_name/
// image/generic_product directly on the item) keeps working unchanged,
// regardless of whether the row uses the new brand-linked shape or an
// older row that still has its own product_name/brand_name/image set.
function normalizeSubmission(row) {
    if (!row) return row;
    const brand = row.brand || {};
    return {
        ...row,
        product_name: row.product_name || brand.name || null,
        brand_name: row.brand_name || brand.brand_name || null,
        image: row.image || brand.image || null,
        images: (brand.images && brand.images.length ? brand.images : (row.image || brand.image ? [row.image || brand.image] : [])),
        generic_product: row.generic_product || brand.generic_product || null,
    };
}

// GET /api/admin/seller-submissions?status=pending_review&q=
export async function listSellerSubmissions(req, res) {
    const { status = "pending_review", q = "" } = req.query;
    let query = supabase
        .from("seller_product_submissions")
        .select(BRAND_EMBED)
        .order("created_at", { ascending: false })
        .limit(200);
    if (status !== "all") query = query.eq("review_status", status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    let items = (data || []).map(normalizeSubmission);

    // Filtering by product/brand name now has to happen after the join
    // (can't ilike across a related table in one PostgREST query), so we
    // filter in memory once rows are normalized.
    if (q.trim()) {
        const term = q.trim().toLowerCase();
        items = items.filter(
            (it) =>
                it.product_name?.toLowerCase().includes(term) ||
                it.brand_name?.toLowerCase().includes(term)
        );
    }

    res.json({ success: true, items });
}

// GET /api/admin/seller-submissions/:id — full record (every commercial
// field), used to power the admin's rich edit view.
export async function getSellerSubmission(req, res) {
    const { id } = req.params;
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(FULL_DETAIL_EMBED)
        .eq("id", id)
        .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Not found." });

    const normalized = normalizeSubmission(data);
    const marketplace = await computeMarketplaceFigures(normalized.price);
    res.json({ success: true, submission: normalized, marketplace });
}

// PATCH /api/admin/seller-submissions/:id
//
// Admin can now correct ANY field a seller filled in — not just the old
// price/moq/unit/lead_time/image shim. Two groups of things get touched:
//
//  1. Commercial-spec fields on the submission itself (pricing, quantity,
//     packaging, availability, delivery, tax & legal, commercial terms,
//     quality). Accepts the SAME camelCase keys the seller's own form
//     posts (basePrice, gstPercent, packSize, stockType, hsnCode, etc.)
//     so the admin edit UI can reuse the same field set 1:1.
//
//  2. Product identity (productName/brandName/images), which lives on
//     the linked brand item (hs_generic_product_brands), not on the
//     submission — updated there only when those keys are provided.
//
// review_status is intentionally never touched here; use approve/reject
// for that. price is always recomputed from basePrice+gstPercent server
// side if either is provided, so it can never drift out of sync.
export async function updateSellerSubmission(req, res) {
    const { id } = req.params;
    const body = req.body || {};

    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("*, generic_product_brand_id, seller:seller_profiles(user_id)")
        .eq("id", id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    // --- legacy flat shim: old admin UI may still post price/leadTime/stock_quantity directly ---
    const b = { ...body };
    if (b.price !== undefined && b.basePrice === undefined) {
        const gstForCalc = b.gstPercent ?? existing.gst_percent ?? 0;
        b.basePrice = Math.round((Number(b.price) / (1 + Number(gstForCalc) / 100) + Number.EPSILON) * 100) / 100;
    }
    if (b.leadTime !== undefined && b.dispatchTimeDays === undefined && b.productionLeadTimeDays === undefined) {
        const stockType = b.stockType ?? existing.stock_type ?? "ready_stock";
        if (stockType === "made_to_order") b.productionLeadTimeDays = b.leadTime;
        else b.dispatchTimeDays = b.leadTime;
    }
    if (b.stock_quantity !== undefined && b.stockQuantity === undefined) b.stockQuantity = b.stock_quantity;
    // --- end shim ---

    const submissionUpdate = {};

    // Product
    if (b.manufacturer !== undefined) submissionUpdate.manufacturer = b.manufacturer?.trim() || null;
    if (b.modelNo !== undefined) submissionUpdate.model_no = b.modelNo?.trim() || null;
    if (b.gradeVariant !== undefined) submissionUpdate.grade_variant = b.gradeVariant?.trim() || null;
    if (b.specifications !== undefined) submissionUpdate.specifications = Array.isArray(b.specifications) ? b.specifications.filter((s) => s?.key?.trim()) : [];

    // Pricing — basePrice/gstPercent drive the canonical `price` too
    const nextBasePrice = b.basePrice !== undefined ? Number(b.basePrice) : existing.base_price;
    const nextGstPercent = b.gstPercent !== undefined ? Number(b.gstPercent) : existing.gst_percent;
    if (b.basePrice !== undefined || b.gstPercent !== undefined) {
        submissionUpdate.base_price = nextBasePrice;
        submissionUpdate.gst_percent = nextGstPercent;
        submissionUpdate.price = computeFinalPrice(nextBasePrice, nextGstPercent);
    }
    if (b.ratePerPack !== undefined) submissionUpdate.rate_per_pack = b.ratePerPack === "" || b.ratePerPack == null ? null : Number(b.ratePerPack);
    if (b.ratePerMasterPack !== undefined) submissionUpdate.rate_per_master_pack = b.ratePerMasterPack === "" || b.ratePerMasterPack == null ? null : Number(b.ratePerMasterPack);
    if (b.priceValidityTill !== undefined) submissionUpdate.price_validity_till = b.priceValidityTill || null;

    // Quantity
    if (b.moq !== undefined) submissionUpdate.moq = Number(b.moq);
    if (b.sampleAvailable !== undefined) submissionUpdate.sample_available = Boolean(b.sampleAvailable);
    if (b.samplePrice !== undefined) submissionUpdate.sample_price = b.samplePrice === "" || b.samplePrice == null ? null : Number(b.samplePrice);
    if (b.priceSlabs !== undefined) submissionUpdate.price_slabs = Array.isArray(b.priceSlabs) ? b.priceSlabs.filter((s) => s?.minQty) : [];
    if (b.quantityDiscounts !== undefined) submissionUpdate.quantity_discounts = Array.isArray(b.quantityDiscounts) ? b.quantityDiscounts.filter((s) => s?.minQty) : [];

    // Packaging
    if (b.packSize !== undefined) submissionUpdate.pack_size = Number(b.packSize);
    if (b.unit !== undefined) submissionUpdate.unit = b.unit;
    if (b.unitsPerMasterPack !== undefined) submissionUpdate.units_per_master_pack = b.unitsPerMasterPack === "" || b.unitsPerMasterPack == null ? null : Number(b.unitsPerMasterPack);
    if (b.masterPackSize !== undefined) submissionUpdate.master_pack_size = b.masterPackSize === "" || b.masterPackSize == null ? null : Number(b.masterPackSize);
    if (b.packagingType !== undefined) submissionUpdate.packaging_type = b.packagingType?.trim() || null;

    // Availability — lead_time (buyer-facing) recomputed alongside stock fields
    const nextStockType = b.stockType !== undefined ? b.stockType : existing.stock_type;
    if (b.stockQuantity !== undefined) submissionUpdate.stock_quantity = b.stockQuantity === "" || b.stockQuantity == null ? null : Number(b.stockQuantity);
    if (b.stockType !== undefined) {
        if (!STOCK_TYPES.includes(b.stockType)) return res.status(400).json({ success: false, message: "Invalid stock type." });
        submissionUpdate.stock_type = b.stockType;
    }
    if (b.dispatchTimeDays !== undefined) submissionUpdate.dispatch_time_days = b.dispatchTimeDays === "" || b.dispatchTimeDays == null ? null : Number(b.dispatchTimeDays);
    if (b.productionLeadTimeDays !== undefined) submissionUpdate.production_lead_time_days = b.productionLeadTimeDays === "" || b.productionLeadTimeDays == null ? null : Number(b.productionLeadTimeDays);
    if (b.dispatchTimeDays !== undefined || b.productionLeadTimeDays !== undefined || b.stockType !== undefined) {
        const effectiveDispatch = b.dispatchTimeDays !== undefined ? b.dispatchTimeDays : existing.dispatch_time_days;
        const effectiveProduction = b.productionLeadTimeDays !== undefined ? b.productionLeadTimeDays : existing.production_lead_time_days;
        submissionUpdate.lead_time = Number(nextStockType === "made_to_order" ? (effectiveProduction || 0) : (effectiveDispatch || 0));
    }

    // Delivery
    if (b.sellerLocation !== undefined) submissionUpdate.seller_location = b.sellerLocation?.trim() || null;
    if (b.dispatchLocation !== undefined) submissionUpdate.dispatch_location = b.dispatchLocation?.trim() || null;
    if (b.deliveryTimeline !== undefined) submissionUpdate.delivery_timeline = b.deliveryTimeline?.trim() || null;
    if (b.freightTerms !== undefined) submissionUpdate.freight_terms = b.freightTerms?.trim() || null;

    // Tax & Legal
    if (b.hsnCode !== undefined) submissionUpdate.hsn_code = b.hsnCode?.trim() || null;
    if (b.gstRegistrationStatus !== undefined) {
        if (!GST_REG_STATUSES.includes(b.gstRegistrationStatus)) return res.status(400).json({ success: false, message: "Invalid GST registration status." });
        submissionUpdate.gst_registration_status = b.gstRegistrationStatus;
    }
    if (b.taxInvoiceAvailable !== undefined) submissionUpdate.tax_invoice_available = Boolean(b.taxInvoiceAvailable);

    // Commercial terms
    if (b.paymentTerms !== undefined) submissionUpdate.payment_terms = b.paymentTerms?.trim() || null;
    if (b.returnPolicy !== undefined) submissionUpdate.return_policy = b.returnPolicy?.trim() || null;
    if (b.warranty !== undefined) submissionUpdate.warranty = b.warranty?.trim() || null;

    // Quality
    if (b.qualityCertificates !== undefined) submissionUpdate.quality_certificates = Array.isArray(b.qualityCertificates) ? b.qualityCertificates.filter((c) => c?.url) : [];
    if (b.tdsMsdsCoa !== undefined) submissionUpdate.tds_msds_coa = Array.isArray(b.tdsMsdsCoa) ? b.tdsMsdsCoa.filter((c) => c?.url) : [];
    if (b.otherCertifications !== undefined) submissionUpdate.other_certifications = Array.isArray(b.otherCertifications) ? b.otherCertifications.filter((c) => c?.url) : [];

    // --- product identity lives on the linked brand item, not here ---
    const brandUpdate = {};
    if (b.productName !== undefined) brandUpdate.name = b.productName.trim();
    if (b.brandName !== undefined) brandUpdate.brand_name = b.brandName.trim();
    if (Array.isArray(b.images)) {
        brandUpdate.images = b.images;
        brandUpdate.image = b.images[0] || null;
        submissionUpdate.image = b.images[0] || null; // keep the submission's cover in sync too
    }

    if (!Object.keys(submissionUpdate).length && !Object.keys(brandUpdate).length) {
        return res.status(400).json({ success: false, message: "No editable fields provided." });
    }

    if (Object.keys(submissionUpdate).length) {
        const { error } = await supabase.from("seller_product_submissions").update(submissionUpdate).eq("id", id);
        if (error) return res.status(500).json({ success: false, message: error.message });
    }
    if (Object.keys(brandUpdate).length && existing.generic_product_brand_id) {
        const { error } = await supabase.from("hs_generic_product_brands").update(brandUpdate).eq("id", existing.generic_product_brand_id);
        if (error) {
            if (error.code === "23505") return res.status(409).json({ success: false, message: "That product + brand name already exists." });
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(FULL_DETAIL_EMBED)
        .eq("id", id)
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    await notifyAdminSubmissionsChanged();
    if (existing.seller?.user_id) await notifySellerSubmissionsChanged(existing.seller.user_id);

    const normalized = normalizeSubmission(data);
    const marketplace = await computeMarketplaceFigures(normalized.price);
    res.json({ success: true, submission: normalized, marketplace });
}

// POST /api/admin/seller-submissions/:id/approve
export async function approveSellerSubmission(req, res) {
    const { id } = req.params;
    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select(`
            id, product_name, generic_product_brand_id,
            seller:seller_profiles(user_id),
            brand:hs_generic_product_brands(
                name, review_status,
                generic_product:hs_generic_products(
                    id, review_status,
                    subcategory:hs_subcategories(
                        id, review_status,
                        category:hs_categories(id, review_status)
                    )
                )
            )
        `)
        .eq("id", id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    if (!existing.brand?.generic_product?.id) {
        return res.status(400).json({
            success: false,
            message: "This item's category hasn't been mapped yet. Map it from Admin → Catalog → this brand item first.",
        });
    }
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .update({ review_status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: req.user.id, rejection_reason: null })
        .eq("id", id)
        .select()
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    // Approving the listing is what makes any newly-proposed hierarchy
    // nodes "real" — cascade top-down so buyer-facing browse (which only
    // reads approved rows) picks the whole chain up in one shot.
    const now = new Date().toISOString();
    const cat = existing.brand?.generic_product?.subcategory?.category;
    const sub = existing.brand?.generic_product?.subcategory;
    const gp = existing.brand?.generic_product;
    if (cat?.review_status === "pending_review") {
        await supabase.from("hs_categories").update({ review_status: "approved", reviewed_at: now, reviewed_by: req.user.id }).eq("id", cat.id);
    }
    if (sub?.review_status === "pending_review") {
        await supabase.from("hs_subcategories").update({ review_status: "approved", reviewed_at: now, reviewed_by: req.user.id }).eq("id", sub.id);
    }
    if (gp?.review_status === "pending_review") {
        await supabase.from("hs_generic_products").update({ review_status: "approved", reviewed_at: now, reviewed_by: req.user.id }).eq("id", gp.id);
    }
    if (existing.generic_product_brand_id && existing.brand?.review_status === "pending_review") {
        const { error: brandErr } = await supabase
            .from("hs_generic_product_brands")
            .update({ review_status: "approved", reviewed_at: now, reviewed_by: req.user.id, rejection_reason: null })
            .eq("id", existing.generic_product_brand_id);
        if (brandErr) return res.status(500).json({ success: false, message: brandErr.message });
    }

    const displayName = existing.product_name || existing.brand?.name || "Your product";

    if (existing.seller?.user_id) {
        await notifyUser(existing.seller.user_id, {
            type: "listing_approved",
            title: "Your product listing was approved",
            message: `"${displayName}" is now live on your shop.`,
            link: `/home?highlight=${id}`,
        });
        await notifySellerSubmissionsChanged(existing.seller.user_id);
    }
    await notifyAdminSubmissionsChanged(); // so other open admin tabs drop this from "Pending" live
    res.json({ success: true, submission: normalizeSubmission(data) });
}

// POST /api/admin/seller-submissions/:id/reject   { reason }
export async function rejectSellerSubmission(req, res) {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "A rejection reason is required." });

    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("id, product_name, seller:seller_profiles(user_id), brand:hs_generic_product_brands(name)")
        .eq("id", id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    const { data, error } = await supabase
        .from("seller_product_submissions")
        .update({ review_status: "rejected", rejection_reason: reason.trim(), reviewed_at: new Date().toISOString(), reviewed_by: req.user.id })
        .eq("id", id)
        .select()
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    const displayName = existing.product_name || existing.brand?.name || "Your product";

    if (existing.seller?.user_id) {
        await notifyUser(existing.seller.user_id, {
            type: "listing_rejected",
            title: "Your product listing needs changes",
            message: `"${displayName}" wasn't approved: ${reason.trim()}`,
            link: "/seller/status",
        });
        await notifySellerSubmissionsChanged(existing.seller.user_id);
    }
    await notifyAdminSubmissionsChanged();
    res.json({ success: true, submission: normalizeSubmission(data) });
}

// GET /api/admin/seller-submissions/by-brand-item/:brandItemId
//
// Powers the "Seller listings" panel on AdminCatalogDetailPage for
// level === "brand_item". Since commercial terms live entirely on
// seller_product_submissions (not on hs_generic_product_brands itself),
// this is how an admin editing a brand item's identity discovers who's
// actually selling it and jumps to their full commercial-spec edit.
export async function listSubmissionsForBrandItem(req, res) {
    const { brandItemId } = req.params;
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(`
            id, price, moq, unit, stock_type, review_status, created_at,
            seller:seller_profiles(id, display_name)
        `)
        .eq("generic_product_brand_id", brandItemId)
        .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}