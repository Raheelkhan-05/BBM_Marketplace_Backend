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
//
// PERFORMANCE FIX (this pass): SUBMISSION_LIST_COLUMNS was missing
// pack_size and units_per_master_pack. Since the frontend list page needs
// those two fields to label MOQ/price/stock correctly ("Pack" vs "Master
// Pack"), and the light list endpoint didn't return them, the frontend
// was firing a SEPARATE full-detail request for every single listing on
// the page just to fill in two fields — turning "load my listings" into
// "load my listings, then N more full-detail round trips" (N = however
// many products that seller has). Both fields already live directly on
// this table (see toListingRow below, which writes them onto the row at
// creation time) — there was never a reason to fetch them separately.
// Adding them here removes the need for that entire enrichment pass.
//
// COMMENT FIX (this pass): the note above the MOQ check in
// validateListingPayload() used to claim "moq is expressed in PACKS" —
// that was stale and directly contradicted toListingRow()'s own comment
// a few dozen lines down ("already sale-unit qty"), which is what's
// actually true and what the frontend list/detail/quick-update views all
// assume. That stale comment is exactly what led the frontend's edit
// form to wrongly re-divide an already-correct MOQ by masterPackSize on
// load (fixed in SellerListingForm.jsx). No behavior changes here — the
// check itself never converted anything — just the comment, corrected so
// it can't mislead anyone again.
import { supabase } from "../config/supabase.js";
import { notifyAdmins, notifyAdminSubmissionsChanged } from "../services/notifications.service.js";
import { slugify } from "../services/slugify.js";
import {
    getCommissionPercent, computeMarketplaceFigures,
    normalizeEnteredPrice,
} from "../services/pricing.service.js";

export const ALLOWED_UNITS = [
    "Pieces", "Kg", "Grams", "Litres", "Millilitres", "Meters",
    "Boxes", "Dozen", "Tons", "Pack", "Bundle", "Set", "Units",
];
const STOCK_TYPES = ["ready_stock", "made_to_order"];
const PRICE_BASES = ["per_unit", "per_pack", "per_master_pack"];
// Was: only "delivery". Now maps every field the seller listing form
// should be able to prefill from their last submission, split across the
// three existing group_type buckets (no schema change needed — these
// group types already existed for the "groups" feature).
const GROUP_FIELD_MAP = {
    delivery: ["dispatchPincode", "dispatchingLocations", "freightIncluded"],
    tax_legal: ["hsnCode", "gstPercent", "gstInclusive", "returnPolicyKey", "warrantyKey"],
    commercial_terms: ["priceBasis"],
};

// Replaces autoSaveDeliveryDefaults — same call sites (createSubmission,
// createListingForExistingBrand, updateSubmission), just saves across all
// three groups instead of only delivery.
async function autoSaveSellerDefaults(sellerId, body) {
    for (const [groupType, keys] of Object.entries(GROUP_FIELD_MAP)) {
        const data = Object.fromEntries(keys.map((k) => [k, body[k]]));
        const hasValue = Object.values(data).some((v) => v !== "" && v != null && !(Array.isArray(v) && v.length === 0));
        if (!hasValue) continue;
        try {
            const { data: existingTpl } = await supabase
                .from("seller_listing_templates")
                .select("id").eq("seller_id", sellerId).eq("group_type", groupType).eq("is_default", true)
                .maybeSingle();
            if (existingTpl) {
                await supabase.from("seller_listing_templates").update({ data }).eq("id", existingTpl.id);
            } else {
                await supabase.from("seller_listing_templates").insert({ seller_id: sellerId, group_type: groupType, name: "Default", data, is_default: true });
            }
        } catch { /* best-effort */ }
    }
}

// pack_size and units_per_master_pack ADDED — see PERFORMANCE FIX note
// above. This is the entire fix for the N+1 enrichment problem.
const SUBMISSION_LIST_COLUMNS = `
    id, created_at, updated_at, review_status, rejection_reason,
    reviewed_at, is_active, generic_product_brand_id,
    product_name, brand_name, image, price, base_price, moq, unit,
    pack_size, units_per_master_pack,
    stock_type, stock_quantity, production_lead_time_days,
    hs_generic_product_brands ( id, name, brand_name, image, images )
`;

const SUBMISSION_DETAIL_COLUMNS = `*, hs_generic_product_brands ( id, name, brand_name, image, images, brand_not_applicable )`;

