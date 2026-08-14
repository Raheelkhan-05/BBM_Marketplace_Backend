// Simplified seller flow: pick Category > Subcategory > Generic Product
// from the admin-curated catalog, then submit Product Name, Brand Name,
// Price, MOQ, Unit, Lead Time, and one image. Goes to
// seller_product_submissions as review_status='pending_review'.

import { supabase } from "../config/supabase.js";
import { notifyAdmins, notifyAdminSubmissionsChanged } from "../services/notifications.service.js";
import { slugify } from "../services/slugify.js"
const PICKER_LIMIT = 20;

export const ALLOWED_UNITS = [
    "Pieces", "Kg", "Grams", "Litres", "Millilitres", "Meters",
    "Boxes", "Dozen", "Tons", "Pack", "Bundle", "Set", "Units",
];

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

// GET /api/seller/catalog/generic-products?subcategoryId=&q=
export async function listApprovedGenericProducts(req, res) {
    const { subcategoryId, q = "" } = req.query;
    if (!subcategoryId) return res.status(400).json({ success: false, message: "subcategoryId is required." });
    let query = supabase.from("hs_generic_products").select("id, name, slug, image, subcategory_id").eq("subcategory_id", subcategoryId).eq("review_status", "approved").order("name").limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

function validateSubmission(body) {
    const missing = [];
    const { productName, brandName, price, moq, unit, leadTime, image, images } = body;
    if (!productName?.trim()) missing.push("Product name");
    if (!brandName?.trim()) missing.push("Brand name");
    if (!(Number(price) > 0)) missing.push("Price");
    if (!(Number(moq) > 0)) missing.push("MOQ");
    if (!unit || !ALLOWED_UNITS.includes(unit)) missing.push("Unit");
    if (!(Number(leadTime) >= 0)) missing.push("Lead time");
    if (!image && !(Array.isArray(images) && images.length)) missing.push("Product image");
    return missing;
}

// POST /api/seller/catalog/submissions
export async function createSubmission(req, res) {
    const sellerId = req.sellerId;
    const { genericProductId, productName, brandName, price, moq, unit, leadTime, image, images } = req.body || {};

    if (!genericProductId) return res.status(400).json({ success: false, message: "Please choose a product from the catalog." });
    const missing = validateSubmission(req.body || {});
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.`, missing });

    // Normalize: images[] is the source of truth going forward, image
    // (cover) always derives from it so every existing reader that only
    // knows about `image` keeps working unchanged.
    const finalImages = Array.isArray(images) && images.length ? images : (image ? [image] : []);
    const coverImage = finalImages[0] || null;

    const { data: generic, error: genericErr } = await supabase
        .from("hs_generic_products")
        .select("id, review_status")
        .eq("id", genericProductId)
        .maybeSingle();
    if (genericErr) return res.status(500).json({ success: false, message: genericErr.message });
    if (!generic) return res.status(400).json({ success: false, message: "Selected product wasn't found." });
    if (generic.review_status !== "approved") return res.status(400).json({ success: false, message: "This product isn't available to list under yet." });

    // Find or create the canonical brand item so future sellers can find
    // and claim it via "I want to sell this" instead of duplicating it.
    const trimmedName = productName.trim();
    const trimmedBrand = brandName.trim();
    let { data: brand } = await supabase
        .from("hs_generic_product_brands")
        .select("id")
        .eq("generic_product_id", generic.id)
        .ilike("name", trimmedName)
        .ilike("brand_name", trimmedBrand)
        .maybeSingle();

    if (!brand) {
        const { data: newBrand, error: createErr } = await supabase
            .from("hs_generic_product_brands")
            .insert({
                generic_product_id: generic.id,
                name: trimmedName,
                brand_name: trimmedBrand,
                slug: slugify(`${trimmedName}-${trimmedBrand}`),
                image: coverImage,
                images: finalImages,
                is_ai_generated: false,
                review_status: "pending_review", // stays gated behind admin approval, same as before
            })
            .select("id")
            .single();
        if (createErr && createErr.code !== "23505") return res.status(500).json({ success: false, message: createErr.message });
        if (createErr) {
            // Lost a race with another seller creating it simultaneously — reselect
            const { data: raced } = await supabase.from("hs_generic_product_brands").select("id")
                .eq("generic_product_id", generic.id).ilike("name", trimmedName).ilike("brand_name", trimmedBrand).maybeSingle();
            brand = raced;
        } else {
            brand = newBrand;
        }
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

    let inserted, error;
    if (existingRow) {
        ({ data: inserted, error } = await supabase
            .from("seller_product_submissions")
            .update({
                price: Number(price), moq: Number(moq), unit, lead_time: Number(leadTime), image: coverImage,
                review_status: "pending_review", rejection_reason: null, reviewed_at: null, reviewed_by: null,
            })
            .eq("id", existingRow.id)
            .select("id, created_at")
            .single());
    } else {
        ({ data: inserted, error } = await supabase
            .from("seller_product_submissions")
            .insert({
                seller_id: sellerId, generic_product_brand_id: brand.id,
                price: Number(price), moq: Number(moq), unit, lead_time: Number(leadTime), image: coverImage,
            })
            .select("id, created_at")
            .single());
    }
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You're already listing this item." });
        return res.status(500).json({ success: false, message: error.message });
    }

    await notifyAdmins({
        type: "seller_submission",
        title: existingRow ? "Listing resubmitted for review" : "New product submission",
        message: `${trimmedBrand} — ${trimmedName} ${existingRow ? "was resubmitted after rejection" : "is awaiting review"}.`,
        link: `/admin/listings?highlight=${inserted.id}`,
    });
    await notifyAdminSubmissionsChanged();


    res.json({ success: true, submission: inserted, message: "Submitted for review. We'll notify you once it's approved." });
}

// GET /api/seller/catalog/submissions?status=
export async function listMySubmissions(req, res) {
    const sellerId = req.sellerId;
    const { status } = req.query;
    let query = supabase
        .from("seller_product_submissions")
        .select(`
            id, price, moq, unit, lead_time, image, review_status, rejection_reason, created_at, updated_at,
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

    // console.log('listing.controller.js: listMySubmissions query:', query);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
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
    console.log('listing.controller.js: deleteSubmission findErr:', findErr);
    console.log('listing.controller.js: deleteSubmission existing:', existing);
    console.log('listing.controller.js: deleteSubmission sellerId:', sellerId);

    if (!existing || existing.seller_id !== sellerId) {
        return res.status(404).json({ success: false, message: "Listing not found." });
    }

    console.log('listing.controller.js: deleteSubmission existing:', existing);
    console.log('listing.controller.js: deleteSubmission sellerId:', sellerId);

    const { error } = await supabase.from("seller_product_submissions").delete().eq("id", id);
    console.log('listing.controller.js: deleteSubmission error:', error);
    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({ success: true, message: "Listing removed." });
}

// PATCH /api/seller/catalog/submissions/:id
// Seller edits commercial terms (price/moq/unit/leadTime/image/stock).
// These are routine updates to an already-reviewed listing — the
// identity of the item (brand item it's linked to) never changes here,
// only the seller's own terms — so this does NOT reset review_status.
// An approved listing stays approved and visible immediately; a
// pending/rejected one stays whatever it already was.
export async function updateSubmission(req, res) {
    const sellerId = req.sellerId;
    const { id } = req.params;

    const { data: existing, error: findErr } = await supabase
        .from("seller_product_submissions")
        .select("id, seller_id, price, moq, unit, lead_time, image, stock_quantity, review_status, brand:hs_generic_product_brands(name)")
        .eq("id", id)
        .maybeSingle();
    if (findErr) return res.status(500).json({ success: false, message: findErr.message });
    if (!existing || existing.seller_id !== sellerId) {
        return res.status(404).json({ success: false, message: "Listing not found." });
    }

    const body = req.body || {};
    const price = body.price !== undefined ? body.price : existing.price;
    const moq = body.moq !== undefined ? body.moq : existing.moq;
    const unit = body.unit !== undefined ? body.unit : existing.unit;
    const leadTime = body.leadTime !== undefined ? body.leadTime : (body.lead_time !== undefined ? body.lead_time : existing.lead_time);
    const image = body.image !== undefined ? body.image : existing.image;

    const stockProvided = Object.prototype.hasOwnProperty.call(body, "stock_quantity") || Object.prototype.hasOwnProperty.call(body, "stockQuantity");
    const rawStock = body.stock_quantity !== undefined ? body.stock_quantity : body.stockQuantity;
    const stockQuantity = stockProvided ? (rawStock === "" || rawStock === null ? null : Number(rawStock)) : existing.stock_quantity;

    const missing = [];
    if (!(Number(price) > 0)) missing.push("Price");
    if (!(Number(moq) > 0)) missing.push("MOQ");
    if (!unit || !ALLOWED_UNITS.includes(unit)) missing.push("Unit");
    if (!(Number(leadTime) >= 0)) missing.push("Lead time");
    if (stockQuantity != null && Number(stockQuantity) < 0) missing.push("Stock quantity can't be negative");
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.` });

    // Editing a REJECTED listing is a resubmission — it needs to go back
    // for review, otherwise it'd stay rejected forever with no path back.
    // Approved/pending listings keep their status on a routine edit.
    const wasRejected = existing.review_status === "rejected";
    const patch = {
        price: Number(price), moq: Number(moq), unit, lead_time: Number(leadTime),
        image: image || null, stock_quantity: stockQuantity,
    };
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
        .select("id, price, moq, unit, lead_time, image, stock_quantity, review_status, rejection_reason, updated_at")
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

    res.json({ success: true, submission: updated, message: wasRejected ? "Resubmitted for review." : "Listing updated." });
}

// POST /api/seller/catalog/listings   { genericProductBrandId, price, moq, unit, leadTime, image? }
// "I want to sell this" — seller picks an EXISTING brand item and only
// supplies commercial terms. No product/brand name/image re-entry.
export async function createListingForExistingBrand(req, res) {
    const sellerId = req.sellerId;
    const { genericProductBrandId, price, moq, unit, leadTime, image } = req.body || {};

    if (!genericProductBrandId) return res.status(400).json({ success: false, message: "Missing brand item." });
    const missing = [];
    if (!(Number(price) > 0)) missing.push("Price");
    if (!(Number(moq) > 0)) missing.push("MOQ");
    if (!unit || !ALLOWED_UNITS.includes(unit)) missing.push("Unit");
    if (!(Number(leadTime) >= 0)) missing.push("Lead time");
    if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.` });

    const { data: brand, error: brandErr } = await supabase
        .from("hs_generic_product_brands")
        .select("id, name, review_status")
        .eq("id", genericProductBrandId)
        .maybeSingle();
    if (brandErr) return res.status(500).json({ success: false, message: brandErr.message });
    if (!brand) return res.status(400).json({ success: false, message: "That item wasn't found." });
    if (brand.review_status !== "approved") return res.status(400).json({ success: false, message: "This item isn't available to list under yet." });

    // A seller has at most one row per brand item (unique constraint) —
    // but a REJECTED row was never live for buyers, so it shouldn't
    // permanently block a retry. Resubmit that row instead of inserting.
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

    let result, error;
    if (existingRow) {
        ({ data: result, error } = await supabase
            .from("seller_product_submissions")
            .update({
                price: Number(price), moq: Number(moq), unit, lead_time: Number(leadTime), image: image || null,
                review_status: "pending_review", rejection_reason: null, reviewed_at: null, reviewed_by: null,
            })
            .eq("id", existingRow.id)
            .select("id, created_at")
            .single());
    } else {
        ({ data: result, error } = await supabase
            .from("seller_product_submissions")
            .insert({
                seller_id: sellerId, generic_product_brand_id: brand.id,
                price: Number(price), moq: Number(moq), unit, lead_time: Number(leadTime), image: image || null,
            })
            .select("id, created_at")
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

    res.json({ success: true, submission: result, message: `You're now listing "${brand.name}"${existingRow ? " again" : ""}. We'll notify you once it's approved.` });
}