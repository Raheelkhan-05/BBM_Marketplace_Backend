// src/controllers/api.controller.js
import { supabaseAdmin } from "../config/supabase.js";
import { getSitemap, getSsrMeta, normalizeSlug } from "../services/seo.service.js";
import { sanitizeEnquiry, toDto, isUuid, RFQ_STATUSES } from "../services/rfqValidation.js";
import { notifyAdminsNewRfq } from "../services/rfqNotify.js";
import { attachQuotes } from "../services/rfqQuotes.service.js";

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const MAX_PENDING = 100;
const SORTS = ["relevance", "price_asc", "price_desc", "moq_asc", "fastest_delivery"];

const page = (q, def, max) => ({
    limit: Math.min(Math.max(parseInt(q.limit, 10) || def, 1), max),
    offset: Math.max(parseInt(q.offset, 10) || 0, 0),
});
const sortOf = (v) => (SORTS.includes(v) ? v : "relevance");
const text = (v, n = 100) => String(v || "").trim().slice(0, n);

/* ───────────── Buyers + RFQ ───────────── */

function phone10(raw) {
    const d = String(raw || "").replace(/\D/g, "");
    const t = d.length > 10 ? d.slice(-10) : d;
    return /^[6-9]\d{9}$/.test(t) ? t : null;
}

async function findBuyer(rawPhone) {
    const p = phone10(rawPhone);
    if (!p) throw fail(400, "INVALID_PHONE", "Provide a valid 10-digit Indian mobile number.");
    const { data, error } = await supabaseAdmin
        .from("profiles").select("id, name")
        .in("phone", [p, `91${p}`, `+91${p}`])
        .eq("phone_verified", true).eq("role", "user").eq("onboarding_step", "done")
        .is("deleted_at", null).limit(1);
    if (error) throw error;
    return data?.[0] || null;
}

async function requireBuyer(rawPhone) {
    const buyer = await findBuyer(rawPhone);
    if (!buyer) throw fail(404, "BUYER_NOT_FOUND", "No registered buyer account found for this mobile number.");
    return buyer;
}

export async function lookupBuyer(req, res) {
    const buyer = await findBuyer(req.query.phone);
    if (!buyer) return res.json({ success: true, found: false });
    const { data: bp } = await supabaseAdmin
        .from("business_profiles").select("display_name, district, state").eq("user_id", buyer.id).maybeSingle();
    res.json({
        success: true, found: true,
        buyer: { name: buyer.name || null, businessName: bp?.display_name || null, city: bp?.district || null, state: bp?.state || null },
    });
}

// One final quantity: if a pack size is sent, fold it into the total and store pack size 1.
function toTotalQuantity(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const packKey = "packSize" in raw ? "packSize" : "pack_size" in raw ? "pack_size" : null;
    if (!packKey) return raw;
    const q = Number(raw.quantity), p = Number(raw[packKey]);
    if (!Number.isFinite(q) || !Number.isFinite(p) || !(q > 0) || !(p > 0) || p === 1) return raw;
    return { ...raw, quantity: Math.round(q * p * 1e6) / 1e6, [packKey]: 1 };
}

// Buyer-facing shape only: no sales-workflow fields.
function rfqOut(dto) {
    const {
        customerName, customerGstin, customerPhone, customerEmail,
        salespersonName, lastActivityAt, isMine, ...rest
    } = dto;
    return rest;
}

export async function createRfq(req, res) {
    const { buyerPhone, ...rest } = req.body || {};
    const buyer = await requireBuyer(buyerPhone);

    const v = sanitizeEnquiry(toTotalQuantity(rest));
    if (!v.ok) throw fail(400, "VALIDATION_FAILED", v.message);

    const { count, error: cErr } = await supabaseAdmin
        .from("rfq_enquiries").select("id", { count: "exact", head: true })
        .eq("buyer_id", buyer.id).eq("status", "pending_review");
    if (cErr) throw cErr;
    if ((count || 0) >= MAX_PENDING) {
        throw fail(429, "TOO_MANY_PENDING", "This buyer has too many enquiries waiting for review.");
    }

    const { data, error } = await supabaseAdmin
        .from("rfq_enquiries")
        .insert({ ...v.row, buyer_id: buyer.id, status: "pending_review" })
        .select("*").single();
    if (error) throw error;

    notifyAdminsNewRfq({ count: 1, name: data.product_name });
    res.status(201).json({
        success: true,
        enquiry: rfqOut(toDto(data, { owner: true })),
        message: "Enquiry submitted for review.",
    });
}