/* ------------------------- brand resolution ------------------------- */
// Unit / pack size / master pack size are now a fixed property of the
// BRAND ITEM (hs_generic_product_brands), not something re-entered per
// seller listing. They're only asked for once — when a seller is the
// one establishing this catalog entry for the first time. Every seller
// who lists an already-existing brand item inherits these values as-is.

const BRAND_PACKAGING_COLS = "unit, pack_size, units_per_master_pack";

async function findExistingBrandItem({ productName, brandName, brandNotApplicable }) {
    const trimmedProduct = productName.trim();
    let query = supabase
        .from("hs_generic_product_brands")
        .select(`id, name, brand_name, ${BRAND_PACKAGING_COLS}`)
        .ilike("name", trimmedProduct);
    query = brandNotApplicable ? query.is("brand_name", null) : query.ilike("brand_name", brandName.trim());
    const { data } = await query.maybeSingle();
    return data || null;
}

function validateNewBrandPackaging(body) {
    const missing = [];
    if (!body.unit || !ALLOWED_UNITS.includes(body.unit)) missing.push("Unit of measurement");
    if (!(Number(body.packSize) > 0)) missing.push("Pack size");
    // if (!(Number(body.masterPackSize) > 0)) missing.push("Master pack size");
    return missing;
}

async function createBrandItem({ productName, brandName, brandImage, brandNotApplicable, images, unit, packSize, masterPackSize }) {
    const trimmedProduct = productName.trim();
    const insertRow = {
        generic_product_id: null,
        name: trimmedProduct,
        brand_name: brandNotApplicable ? null : brandName.trim(),
        brand_image: brandNotApplicable ? null : (brandImage || null),
        brand_not_applicable: Boolean(brandNotApplicable),
        slug: slugify(`${trimmedProduct}-${brandNotApplicable ? Date.now() : brandName.trim()}`),
        image: images[0] || null,
        images,
        unit,
        pack_size: Number(packSize),
        units_per_master_pack: Number(masterPackSize),
        is_ai_generated: false,
        review_status: "pending_review",
    };

    const { data: created, error } = await supabase
        .from("hs_generic_product_brands")
        .insert(insertRow)
        .select(`id, name, brand_name, ${BRAND_PACKAGING_COLS}`)
        .single();

    if (!error) return created;
    if (error.code !== "23505") throw error;

    // Someone else created the same brand item a moment ago — use theirs.
    const raced = await findExistingBrandItem({ productName, brandName, brandNotApplicable });
    if (raced) return raced;
    throw error;
}

/* ------------------------- validation ------------------------- */

