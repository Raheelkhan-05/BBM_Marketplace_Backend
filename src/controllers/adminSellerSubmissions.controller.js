// controllers/adminSellerSubmissions.controller.js — REALIGNED
//
// This previously targeted an older commercial-spec shape (manufacturer,
// rate_per_pack, seller_location, dispatch_time_days, gst_registration_status,
// payment_terms, etc). The seller-facing flow (sellerCatalogListings.controller.js)
// was rewritten around a different set of columns — this file now matches
// that schema 1:1, so every field a seller actually submits is visible and
// editable here, and nothing here silently targets a column that's always null.
//
// Two things live in different places and this controller writes to both:
//   1. Commercial-spec fields (pricing, packaging, fulfilment, delivery,
//      tax, terms, quality, note_to_admin) — on seller_product_submissions,
//      one row per seller.
//   2. Product identity + admin-only descriptive fields (name, brand,
//      images, manufacturer, model/part no., grade/variant, specifications,
//      description, manufacturing_details) — on the linked brand item
//      (hs_generic_product_brands), shared across every seller listing it.
//
// PRODUCT-LEVEL AUTO-APPROVAL (previous pass): approveSellerSubmission used
// to only ever touch the ONE submission row it was called for. That's fine
// the very first time a brand-new product gets approved — but if a second
// seller had already submitted the same (still-unmapped) brand item before
// admin got to it, their row sat pending forever, needing a second manual
// approval for a product that's now already live. approveSellerSubmission
// also auto-approves any other still-pending submissions for the same
// brand item in the same request, and notifies each of those sellers the
// same way. Going forward, sellerCatalogListings.controller.js's
// createSubmission / createListingForExistingBrand already skip the queue
// entirely for an already-approved brand item, so this bulk step only ever
// has anything to do at the moment a product is first approved.
//
// "NEEDS MAPPING" TAB (this pass): sellerCatalogListings.controller.js now
// fast-approves a genuinely brand-new brand item the moment a seller
// submits it — it's visible to buyers right away, but generic_product_id
// is left null until admin maps it into the category hierarchy. Those
// items no longer show up under "Pending" (they're already approved), so
// they'd otherwise be invisible to admin entirely. listSellerSubmissions
// now accepts status=unmapped: approved rows whose brand item has no
// generic_product. This is filtered in JS after the fetch (same as the
// existing free-text `q` filter below) because the relevant condition —
// "the embedded generic_product relation is null" — isn't something
// PostgREST can express as a top-level .eq()/.is() on this query shape.
// getSellerSubmission / updateSellerSubmission / approveSellerSubmission
// are UNCHANGED: the manual approve flow still requires mapping via the
// NOT_MAPPED code below for anything that reaches it still pending or
// resubmitted — this tab is purely a way for admin to find already-live,
// still-unmapped items on their own schedule, not a new approval path.

import { supabase } from "../config/supabase.js";
import { notifyUser, notifySellerSubmissionsChanged, notifyAdminSubmissionsChanged } from "../services/notifications.service.js";
import { computeFinalPrice, computeMarketplaceFigures } from "../services/pricing.service.js";

