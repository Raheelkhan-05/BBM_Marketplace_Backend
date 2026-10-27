// controllers/adminSellerSubmissions.controller.js — REALIGNED + PAGINATED
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
// PRODUCT-LEVEL AUTO-APPROVAL: approveSellerSubmission also auto-approves
// any other still-pending submissions for the same brand item in the same
// request, and notifies each of those sellers.
//
// "NEEDS MAPPING" TAB: status=unmapped lists approved rows whose brand item
// has no generic_product yet.
//
// PAGINATION (this pass): listSellerSubmissions used to fetch a hard
// .limit(200) and then filter (unmapped / search) in JS, so the page could
// neither show the real total nor reach anything past row 200. It now:
//   - returns the TRUE total for the current status + search ({ count: "exact" }),
//   - pages with limit/offset (default 100, max 300),
//   - filters "unmapped" IN THE DATABASE (inner join on the brand item, so
//     the count and the pages are both correct),
//   - searches product / brand / seller / generic product / subcategory /
//     category IN THE DATABASE, so search covers every record, not just the
//     ones already loaded in the browser.
// Order is created_at DESC, id DESC (id as tie-breaker so pages never
// overlap or skip rows that share a timestamp).

import { supabase } from "../config/supabase.js";
import { notifyUser, notifySellerSubmissionsChanged, notifyAdminSubmissionsChanged } from "../services/notifications.service.js";
import { computeFinalPrice, computeMarketplaceFigures } from "../services/pricing.service.js";

const PAGE_DEFAULT = 100;
const PAGE_MAX = 300;

// `inner` = true makes the brand join an INNER join, which is what lets us
// filter on brand columns (unmapped) and still get a correct count/pages.
const buildEmbed = (inner = false) => `
    id, price, base_price, gst_percent, moq, unit, lead_time, image, stock_quantity,
    stock_type, hsn_code, price_basis, gst_inclusive_input, freight_included,
    dispatch_pincode, note_to_admin,
    review_status, rejection_reason, created_at, updated_at, is_active,
    seller:seller_profiles(id, display_name, user_id),
    brand:hs_generic_product_brands${inner ? "!inner" : ""}(
        id, name, brand_name, image, images, generic_product_id,
        generic_product:hs_generic_products(id, name,
            subcategory:hs_subcategories(id, name, category:hs_categories(id, name))
        )
    )
`;

const BRAND_EMBED = buildEmbed(false);
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

const clampInt = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

// Strips characters that would break a PostgREST .or() expression or act as wildcards.
const cleanTerm = (q) => String(q || "").replace(/[%,()*\\"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

// Resolves a search term to the seller keys + brand-item ids it matches, using a
// handful of small, capped lookups (only runs when the admin actually types a
// search). Matching is by product / brand name, seller display name, generic
// product, subcategory and category name. Lookups that fail simply contribute nothing.
async function resolveSearchTargets(term) {
    const pat = `%${term}%`;
    const rows = async (q) => { const { data } = await q; return data || []; };

    const [sellers, brandsByName, gpsByName, subsByName, catsByName] = await Promise.all([
        rows(supabase.from("seller_profiles").select("id, user_id").ilike("display_name", pat).limit(50)),
        rows(supabase.from("hs_generic_product_brands").select("id").or(`name.ilike.${pat},brand_name.ilike.${pat}`).limit(120)),
        rows(supabase.from("hs_generic_products").select("id").ilike("name", pat).limit(60)),
        rows(supabase.from("hs_subcategories").select("id").ilike("name", pat).limit(40)),
        rows(supabase.from("hs_categories").select("id").ilike("name", pat).limit(20)),
    ]);

    // category -> subcategories
    let subIds = subsByName.map((r) => r.id);
    if (catsByName.length) {
        const more = await rows(supabase.from("hs_subcategories").select("id").in("category_id", catsByName.map((r) => r.id)).limit(60));
        subIds = [...new Set([...subIds, ...more.map((r) => r.id)])];
    }
    // subcategory -> generic products
    let gpIds = gpsByName.map((r) => r.id);
    if (subIds.length) {
        const more = await rows(supabase.from("hs_generic_products").select("id").in("subcategory_id", subIds.slice(0, 60)).limit(100));
        gpIds = [...new Set([...gpIds, ...more.map((r) => r.id)])];
    }
    // generic products -> brand items
    let brandIds = brandsByName.map((r) => r.id);
    if (gpIds.length) {
        const more = await rows(supabase.from("hs_generic_product_brands").select("id").in("generic_product_id", gpIds.slice(0, 100)).limit(120));
        brandIds = [...new Set([...brandIds, ...more.map((r) => r.id)])];
    }

    // seller_id may point at seller_profiles.id or at the user id depending on the
    // schema; including both is harmless (UUIDs never collide across the two).
    const sellerKeys = [...new Set(sellers.flatMap((s) => [s.id, s.user_id]).filter(Boolean))];
    return { sellerKeys, brandIds: brandIds.slice(0, 120) };
}

// GET /api/admin/seller-submissions?status=pending_review&q=&limit=100&offset=0
//
// Response: { success, items, total, offset, limit, hasMore }
//   total   = the real number of rows matching status + q (not just this page)
//   hasMore = whether more rows exist after this page
//
// status "unmapped" = approved submissions whose brand item hasn't been
// mapped to a category/subcategory/generic product yet. Already live for
// buyers, so excluded from "Pending" but still needing admin attention.
export async function listSellerSubmissions(req, res) {
    const status = String(req.query.status || "pending_review");
    const term = cleanTerm(req.query.q);
    const limit = clampInt(req.query.limit, 1, PAGE_MAX, PAGE_DEFAULT);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);

    try {
        let query = supabase
            .from("seller_product_submissions")
            .select(buildEmbed(status === "unmapped"), { count: "exact" });

        query = applyFilters(query, status, term ? await buildOrClause(term) : null);

        const { data, error, count } = await query
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            // Asking for a page past the end (rows were removed meanwhile) isn't a failure.
            if (error.code === "PGRST103") {
                return res.json({ success: true, items: [], total: count ?? offset, offset, limit, hasMore: false });
            }
            return res.status(500).json({ success: false, message: error.message });
        }

        let items = (data || []).map(normalizeSubmission);
        const total = count ?? (offset + items.length);

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

        res.json({
            success: true,
            items,
            total,
            offset,
            limit,
            hasMore: offset + (data?.length || 0) < total,
        });
    } catch (e) {
        console.error("[adminSellerSubmissions] list:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't load listings. Please try again." });
    }
}