export async function listRfq(req, res) {
    const buyer = await requireBuyer(req.query.buyerPhone);
    const { limit, offset } = page(req.query, 12, 30);

    let q = supabaseAdmin.from("rfq_enquiries").select("*", { count: "exact" })
        .eq("buyer_id", buyer.id).order("created_at", { ascending: false });
    if (req.query.status) {
        if (!RFQ_STATUSES.includes(req.query.status)) throw fail(400, "INVALID_PARAMETER", "Invalid status.");
        q = q.eq("status", req.query.status);
    }
    const { data, count, error } = await q.range(offset, offset + limit - 1);
    if (error) throw error;

    const rows = data || [];
    let items = rows.map((row) => ({ ...toDto(row, { owner: true }), isMine: true }));
    try { items = await attachQuotes(items, rows, buyer.id, []); }
    catch (e) { console.error("[api] attachQuotes failed:", e.message); }

    res.json({ success: true, items: items.map(rfqOut), total: count ?? items.length, hasMore: offset + items.length < (count ?? 0) });
}

export async function getRfq(req, res) {
    const buyer = await requireBuyer(req.query.buyerPhone);
    if (!isUuid(req.params.id)) throw fail(404, "NOT_FOUND", "Enquiry not found.");
    const { data, error } = await supabaseAdmin
        .from("rfq_enquiries").select("*").eq("id", req.params.id).eq("buyer_id", buyer.id).maybeSingle();
    if (error) throw error;
    if (!data) throw fail(404, "NOT_FOUND", "Enquiry not found.");

    let enquiry = { ...toDto(data, { owner: true }), isMine: true };
    try { [enquiry] = await attachQuotes([enquiry], [data], buyer.id, []); }
    catch (e) { console.error("[api] attachQuotes failed:", e.message); }
    res.json({ success: true, enquiry: rfqOut(enquiry) });
}

/* ───────────── Orders ───────────── */

const ORDER_SELECT = `
    id, order_number, status, order_type, subtotal_amount, total_amount, payment_status, payment_method,
    created_at, updated_at, delivered_at,
    seller:seller_profiles ( display_name, city, state ),
    items:order_items ( product_name_snapshot, brand_name_snapshot, unit_price, unit, quantity, purchase_basis, line_total )`;

const orderDto = (o) => ({
    id: o.id,
    orderNumber: o.order_number,
    status: o.status,
    orderType: o.order_type,
    paymentStatus: o.payment_status,
    paymentMethod: o.payment_method,
    subtotal: o.subtotal_amount != null ? Number(o.subtotal_amount) : null,
    total: o.total_amount != null ? Number(o.total_amount) : null,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    deliveredAt: o.delivered_at || null,
    seller: { name: o.seller?.display_name || null, city: o.seller?.city || null, state: o.seller?.state || null },
    items: (o.items || []).map((i) => ({
        productName: i.product_name_snapshot,
        brandName: i.brand_name_snapshot || null,
        unitPrice: i.unit_price != null ? Number(i.unit_price) : null,
        unit: i.unit,
        quantity: i.quantity != null ? Number(i.quantity) : null,
        purchaseBasis: i.purchase_basis,
        lineTotal: i.line_total != null ? Number(i.line_total) : null,
    })),
});

export async function listOrders(req, res) {
    const buyer = await requireBuyer(req.query.buyerPhone);
    const { limit, offset } = page(req.query, 20, 50);

    let q = supabaseAdmin.from("orders").select(ORDER_SELECT, { count: "exact" })
        .eq("buyer_id", buyer.id).order("created_at", { ascending: false });
    if (req.query.status) q = q.eq("status", text(req.query.status, 40));
    if (req.query.updatedSince) {
        const t = new Date(String(req.query.updatedSince));
        if (Number.isNaN(t.getTime())) throw fail(400, "INVALID_PARAMETER", "updatedSince must be an ISO date-time.");
        q = q.gte("updated_at", t.toISOString());
    }
    const { data, count, error } = await q.range(offset, offset + limit - 1);
    if (error) throw error;

    const items = (data || []).map(orderDto);
    res.json({ success: true, items, total: count ?? items.length, hasMore: offset + items.length < (count ?? 0) });
}

export async function getOrder(req, res) {
    const buyer = await requireBuyer(req.query.buyerPhone);
    if (!isUuid(req.params.id)) throw fail(404, "NOT_FOUND", "Order not found.");
    const { data, error } = await supabaseAdmin.from("orders").select(ORDER_SELECT)
        .eq("id", req.params.id).eq("buyer_id", buyer.id).maybeSingle();
    if (error) throw error;
    if (!data) throw fail(404, "NOT_FOUND", "Order not found.");
    res.json({ success: true, order: orderDto(data) });
}

/* ───────────── Catalog ───────────── */