function validateListingPayload(body) {
    const missing = [];

    if (!body.productName?.trim()) missing.push("Product name");
    if (!body.brandNotApplicable && !body.brandName?.trim()) missing.push("Brand");
    if (!(Array.isArray(body.images) && body.images.length)) missing.push("Product image");

    // NOTE: moq (like stock_quantity) is expressed in the listing's
    // canonical SALE UNIT — Master Pack when the listing has an outer
    // pack (units_per_master_pack >= 2), Pack otherwise — not always
    // literal Packs. See toListingRow() below and shared/packUnits.js.
    // Never multiply/divide this by pack_size or units_per_master_pack
    // when storing it — it's stored exactly as the seller/frontend sends
    // it.
    if (!(Number(body.moq) > 0)) missing.push("MOQ");
    // if (!body.hsnCode?.trim()) missing.push("HSN Code");
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

// `brand` supplies the fixed packaging identity (unit/pack_size/
// units_per_master_pack) — always sourced from hs_generic_product_brands,
// never from the seller's own submission.
function toListingRow(body, brand) {
    const unit = brand.unit;
    const packSize = Number(brand.pack_size);
    const masterPackSize = Number(brand.units_per_master_pack);

    // price / base_price, moq, stock_quantity, and quantity_discounts
    // minQty are now ALL denominated in the canonical sale unit (see
    // shared/packUnits.js). The frontend now sends moq/stock/slab
    // thresholds already in that unit — no conversion happens here.
    const { basePricePerSaleUnit, finalPricePerSaleUnit } = normalizeEnteredPrice(
        body.basePrice, body.gstPercent, body.gstInclusive, body.priceBasis,
        packSize, masterPackSize
    );
    const effectiveLeadTime = body.stockType === "made_to_order"
        ? Number(body.productionLeadTimeDays || 0)
        : Number(body.dispatchTimeDays || 0);
    const images = Array.isArray(body.images) ? body.images : [];

    return {
        product_name: body.productName?.trim() || null,
        brand_name: body.brandNotApplicable ? null : (body.brandName?.trim() || null),

        price: finalPricePerSaleUnit,
        base_price: basePricePerSaleUnit,
        moq: Number(body.moq),                    // already sale-unit qty
        stock_quantity: body.stockType === "ready_stock" && body.stockQuantity !== ""
            ? Number(body.stockQuantity) : null,   // already sale-unit qty
        unit,                                   // ← from brand item
        lead_time: effectiveLeadTime,
        image: images[0] || null,

        gst_percent: Number(body.gstPercent),
        price_basis: body.priceBasis,
        gst_inclusive_input: Boolean(body.gstInclusive),
        freight_included: Boolean(body.freightIncluded),

        pack_size: packSize,                    // ← from brand item
        units_per_master_pack: masterPackSize,   // ← from brand item

        sample_available: Boolean(body.sampleAvailable),
        sample_quantity: body.sampleAvailable ? Number(body.sampleQuantity) : null,
        sample_unit_basis: body.sampleAvailable ? body.sampleUnitBasis : null,

        price_slabs: [],
        quantity_discounts: Array.isArray(body.priceSlabs)
            ? body.priceSlabs.filter((s) => s?.minQty && s?.discountPercent) : [],


        stock_type: body.stockType,
        production_lead_time_days: body.stockType === "made_to_order" ? Number(body.productionLeadTimeDays) : null,

        dispatch_district: body.dispatchDistrict?.trim() || null,
        dispatch_state: body.dispatchState?.trim() || null,
        dispatch_pincode: body.dispatchPincode?.trim() || null,
        dispatching_locations: Array.isArray(body.dispatchingLocations) ? body.dispatchingLocations : [],

        // hsn_code: body.hsnCode?.trim() || null,
        return_policy_key: body.returnPolicyKey,
        warranty_key: body.warrantyKey,
        note_to_admin: body.noteToAdmin?.trim() || null,
        quality_certificates: Array.isArray(body.qualityCertificates) ? body.qualityCertificates.filter((c) => c?.url) : [],
    };
}

async function resolvePolicyText(kind, key) {
    if (!key) return null;
    const { data } = await supabase.from("listing_policy_options").select("full_text").eq("kind", kind).eq("key", key).maybeSingle();
    return data?.full_text || null;
}

/* ------------------------- create submission (brand-new-or-matched flow) ------------------------- */

export async function createSubmission(req, res) {
    const sellerId = req.sellerId;
    const body = req.body || {};

    const missing = validateListingPayload(body);
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    // 1) Does this exact product+brand already exist in the catalog?
    let brand;
    try {
        brand = await findExistingBrandItem({
            productName: body.productName,
            brandName: body.brandName,
            brandNotApplicable: Boolean(body.brandNotApplicable),
        });

        // 2) Only if it's genuinely new do we need packaging info from
        // this seller — they're the one establishing it.
        if (!brand) {
            const packagingMissing = validateNewBrandPackaging(body);
            if (packagingMissing.length) {
                return res.status(400).json({ success: false, message: `Please provide: ${packagingMissing.join(", ")}.`, missing: packagingMissing });
            }
            brand = await createBrandItem({
                productName: body.productName,
                brandName: body.brandName,
                brandImage: body.brandImage,
                brandNotApplicable: Boolean(body.brandNotApplicable),
                images: Array.isArray(body.images) ? body.images : [],
                unit: body.unit,
                packSize: body.packSize,
                masterPackSize: body.masterPackSize,
            });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }

    const isNewBrand = !brand.pack_size && !brand.unit ? false : true; // brand always has packaging by this point
    const { data: existingRow } = await supabase
        .from("seller_product_submissions")
        .select("id, review_status")
        .eq("seller_id", sellerId).eq("generic_product_brand_id", brand.id)
        .maybeSingle();
    if (existingRow && existingRow.review_status !== "rejected") {
        return res.status(409).json({ success: false, message: "You're already listing this item." });
    }

    const row = toListingRow(body, brand);
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

    await autoSaveSellerDefaults(sellerId, body);
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
        .select(`id, name, brand_name, image, images, review_status, ${BRAND_PACKAGING_COLS}`)
        .eq("id", genericProductBrandId).maybeSingle();
    if (brandErr) return res.status(500).json({ success: false, message: brandErr.message });
    if (!brand) return res.status(400).json({ success: false, message: "That item wasn't found." });
    if (brand.review_status !== "approved") return res.status(400).json({ success: false, message: "This item isn't available to list under yet." });

    // NEW — this brand item predates packaging being tracked (or was
    // otherwise created without it). The frontend detects this via
    // findBrandItemMatch and asks the seller to fill it in — so trust
    // body.unit/packSize/masterPackSize here, validate them, and BACKFILL
    // the brand item itself so this is the last time anyone has to.
    const packagingMissing = !brand.unit || !(Number(brand.pack_size) > 0) || !(Number(brand.units_per_master_pack) > 0);
    let effectiveBrand = brand;
    if (packagingMissing) {
        const missingFields = validateNewBrandPackaging(body);
        if (missingFields.length) {
            return res.status(400).json({ success: false, message: `Please provide: ${missingFields.join(", ")}.`, missing: missingFields });
        }
        const { data: backfilled, error: backfillErr } = await supabase
            .from("hs_generic_product_brands")
            .update({
                unit: body.unit,
                pack_size: Number(body.packSize),
                units_per_master_pack: Number(body.masterPackSize),
            })
            .eq("id", brand.id)
            .select(`id, name, brand_name, image, images, review_status, ${BRAND_PACKAGING_COLS}`)
            .single();
        if (backfillErr) return res.status(500).json({ success: false, message: backfillErr.message });
        effectiveBrand = backfilled;
    }

    const merged = { ...body, productName: effectiveBrand.name, brandName: effectiveBrand.brand_name, images: effectiveBrand.images?.length ? effectiveBrand.images : (effectiveBrand.image ? [effectiveBrand.image] : []) };

    const missing = validateListingPayload(merged);
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    const { data: existingRow } = await supabase
        .from("seller_product_submissions").select("id, review_status")
        .eq("seller_id", sellerId).eq("generic_product_brand_id", effectiveBrand.id).maybeSingle();
    if (existingRow && existingRow.review_status !== "rejected") {
        return res.status(409).json({ success: false, message: "You're already listing this item." });
    }

    const row = toListingRow(merged, effectiveBrand);   // ← was `brand`, now `effectiveBrand`
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
            .insert({ seller_id: sellerId, generic_product_brand_id: effectiveBrand.id, ...row })
            .select("id, created_at, price").single());
    }
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You're already listing this item." });
        return res.status(500).json({ success: false, message: error.message });
    }

    await autoSaveSellerDefaults(sellerId, body);
    await notifyAdmins({
        type: "seller_submission",
        title: existingRow ? "Listing resubmitted for review" : "New listing submitted",
        message: existingRow ? `A seller resubmitted "${effectiveBrand.name}" after rejection.` : `A seller wants to list "${effectiveBrand.name}".`,
        link: `/admin/listings?highlight=${result.id}`,
    });
    await notifyAdminSubmissionsChanged();

    const marketplace = await computeMarketplaceFigures(result.price);
    res.json({ success: true, submission: result, marketplace, message: `You're now listing "${effectiveBrand.name}"${existingRow ? " again" : ""}. We'll notify you once it's approved.` });
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

    const { data: existing, error: fetchErr } = await supabase
        .from("seller_product_submissions")
        .select(`*, hs_generic_product_brands ( ${BRAND_PACKAGING_COLS} )`)
        .eq("id", id).eq("seller_id", sellerId).maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, message: "Submission not found." });

    const brandPackaging = existing.hs_generic_product_brands || {
        unit: existing.unit, pack_size: existing.pack_size, units_per_master_pack: existing.units_per_master_pack,
    };

    const merged = {
        productName: existing.product_name,
        brandName: existing.brand_name,
        brandNotApplicable: !existing.brand_name,
        images: Array.isArray(body.images) && body.images.length ? body.images : [existing.image].filter(Boolean),

        moq: body.moq ?? existing.moq,
        // hsnCode: body.hsnCode ?? existing.hsn_code,
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

    const missing = validateListingPayload(merged);
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    const row = toListingRow(merged, brandPackaging);
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

    await autoSaveSellerDefaults(sellerId, body);
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