// Shared by the paged list and by "select all matching" so both always agree.
// status filter (unmapped needs the inner-joined brand embed, see buildEmbed(true)).
function applyFilters(query, status, orClause) {
    if (status === "unmapped") {
        // Approved + the brand item has no generic product, done in SQL.
        query = query.eq("review_status", "approved").is("brand.generic_product_id", null);
    } else if (status !== "all") {
        query = query.eq("review_status", status);
    }
    if (orClause) query = query.or(orClause);
    return query;
}

// Search term -> one PostgREST .or() expression (resolved once per request).
async function buildOrClause(term) {
    const pat = `%${term}%`;
    const { sellerKeys, brandIds } = await resolveSearchTargets(term);
    const parts = [`product_name.ilike.${pat}`];
    if (sellerKeys.length) parts.push(`seller_id.in.(${sellerKeys.join(",")})`);
    if (brandIds.length) parts.push(`generic_product_brand_id.in.(${brandIds.join(",")})`);
    return parts.join(",");
}

const SELECT_ALL_MAX = 5000;    // safety cap for one "select all matching"
const SELECT_ALL_BATCH = 1000;

// GET /api/admin/seller-submissions/matching?status=&q=
//
// Powers "Select all N listings": returns EVERY listing that matches the
// current tab + search (not just the page the admin has scrolled to), in a
// lightweight shape (enough for bulk category mapping). Capped at
// SELECT_ALL_MAX; `truncated` tells the UI if the cap was hit.
// Response: { success, items, total, truncated }
export async function listMatchingSubmissions(req, res) {
    const status = String(req.query.status || "pending_review");
    const term = cleanTerm(req.query.q);
    try {
        const orClause = term ? await buildOrClause(term) : null;
        const cols = `id, product_name, seller_id, generic_product_brand_id, review_status,
            brand:hs_generic_product_brands${status === "unmapped" ? "!inner" : ""}(id, name, brand_name, generic_product_id)`;

        const items = [];
        let total = 0;
        for (let from = 0; from < SELECT_ALL_MAX; from += SELECT_ALL_BATCH) {
            const q = applyFilters(
                supabase.from("seller_product_submissions").select(cols, { count: "exact" }),
                status, orClause,
            )
                .order("created_at", { ascending: false })
                .order("id", { ascending: false })
                .range(from, from + SELECT_ALL_BATCH - 1);
            const { data, error, count } = await q;
            if (error) {
                if (error.code === "PGRST103") break; // past the end
                return res.status(500).json({ success: false, message: error.message });
            }
            if (count != null) total = count;
            for (const r of data || []) {
                const b = firstOrSelf(r.brand) || {};
                items.push({
                    id: r.id,
                    product_name: r.product_name || b.name || null,
                    brand_name: b.brand_name || null,
                    review_status: r.review_status,
                    generic_product_brand_id: r.generic_product_brand_id,
                    brand: b.id ? { id: b.id, name: b.name, brand_name: b.brand_name } : null,
                    generic_product: b.generic_product_id ? { id: b.generic_product_id } : null,
                });
            }
            if (!data || data.length < SELECT_ALL_BATCH || items.length >= total) break;
        }
        res.json({ success: true, items, total: total || items.length, truncated: total > items.length });
    } catch (e) {
        console.error("[adminSellerSubmissions] matching:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't select all listings. Please try again." });
    }
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
            link: `/grow/products?highlight=${s.id}`,
        });
        await notifySellerSubmissionsChanged(sellerId);
    }
}

// POST /api/admin/seller-submissions/:id/approve
//
// Mapping is not a precondition for approval — admin can one-click approve
// and map the category/subcategory/generic product hierarchy later (via the
// "Needs mapping" tab / FixMappingPicker).
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
            link: `/grow/products?highlight=${id}`,
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
            link: "/grow/products",
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