export async function listCategories(req, res) {
    const { limit, offset } = page(req.query, 100, 200);
    const { data, count, error } = await supabaseAdmin
        .from("hs_categories").select("id, name, slug, image", { count: "exact" })
        .eq("review_status", "approved").is("deleted_at", null)
        .order("name").range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ success: true, total: count ?? data.length, items: data, hasMore: offset + data.length < (count ?? 0) });
}

export async function listSubcategories(req, res) {
    const { limit, offset } = page(req.query, 100, 200);
    let q = supabaseAdmin
        .from("hs_subcategories").select("id, category_id, name, slug, image", { count: "exact" })
        .eq("review_status", "approved").is("deleted_at", null)
        .order("name").range(offset, offset + limit - 1);
    if (req.query.categoryId) {
        if (!isUuid(req.query.categoryId)) throw fail(400, "INVALID_PARAMETER", "categoryId is invalid.");
        q = q.eq("category_id", req.query.categoryId);
    }
    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ success: true, total: count ?? data.length, items: data, hasMore: offset + data.length < (count ?? 0) });
}

export async function listProducts(req, res) {
    const { limit, offset } = page(req.query, 24, 60);
    const categoryId = text(req.query.categoryId);
    if (categoryId && !isUuid(categoryId)) throw fail(400, "INVALID_PARAMETER", "categoryId is invalid.");

    const { data, error } = await supabaseAdmin.rpc("catalog_browse_feed", {
        p_category_id: categoryId || null,
        p_q: text(req.query.q),
        p_sort: sortOf(req.query.sort),
        p_limit: limit,
        p_offset: offset,
        p_seller_id: null,
        p_buyer_id: null,
        p_followed_only: false,
        p_shop_slug: null,
        p_dest_pincode: text(req.query.destPincode, 6) || null,
        p_dest_state: text(req.query.destState) || null,
        p_group_threshold: 0, // flat list of products, no grouped cards
        p_generic_product_id: null,
    });
    if (error) throw error;

    const items = (data?.items || []).map(({ has_own_listing, price_trend, ...row }) => row);
    res.json({ success: true, ...data, items });
}

export async function getProduct(req, res) {
    if (!isUuid(req.params.id)) throw fail(404, "NOT_FOUND", "Product not found.");
    const { data, error } = await supabaseAdmin.rpc("catalog_brand_item_detail", {
        p_brand_item_id: req.params.id, p_buyer_id: null,
    });
    if (error) throw error;
    if (!data) throw fail(404, "NOT_FOUND", "Product not found.");
    res.json({ success: true, item: data });
}

export async function getProductSellers(req, res) {
    if (!isUuid(req.params.id)) throw fail(404, "NOT_FOUND", "Product not found.");
    const { limit, offset } = page(req.query, 24, 60);
    const { data, error } = await supabaseAdmin.rpc("catalog_brand_item_sellers", {
        p_brand_item_id: req.params.id,
        p_sort: sortOf(req.query.sort),
        p_limit: limit,
        p_offset: offset,
        p_buyer_id: null,
        p_dest_pincode: text(req.query.destPincode, 6) || null,
        p_dest_state: text(req.query.destState) || null,
        p_own_seller_id: null,
    });
    if (error) throw error;
    res.json({ success: true, ...data });
}

export async function listSellers(req, res) {
    const { limit, offset } = page(req.query, 48, 60);
    const { data, error } = await supabaseAdmin.rpc("catalog_sellers_page", {
        p_q: text(req.query.q), p_limit: limit, p_offset: offset, p_seller_id: null, p_buyer_id: null,
    });
    if (error) throw error;
    res.json({ success: true, ...data });
}

export async function listBrands(req, res) {
    const { limit, offset } = page(req.query, 24, 60);
    const { data, error } = await supabaseAdmin.rpc("catalog_brands_page", {
        p_q: text(req.query.q), p_limit: limit, p_offset: offset,
    });
    if (error) throw error;
    res.json({ success: true, ...data });
}

/* ───────────── Pages ───────────── */

export async function listSlugs(req, res) {
    const { limit, offset } = page(req.query, 500, 1000);
    const { xml, stats } = await getSitemap();
    const all = [];
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const url = m[1].replace(/&amp;/g, "&");
        try { all.push({ slug: normalizeSlug(new URL(url).pathname), url }); } catch { /* skip malformed */ }
    }
    const items = all.slice(offset, offset + limit);
    res.json({
        success: true, total: all.length, items,
        hasMore: offset + items.length < all.length, generated_at: stats?.generated_at || null,
    });
}

export async function getPageContent(req, res) {
    if (!req.query.slug) throw fail(400, "INVALID_PARAMETER", "slug is required.");
    res.json({ success: true, ...(await getSsrMeta(normalizeSlug(req.query.slug))) });
}