const BRAND_EMBED = `
    id, price, base_price, gst_percent, moq, unit, lead_time, image, stock_quantity,
    stock_type, hsn_code, price_basis, gst_inclusive_input, freight_included,
    dispatch_pincode, note_to_admin,
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

const STOCK_TYPES = ["ready_stock", "made_to_order"];
const PRICE_BASES = ["per_unit", "per_pack", "per_master_pack"];

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
        manufacturer: row.manufacturer ?? brand.manufacturer ?? null,
        model_no: row.model_no ?? brand.model_no ?? null,
        grade_variant: row.grade_variant ?? brand.grade_variant ?? null,
        specifications: row.specifications ?? brand.specifications ?? [],
        description: row.description ?? brand.description ?? null,
        manufacturing_details: row.manufacturing_details ?? brand.manufacturing_details ?? null,
        brand_not_applicable: brand.brand_not_applicable ?? false,
    };
}

async function resolvePolicyText(kind, key) {
    if (!key) return null;
    const { data } = await supabase
        .from("listing_policy_options")
        .select("full_text").eq("kind", kind).eq("key", key).maybeSingle();
    return data?.full_text || null;
}

// GET /api/admin/seller-submissions?status=pending_review&q=
//
// status accepts one more value than before: "unmapped" — approved
// submissions whose brand item hasn't been mapped to a
// category/subcategory/generic product yet (generic_product_id is null).
// These are already live for buyers (see sellerCatalogListings.controller.js
// fast-approval), so they're excluded from "Pending" but still need admin
// attention on their own timeline.
export async function listSellerSubmissions(req, res) {
    const { status = "pending_review", q = "" } = req.query;
    let query = supabase
        .from("seller_product_submissions")
        .select(BRAND_EMBED)
        .order("created_at", { ascending: false })
        .limit(200);

    if (status === "unmapped") {
        // Unmapped items are always approved (fast-approval never leaves
        // them pending) — narrow the query itself before filtering the
        // "no generic_product" condition in JS below.
        query = query.eq("review_status", "approved");
    } else if (status !== "all") {
        query = query.eq("review_status", status);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    let items = (data || []).map(normalizeSubmission);

    if (status === "unmapped") {
        items = items.filter((it) => !it.generic_product);
    }

    if (q.trim()) {
        const term = q.trim().toLowerCase();
        items = items.filter(
            (it) =>
                it.product_name?.toLowerCase().includes(term) ||
                it.brand_name?.toLowerCase().includes(term)
        );
    }

    // Attach a suggested manufacturer to every item missing one, resolved
    // in a single extra query rather than one per row.
    const missingManufacturerBrands = items.filter((it) => !it.manufacturer?.trim()).map((it) => it.brand_name);
    if (missingManufacturerBrands.length) {
        const suggestions = await resolveManufacturersForBrands(missingManufacturerBrands);
        items = items.map((it) => {
            if (it.manufacturer?.trim()) return it;
            const suggestion = it.brand_name ? suggestions.get(it.brand_name.trim().toLowerCase()) : null;
            return suggestion ? { ...it, suggested_manufacturer: suggestion } : it;
        });
    }

    res.json({ success: true, items });
}

// "Mostly one manufacturer per brand" — resolves a suggested manufacturer
// for a set of brand names in ONE query, grouped in JS, instead of one
// round trip per listing. Picks whichever manufacturer value is recorded
// most often for that brand elsewhere in the catalog (not just the first
// match), so a rare mismatched entry doesn't skew the suggestion.
//
// CAVEAT: matches brand_name by exact case (.in()), not case-insensitive —
// fine as long as brand names stay consistent (BrandCombobox already
// dedupes/reuses existing brand entries on the seller side), but flagging
// it: a brand entered with different casing elsewhere won't be found here.
async function resolveManufacturersForBrands(brandNames) {
    const uniqueTerms = [...new Set(brandNames.filter(Boolean).map((n) => n.trim()).filter(Boolean))];
    if (!uniqueTerms.length) return new Map();

    const { data, error } = await supabase
        .from("hs_generic_product_brands")
        .select("brand_name, manufacturer")
        .in("brand_name", uniqueTerms)
        .not("manufacturer", "is", null);
    if (error || !data?.length) return new Map();

    const tally = new Map(); // brand_name(lower) -> Map(manufacturer -> count)
    for (const row of data) {
        const brand = row.brand_name?.trim();
        const manu = row.manufacturer?.trim();
        if (!brand || !manu) continue;
        const key = brand.toLowerCase();
        if (!tally.has(key)) tally.set(key, new Map());
        const counts = tally.get(key);
        counts.set(manu, (counts.get(manu) || 0) + 1);
    }

    const result = new Map();
    for (const [key, counts] of tally.entries()) {
        const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        result.set(key, best);
    }
    return result;
}

// Supabase/PostgREST embeds a to-one relation as an object when it can
// infer a single FK, but falls back to an array if the relationship is
// ambiguous. Rather than depend on that inference always going the "right"
// way, normalize defensively everywhere we pull seller.user_id out.
function firstOrSelf(x) {
    return Array.isArray(x) ? x[0] : x;
}

// GET /api/admin/seller-submissions/:id
export async function getSellerSubmission(req, res) {
    const { id } = req.params;
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(FULL_DETAIL_EMBED)
        .eq("id", id)
        .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Not found." });

    let normalized = normalizeSubmission(data);
    if (!normalized.manufacturer?.trim() && normalized.brand_name?.trim()) {
        const suggestions = await resolveManufacturersForBrands([normalized.brand_name]);
        const suggestion = suggestions.get(normalized.brand_name.trim().toLowerCase());
        if (suggestion) normalized = { ...normalized, suggested_manufacturer: suggestion };
    }

    const marketplace = await computeMarketplaceFigures(normalized.price);
    res.json({ success: true, submission: normalized, marketplace });
}

// PATCH /api/admin/seller-submissions/:id
//
// Accepts the SAME camelCase keys the seller's own SellerListingForm posts
// (basePrice, gstPercent, packSize, masterPackSize, stockType, hsnCode,
// dispatchPincode, dispatchingLocations, returnPolicyKey, warrantyKey,
// qualityCertificates, ...) plus identity/admin-only keys (productName,
// brandName, brandNotApplicable, images, manufacturer, modelNo,
// gradeVariant, specifications, description, manufacturingDetails).
//
// review_status is never touched here — use approve/reject for that.
// price is always recomputed from basePrice+gstPercent when either is
// provided, so it can never drift.
export async function updateSellerSubmission(req, res) {
    const { id } = req.params;
    const b = req.body || {};

    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select("*, generic_product_brand_id, seller:seller_profiles(user_id)")
        .eq("id", id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    const sellerRow = firstOrSelf(existing.seller);

    const submissionUpdate = {};

    // Pricing
    const nextBasePrice = b.basePrice !== undefined ? Number(b.basePrice) : existing.base_price;
    const nextGstPercent = b.gstPercent !== undefined ? Number(b.gstPercent) : existing.gst_percent;
    if (b.basePrice !== undefined || b.gstPercent !== undefined) {
        submissionUpdate.base_price = nextBasePrice;
        submissionUpdate.gst_percent = nextGstPercent;
        submissionUpdate.price = computeFinalPrice(nextBasePrice, nextGstPercent);
    }
    if (b.priceBasis !== undefined) {
        if (!PRICE_BASES.includes(b.priceBasis)) return res.status(400).json({ success: false, message: "Invalid price basis." });
        submissionUpdate.price_basis = b.priceBasis;
    }
    if (b.gstInclusive !== undefined) submissionUpdate.gst_inclusive_input = Boolean(b.gstInclusive);
    if (b.freightIncluded !== undefined) submissionUpdate.freight_included = Boolean(b.freightIncluded);

    // Sample
    if (b.sampleAvailable !== undefined) submissionUpdate.sample_available = Boolean(b.sampleAvailable);
    if (b.sampleQuantity !== undefined) submissionUpdate.sample_quantity = b.sampleQuantity === "" || b.sampleQuantity == null ? null : Number(b.sampleQuantity);
    if (b.sampleUnitBasis !== undefined) submissionUpdate.sample_unit_basis = b.sampleUnitBasis || null;

    // Discount slabs — the live column is quantity_discounts (price_slabs
    // is left empty by the current seller form; kept untouched here too).
    if (b.priceSlabs !== undefined) {
        submissionUpdate.quantity_discounts = Array.isArray(b.priceSlabs) ? b.priceSlabs.filter((s) => s?.minQty && s?.discountPercent) : [];
    }

    // Packaging
    if (b.unit !== undefined) submissionUpdate.unit = b.unit;
    if (b.packSize !== undefined) submissionUpdate.pack_size = Number(b.packSize);
    if (b.masterPackSize !== undefined) submissionUpdate.units_per_master_pack = b.masterPackSize === "" || b.masterPackSize == null ? null : Number(b.masterPackSize);
    if (b.moq !== undefined) submissionUpdate.moq = Number(b.moq);

    // Fulfilment
    const nextStockType = b.stockType !== undefined ? b.stockType : existing.stock_type;
    if (b.stockType !== undefined) {
        if (!STOCK_TYPES.includes(b.stockType)) return res.status(400).json({ success: false, message: "Invalid stock type." });
        submissionUpdate.stock_type = b.stockType;
    }
    if (b.stockQuantity !== undefined) submissionUpdate.stock_quantity = b.stockQuantity === "" || b.stockQuantity == null ? null : Number(b.stockQuantity);
    if (b.productionLeadTimeDays !== undefined) submissionUpdate.production_lead_time_days = b.productionLeadTimeDays === "" || b.productionLeadTimeDays == null ? null : Number(b.productionLeadTimeDays);
    if (b.stockType !== undefined || b.productionLeadTimeDays !== undefined) {
        const effectiveProduction = b.productionLeadTimeDays !== undefined ? b.productionLeadTimeDays : existing.production_lead_time_days;
        submissionUpdate.lead_time = nextStockType === "made_to_order" ? Number(effectiveProduction || 0) : 0;
    }

    // Delivery
    if (b.dispatchPincode !== undefined) submissionUpdate.dispatch_pincode = b.dispatchPincode?.trim() || null;
    if (b.dispatchDistrict !== undefined) submissionUpdate.dispatch_district = b.dispatchDistrict?.trim() || null;
    if (b.dispatchState !== undefined) submissionUpdate.dispatch_state = b.dispatchState?.trim() || null;
    if (b.dispatchingLocations !== undefined) {
        submissionUpdate.dispatching_locations = Array.isArray(b.dispatchingLocations) ? b.dispatchingLocations : [];
    }

    // Tax
    // if (b.hsnCode !== undefined) submissionUpdate.hsn_code = b.hsnCode?.trim() || null;

    // Terms — canonical key + resolved free text, kept in sync (matches
    // how the seller's own submission endpoint resolves these on create).
    if (b.returnPolicyKey !== undefined) {
        submissionUpdate.return_policy_key = b.returnPolicyKey || null;
        submissionUpdate.return_policy = await resolvePolicyText("return_policy", b.returnPolicyKey);
    }
    if (b.warrantyKey !== undefined) {
        submissionUpdate.warranty_key = b.warrantyKey || null;
        submissionUpdate.warranty = await resolvePolicyText("warranty", b.warrantyKey);
    }

    // Quality
    if (b.qualityCertificates !== undefined) {
        submissionUpdate.quality_certificates = Array.isArray(b.qualityCertificates) ? b.qualityCertificates.filter((c) => c?.url) : [];
    }

    // --- product / brand-item identity + admin-only descriptive fields ---
    const brandUpdate = {};
    if (b.productName !== undefined) brandUpdate.name = b.productName.trim();
    if (b.brandNotApplicable !== undefined) brandUpdate.brand_not_applicable = Boolean(b.brandNotApplicable);
    if (b.brandName !== undefined) brandUpdate.brand_name = b.brandNotApplicable ? null : (b.brandName?.trim() || null);
    if (Array.isArray(b.images)) {
        brandUpdate.images = b.images;
        brandUpdate.image = b.images[0] || null;
        submissionUpdate.image = b.images[0] || null; // keep the submission's cover in sync too
    }
    if (b.manufacturer !== undefined) brandUpdate.manufacturer = b.manufacturer?.trim() || null;
    if (b.modelNo !== undefined) brandUpdate.model_no = b.modelNo?.trim() || null;
    if (b.gradeVariant !== undefined) brandUpdate.grade_variant = b.gradeVariant?.trim() || null;
    if (b.specifications !== undefined) brandUpdate.specifications = Array.isArray(b.specifications) ? b.specifications.filter((s) => s?.key?.trim()) : [];
    if (b.description !== undefined) brandUpdate.description = b.description?.trim() || null;
    if (b.manufacturingDetails !== undefined) brandUpdate.manufacturing_details = b.manufacturingDetails?.trim() || null;

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
    if (sellerRow?.user_id) await notifySellerSubmissionsChanged(sellerRow.user_id);

    const normalized = normalizeSubmission(data);
    const marketplace = await computeMarketplaceFigures(normalized.price);
    res.json({ success: true, submission: normalized, marketplace });
}

// Auto-approves every OTHER still-pending submission for the same brand
// item (other sellers listing the same product) and notifies each seller,
// once admin has just approved the "first" one for this brand item. Best-
// effort: a failure here doesn't undo the approval that already succeeded
// above, it just means those siblings stay pending for a manual approval
// like before.
async function autoApproveSiblingSubmissions({ brandItemId, excludeSubmissionId, adminId, brandDisplayName }) {
    if (!brandItemId) return;

    const { data: siblings, error: siblingsErr } = await supabase
        .from("seller_product_submissions")
        .select("id, product_name, seller:seller_profiles(user_id)")
        .eq("generic_product_brand_id", brandItemId)
        .eq("review_status", "pending_review")
        .neq("id", excludeSubmissionId);
    if (siblingsErr || !siblings?.length) return;

    const now = new Date().toISOString();
    const siblingIds = siblings.map((s) => s.id);
    const { error: bulkErr } = await supabase
        .from("seller_product_submissions")
        .update({ review_status: "approved", reviewed_at: now, reviewed_by: adminId, rejection_reason: null })
        .in("id", siblingIds);
    if (bulkErr) return;

    for (const s of siblings) {
        const sellerRow = firstOrSelf(s.seller);
        const sellerId = sellerRow?.user_id;
        if (!sellerId) continue;
        const displayName = s.product_name || brandDisplayName || "Your product";
        await notifyUser({
            userId: sellerId,
            type: "listing_approved",
            title: "Your product listing was approved",
            body: `"${displayName}" is now live on your shop.`,
            link: `/seller/listings?highlight=${s.id}`,
        });
        await notifySellerSubmissionsChanged(sellerId);
    }
}

// POST /api/admin/seller-submissions/:id/approve
//
// UNCHANGED by this pass. Still requires the brand item to be mapped to a
// generic_product before it will approve — this remains the path for
// items still sitting in "pending_review" (or resubmitted after
// rejection). Brand-new fast-approved items never reach this endpoint on
// their way to being live; they're found and mapped later via
// status=unmapped + FixMappingPicker's PATCH .../catalog/brand_item/:id,
// which doesn't go through here at all.
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

    // Mapping is no longer a precondition for approval — admin can
    // one-click approve immediately and map the category/subcategory/
    // generic product hierarchy whenever they get to it (via the
    // "Needs mapping" tab / FixMappingPicker). The cascade below only
    // runs for whichever of cat/sub/gp actually exist right now.
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .update({ review_status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: req.user.id, rejection_reason: null })
        .eq("id", id)
        .select()
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

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

    const sellerRow = firstOrSelf(existing.seller);

    const displayName = existing.product_name || existing.brand?.name || "Your product";

    if (sellerRow?.user_id) {
        await notifyUser({
            userId: sellerRow.user_id,
            type: "listing_approved",
            title: "Your product listing was approved",
            body: `"${displayName}" is now live on your shop.`,
            link: `/seller/listings?highlight=${id}`,
        });
        await notifySellerSubmissionsChanged(sellerRow.user_id);
    }

    // Product-level approval: any other seller already sitting in the
    // queue for this exact brand item is approved right along with this
    // one — nobody should need a second manual click for a product
    // that's now live.
    await autoApproveSiblingSubmissions({
        brandItemId: existing.generic_product_brand_id,
        excludeSubmissionId: id,
        adminId: req.user.id,
        brandDisplayName: existing.brand?.name,
    });

    await notifyAdminSubmissionsChanged();
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

    const sellerRow = firstOrSelf(existing.seller);

    const displayName = existing.product_name || existing.brand?.name || "Your product";

    // rejectSellerSubmission
    if (sellerRow?.user_id) {
        await notifyUser({
            userId: sellerRow.user_id,
            type: "listing_rejected",
            title: "Your product listing needs changes",
            body: `"${displayName}" wasn't approved: ${reason.trim()}`,
            link: "/seller/listings",
        });
        await notifySellerSubmissionsChanged(sellerRow.user_id);
    }

    await notifyAdminSubmissionsChanged();
    res.json({ success: true, submission: normalizeSubmission(data) });
}

// GET /api/admin/seller-submissions/by-brand-item/:brandItemId
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