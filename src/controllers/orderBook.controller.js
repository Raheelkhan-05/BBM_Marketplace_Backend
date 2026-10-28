// controllers/orderBook.controller.js
// ORDER BOOK: a standalone CRM log. A salesperson punches an order taken for a customer; the company's team
// (admin / members) then moves it  placed -> processed -> shipped (LR + bill) -> completed.
// It never touches the marketplace orders, wallet, stock or pricing. Prices here are for the log only.
// Catalog products are ordered in whole packs or master packs (never single units).
// The customer must have a mobile number or an email, and the buyer address is filled from the GST number (editable).
// When an order is marked processed, the customer is thanked by email / WhatsApp on behalf of the company.
import multer from "multer";
import { supabase, supabaseAdmin } from "../config/supabase.js";
import { isUuid, RFQ_UNITS } from "../services/rfqValidation.js";
import { resolveGstin, addOne } from "./sellerCustomers.controller.js";
import { validateGSTIN, fetchGstinDetails } from "../services/gst.service.js";
import { logActivity, getTeamContext } from "../services/team.service.js";
import { pingCustomersChanged } from "../services/salesSync.service.js";
import { notifyUser } from "../services/realtimeBroadcast.js";
import { getSalesActor, str, safeSearch, cleanGstin, cleanPhone, cleanEmail, round2, GSTIN_RE } from "../services/salesThreads.service.js";
import { BUCKET, STATUSES, LIST_COLS, orderDto, eventDto, signDocs, broadcast } from "../services/orderBook.service.js";
import { notifyOrderProcessed } from "../services/orderBookNotify.service.js";
import { productDetails } from "../services/orderBookProduct.service.js";

const MAX_LINES = 20;
const NO_SELLER = "Your company's seller account isn't approved yet, so products can't be added.";
const NO_CONTACT = "Add the customer's mobile number or email (at least one) so they can receive their order updates.";
const SUB_SELECT = "*, hs_generic_product_brands!inner(id, name, brand_name, image, images, description, manufacturer, model_no, specifications, deleted_at)";
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "pdf", "doc", "docx", "xls", "xlsx", "csv", "txt"]);
const PINCODE_RE = /^\d{6}$/;
const round4 = (x) => Math.round(x * 1e4) / 1e4;

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const oops = (res, e) => { console.error("[order book]", e?.message || e); return fail(res, 500, "Something went wrong. Please try again."); };
const flatSub = ({ hs_generic_product_brands, ...rest }) => ({ ...rest, brand: hs_generic_product_brands || null });

/* ------------------------------ who is calling ------------------------------ */
function salesScope(req) {
    const a = getSalesActor(req);
    return { companyId: a.ownerId, sellerId: a.sellerId, actorId: a.actorId, actorName: a.actorName, salespersonId: a.actorId, teamId: req.sales?.teamId || null };
}
function teamScope(req) {
    const actorId = req.actor?.id || req.user.id;
    return {
        companyId: req.user.id, sellerId: req.sellerId, actorId,
        actorName: String(req.actor?.name || req.user?.name || "Team member").trim().slice(0, 120),
        salespersonId: null, teamId: req.obTeam?.teamId || null,
    };
}

// After requireAuth + requireApprovedSeller: keeps salespeople out of the team-side endpoints.
export async function requireOrderBookTeam(req, res, next) {
    try {
        const ctx = await getTeamContext(req.actor?.id || req.user.id);
        if (ctx.isMember && ctx.role === "salesperson") return fail(res, 403, "Not available for salespeople.");
        req.obTeam = ctx;
        next();
    } catch (e) { oops(res, e); }
}

/* ------------------------------ customer helpers (same rules as enquiries) ------------------------------ */
async function canonicalCustomerName({ sellerId, companyId, gstin }) {
    if (!gstin || !GSTIN_RE.test(gstin)) return "";
    try {
        if (sellerId) {
            const { data } = await supabase.from("seller_customers").select("business_name")
                .eq("seller_id", sellerId).eq("gstin", gstin).limit(1).maybeSingle();
            if (data?.business_name) return String(data.business_name).slice(0, 160);
        }
        const r = await resolveGstin(gstin, companyId);
        if ((r?.state === "registered" || r?.state === "unregistered") && r.name) return String(r.name).slice(0, 160);
    } catch (e) { console.error("[order book] gst lookup failed:", e?.message || e); }
    return "";
}

// Adds the customer to the salesperson's customer list (once). Never fails the order.
async function ensureCustomer({ s, gstin, phone, email }) {
    if (!gstin) return;
    try {
        const out = await addOne(s.sellerId, s.companyId, gstin, "gst", {
            assigned_to: s.actorId, assigned_by: s.actorId, assigned_kind: "self", assigned_at: new Date().toISOString(),
            contact_name: null, contact_phone: phone || null, contact_email: email || null,
        });
        if (out?.result === "added" || out?.result === "saved") {
            Promise.resolve(pingCustomersChanged(s.companyId, [s.actorId])).catch(() => { /* best effort */ });
        }
    } catch (e) { console.error("[order book] add customer failed:", e?.message || e); }
}

// POST /api/sales/gst-address { gstin } -> { name, address, city, state, pincode }
// Registered BBM buyers: their saved business profile first. Otherwise (or if it has no address) the GST provider
// (fetchGstinDetails has a short cache, so repeat lookups don't cost another credit).
export async function gstAddress(req, res) {
    try {
        const v = validateGSTIN(req.body?.gstin);
        if (!v.valid) return fail(res, 400, v.reason || "Enter a valid GST number.");
        const gstin = v.gstin;
        let name = "", address = "", city = "", state = "", pincode = "";

        try {
            const { data, error } = await supabaseAdmin.from("business_profiles")
                .select("legal_name, trade_name, display_name, registered_address, district, state, pincode")
                .eq("gstin", gstin).limit(1);
            if (error) throw error;
            const bp = data?.[0];
            if (bp) {
                name = (bp.display_name || bp.trade_name || bp.legal_name || "").trim();
                address = (bp.registered_address || "").trim();
                city = (bp.district || "").trim();
                state = (bp.state || "").trim();
                pincode = (bp.pincode || "").trim();
            }
        } catch (e) { console.error("[order book] profile address lookup failed:", e?.message || e); }

        if (!address) {
            const g = await fetchGstinDetails(gstin);
            const m = g?.mapped;
            if (m) {
                name = name || (m.trade_name || m.legal_name || "").trim();
                address = (m.registered_address || "").trim();
                city = city || (m.district || "").trim();
                state = state || (m.state || "").trim();
                pincode = pincode || (m.pincode || "").trim();
            }
        }
        res.json({ success: true, found: !!(name || address), gstin, name, address, city, state, pincode });
    } catch (e) { oops(res, e); }
}

/* ------------------------------ lines ------------------------------ */
// Catalog product: sold in whole packs or master packs. The pack sizes come from the listing in the database, never from
// the browser. Typed-name product (no pack data): quantity + unit, as before.
//   unit      "Pack" | "Master Pack" (catalog)  or the typed unit (manual)
//   quantity  number of packs / master packs     unitPrice  per pack / master pack (GST included)
//   baseUnit, unitsPerSaleUnit, totalUnits, perUnitPrice  (catalog only) the same line in the listing's own unit
async function buildItems(raw, sellerId) {
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_LINES) return { status: 400, error: `Add between 1 and ${MAX_LINES} products.` };
    const ids = raw.map((i) => i?.productSubmissionId).filter(Boolean);
    if (ids.some((id) => !isUuid(id)) || new Set(ids).size !== ids.length) return { status: 400, error: "The product list is invalid." };

    const byId = new Map();
    if (ids.length) {
        const { data, error } = await supabase.from("seller_product_submissions").select(SUB_SELECT)
            .eq("seller_id", sellerId).in("id", ids).neq("review_status", "rejected")
            .is("hs_generic_product_brands.deleted_at", null);
        if (error) throw error;
        (data || []).forEach((r) => { const s = flatSub(r); byId.set(s.id, s); });
    }

    const items = [];
    for (const r of raw) {
        let sub = null;
        if (r.productSubmissionId) {
            sub = byId.get(r.productSubmissionId);
            if (!sub) return { status: 404, error: "One of the products isn't in your company's catalog." };
        }
        const name = sub ? (sub.brand?.name || sub.product_name) : str(r.productName, 200);
        if (name.length < 2) return { status: 400, error: "Enter the product name." };
        const quantity = Number(r.quantity), unitPrice = Number(r.unitPrice);
        if (!(quantity > 0) || quantity > 1e9) return { status: 400, error: `Enter a valid quantity for ${name}.` };
        if (!(unitPrice > 0) || unitPrice > 1e8) return { status: 400, error: `Enter a valid price for ${name}.` };

        if (!sub) {
            const unit = r.unit;
            if (!RFQ_UNITS.includes(unit)) return { status: 400, error: `Select a unit for ${name}.` };
            const q = Math.round(quantity * 1e4) / 1e4;
            items.push({
                submissionId: null, productName: name, brandName: "", image: null,
                unit, quantity: q, unitPrice: round4(unitPrice), lineTotal: round2(q * unitPrice), details: null,
            });
            continue;
        }

        const pack = Number(sub.pack_size) > 0 ? Number(sub.pack_size) : 1;
        const per = Number(sub.units_per_master_pack) > 1 ? Number(sub.units_per_master_pack) : 0;
        const basis = r.basis === "per_pack" || r.basis === "per_master_pack" ? r.basis : (per ? "per_master_pack" : "per_pack");
        if (basis === "per_master_pack" && !per) return { status: 400, error: `${name} isn't sold in master packs. Choose packs.` };
        const word = basis === "per_master_pack" ? "master packs" : "packs";
        if (!Number.isInteger(quantity)) return { status: 400, error: `Enter a whole number of ${word} for ${name}.` };

        const unitsPerSaleUnit = basis === "per_master_pack" ? pack * per : pack;
        items.push({
            submissionId: sub.id, productName: name,
            brandName: sub.brand?.brand_name || sub.brand_name || "",
            image: sub.image || sub.brand?.image || null,
            basis, unit: basis === "per_master_pack" ? "Master Pack" : "Pack",
            quantity, unitPrice: round4(unitPrice), lineTotal: round2(quantity * unitPrice),
            baseUnit: sub.unit || "", unitsPerSaleUnit: round4(unitsPerSaleUnit),
            totalUnits: round4(quantity * unitsPerSaleUnit), perUnitPrice: round4(unitPrice / unitsPerSaleUnit),
            details: productDetails(sub),   // snapshot: pack sizes, HSN, specs, documents
        });
    }
    return { items };
}

/* ------------------------------ shared reads ------------------------------ */
function countsOf(rows) {
    const c = { all: 0, placed: 0, processed: 0, shipped: 0, completed: 0, cancelled: 0 };
    for (const r of rows || []) { c[r.status] = Number(r.n) || 0; c.all += Number(r.n) || 0; }
    return c;
}

async function listFor(req, res, scope) {
    try {
        res.set("Cache-Control", "no-store");
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const q = safeSearch(req.query.q);
        const status = STATUSES.includes(req.query.status) ? req.query.status : "";

        let query = supabase.from("order_book_orders").select(LIST_COLS, { count: "exact" }).eq("company_id", scope.companyId);
        if (scope.salespersonId) query = query.eq("salesperson_id", scope.salespersonId);
        if (status) query = query.eq("status", status);
        if (q) query = query.or(`customer_name.ilike.%${q}%,order_no.ilike.%${q}%,customer_gstin.ilike.%${q}%`);
        query = query.order("last_activity_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + limit - 1);

        const first = offset === 0;
        const [list, cnt] = await Promise.all([
            query,
            first ? supabase.rpc("order_book_counts", { p_company: scope.companyId, p_salesperson: scope.salespersonId || null }) : null,
        ]);
        if (list.error) throw list.error;
        if (cnt?.error) throw cnt.error;

        const items = (list.data || []).map((r) => orderDto(r));
        const body = { success: true, items, total: list.count ?? items.length, hasMore: offset + items.length < (list.count ?? 0) };
        if (first) body.counts = countsOf(cnt.data);
        res.json(body);
    } catch (e) { oops(res, e); }
}

async function detailFor(req, res, scope) {
    try {
        res.set("Cache-Control", "no-store");
        const { id } = req.params;
        if (!isUuid(id)) return fail(res, 404, "Order not found.");
        let q = supabase.from("order_book_orders").select("*").eq("id", id).eq("company_id", scope.companyId);
        if (scope.salespersonId) q = q.eq("salesperson_id", scope.salespersonId);
        const { data: row, error } = await q.maybeSingle();
        if (error) throw error;
        if (!row) return fail(res, 404, "Order not found.");
        const [ev, docs] = await Promise.all([
            supabase.from("order_book_events").select("*").eq("order_id", row.id).order("created_at", { ascending: true }).limit(200),
            signDocs(row),
        ]);
        if (ev.error) throw ev.error;
        res.json({ success: true, order: orderDto(row, docs), events: (ev.data || []).map(eventDto) });
    } catch (e) { oops(res, e); }
}

/* ------------------------------ salesperson ------------------------------ */
export const listMine = (req, res) => listFor(req, res, salesScope(req));
export const getMine = (req, res) => detailFor(req, res, salesScope(req));

// POST /api/sales/order-book
// { customerGstin?, customerName?, customerPhone?, customerEmail?, customerAddress?, customerCity?, customerState?, customerPincode?,
//   items:[{productSubmissionId, basis:"per_pack"|"per_master_pack", quantity, unitPrice} | {productName, unit, quantity, unitPrice}], notes? }
// The customer needs at least a mobile number or an email, so they can be told when the order is processed.
export async function createOrder(req, res) {
    try {
        const s = salesScope(req);
        if (!s.sellerId) return fail(res, 409, NO_SELLER);
        const b = req.body || {};

        let customerName = str(b.customerName, 160);
        const gstin = cleanGstin(b.customerGstin);
        if (gstin && !GSTIN_RE.test(gstin)) return fail(res, 400, "Enter a valid 15-character GST number, or leave it empty.");
        if (!customerName && !gstin) return fail(res, 400, "Enter the customer's GST number or company name.");
        const phoneRaw = str(b.customerPhone, 20), emailRaw = str(b.customerEmail, 200);
        const phone = phoneRaw ? cleanPhone(phoneRaw) : "", email = emailRaw ? cleanEmail(emailRaw) : "";
        if (phoneRaw && !phone) return fail(res, 400, "Enter a valid 10-digit mobile number.");
        if (emailRaw && !email) return fail(res, 400, "Enter a valid email address.");
        if (!phone && !email) return fail(res, 400, NO_CONTACT);

        const address = str(b.customerAddress, 400), city = str(b.customerCity, 80), stateName = str(b.customerState, 60);
        const pincode = str(b.customerPincode, 10).replace(/\s/g, "");
        if (pincode && !PINCODE_RE.test(pincode)) return fail(res, 400, "Enter a valid 6-digit pincode, or leave it empty.");

        const built = await buildItems(b.items, s.sellerId);
        if (built.error) return fail(res, built.status, built.error);
        const items = built.items;
        const total = round2(items.reduce((a, i) => a + i.lineTotal, 0));

        if (gstin) {
            const official = await canonicalCustomerName({ sellerId: s.sellerId, companyId: s.companyId, gstin });
            if (official) customerName = official;
        }
        if (!customerName) customerName = `GSTIN ${gstin}`;

        const now = new Date().toISOString();
        const { data: row, error } = await supabase.from("order_book_orders").insert({
            company_id: s.companyId, seller_id: s.sellerId, salesperson_id: s.actorId, salesperson_name: s.actorName,
            customer_name: customerName, customer_gstin: gstin || null, customer_phone: phone || null, customer_email: email || null,
            customer_address: address || null, customer_city: city || null, customer_state: stateName || null, customer_pincode: pincode || null,
            items, total_amount: total, notes: str(b.notes, 1000) || null,
            status: "placed", last_activity_at: now, updated_at: now,
        }).select("*").single();
        if (error) throw error;

        await supabase.from("order_book_events").insert({
            order_id: row.id, actor_id: s.actorId, actor_name: s.actorName, kind: "created",
            body: `Order punched by ${s.actorName}`,
        });
        ensureCustomer({ s, gstin, phone, email });

        try {
            await logActivity({
                teamId: s.teamId, actorId: s.actorId, actorRole: "member", category: "sales", action: "order_book.placed",
                label: `Punched order ${row.order_no} for ${customerName}`, entityType: "order_book", entityId: row.id,
                meta: { link: `/grow/order-book/${row.id}`, total },
            });
        } catch { /* best effort */ }

        broadcast({ companyId: s.companyId, salespersonId: s.actorId, payload: { kind: "created", orderId: row.id, orderNo: row.order_no, customer: customerName, status: "placed" } });
        notifyUser(s.companyId, {
            type: "order_book_new", title: `New order ${row.order_no}`,
            body: `${s.actorName} punched an order for ${customerName}.`, link: `/grow/order-book/${row.id}`,
        }).catch(() => { /* best effort */ });

        res.json({ success: true, order: orderDto(row), message: "Order punched." });
    } catch (e) { oops(res, e); }
}

/* ------------------------------ team (admin / members) ------------------------------ */
export const listTeam = (req, res) => listFor(req, res, teamScope(req));
export const getTeam = (req, res) => detailFor(req, res, teamScope(req));

export async function countsTeam(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const { data, error } = await supabase.rpc("order_book_counts", { p_company: req.user.id, p_salesperson: null });
        if (error) throw error;
        res.json({ success: true, counts: countsOf(data) });
    } catch (e) { oops(res, e); }
}

async function loadTeamRow(req, res) {
    const { id } = req.params;
    if (!isUuid(id)) { fail(res, 404, "Order not found."); return null; }
    const { data, error } = await supabase.from("order_book_orders").select("*").eq("id", id).eq("company_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!data) { fail(res, 404, "Order not found."); return null; }
    return data;
}

const VERB = { processed: "Marked as processed", shipped: "Marked as shipped", completed: "Completed", cancelled: "Cancelled" };
const NOTE = { processed: "is now being processed", shipped: "has been shipped", completed: "is completed", cancelled: "was cancelled" };

// One guarded step. The UPDATE only matches while the order is still in `row.status`,
// so two people clicking at once can never double-apply or skip a step.
async function move(req, res, row, to, { patch = {}, eventBody }) {
    const t = teamScope(req);
    const now = new Date().toISOString();
    const { data, error } = await supabase.from("order_book_orders")
        .update({ status: to, updated_at: now, last_activity_at: now, [`${to === "processed" ? "processed" : to}_at`]: now, ...patch })
        .eq("id", row.id).eq("company_id", t.companyId).eq("status", row.status).select("*").maybeSingle();
    if (error) throw error;
    if (!data) { fail(res, 409, "Someone just updated this order. Refresh to see the latest status."); return false; }

    await supabase.from("order_book_events").insert({ order_id: row.id, actor_id: t.actorId, actor_name: t.actorName, kind: to, body: eventBody });
    try {
        await logActivity({
            teamId: t.teamId, actorId: t.actorId, actorRole: req.obTeam?.role || "member", category: "sales", action: `order_book.${to}`,
            label: `${VERB[to]} order ${row.order_no}`, entityType: "order_book", entityId: row.id, meta: { link: `/grow/order-book/${row.id}` },
        });
    } catch { /* best effort */ }

    broadcast({ companyId: t.companyId, salespersonId: row.salesperson_id, payload: { kind: to, orderId: row.id, orderNo: row.order_no, customer: row.customer_name, status: to } });
    notifyUser(row.salesperson_id, {
        type: "order_book_update", title: `Order ${row.order_no} ${to}`,
        body: `${row.customer_name}: the order ${NOTE[to]}.`, link: `/sales/order-book/${row.id}`,
    }).catch(() => { /* best effort */ });

    res.json({ success: true, order: orderDto(data) });
    return true;
}

export async function processOrder(req, res) {
    try {
        const row = await loadTeamRow(req, res); if (!row) return;
        if (row.status !== "placed") return fail(res, 409, "Only a placed order can be marked as processed.");
        const ok = await move(req, res, row, "processed", { eventBody: "Order marked as processed" });
        // Thank the customer by email / WhatsApp. Runs after the response, so it never slows or breaks the step.
        // The guarded UPDATE in move() means this fires once per order.
        if (ok) notifyOrderProcessed(row).catch((e) => console.error("[order book] customer notify failed:", e?.message || e));
    } catch (e) { oops(res, e); }
}

export async function completeOrder(req, res) {
    try {
        const row = await loadTeamRow(req, res); if (!row) return;
        if (row.status !== "shipped") return fail(res, 409, "Ship the order before completing it.");
        await move(req, res, row, "completed", { eventBody: "Order completed" });
    } catch (e) { oops(res, e); }
}

export async function cancelOrder(req, res) {
    try {
        const row = await loadTeamRow(req, res); if (!row) return;
        if (!["placed", "processed"].includes(row.status)) return fail(res, 409, "A shipped order can't be cancelled.");
        const reason = str(req.body?.reason, 300);
        await move(req, res, row, "cancelled", {
            patch: { cancel_reason: reason || null },
            eventBody: reason ? `Order cancelled: ${reason}` : "Order cancelled",
        });
    } catch (e) { oops(res, e); }
}

// POST /api/seller/order-book/:id/ship   multipart: lrNumber, lrNotes, lr_proof, bill
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2 } });
const parseShip = upload.fields([{ name: "lr_proof", maxCount: 1 }, { name: "bill", maxCount: 1 }]);
export const shipUpload = (req, res, next) => parseShip(req, res, (err) => (err
    ? fail(res, 400, err.code === "LIMIT_FILE_SIZE" ? "Files can be up to 10 MB." : "Couldn't read the uploaded files.")
    : next()));

const extOf = (f) => (String(f.originalname || "").split(".").pop() || "").toLowerCase();

export async function shipOrder(req, res) {
    const uploaded = [];
    try {
        const lrNumber = str(req.body?.lrNumber, 60), lrNotes = str(req.body?.lrNotes, 500);
        const lrFile = req.files?.lr_proof?.[0], billFile = req.files?.bill?.[0];
        if (!lrNumber) return fail(res, 400, "Enter the LR / tracking number.");
        if (!lrFile) return fail(res, 400, "Attach the LR document.");
        if (!billFile) return fail(res, 400, "Attach the bill.");
        if (!ALLOWED_EXT.has(extOf(lrFile)) || !ALLOWED_EXT.has(extOf(billFile))) return fail(res, 400, "This file type isn't supported. Use a photo, PDF, Word, Excel, CSV or text file.");

        const row = await loadTeamRow(req, res); if (!row) return;
        if (row.status !== "processed") return fail(res, 409, "Mark the order as processed before shipping it.");

        const put = async (file, kind) => {
            const path = `ob/${row.id}/${kind}-${Date.now()}.${extOf(file)}`;
            const { error } = await supabase.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
            if (error) throw error;
            uploaded.push(path);
            return path;
        };
        const lrPath = await put(lrFile, "lr");
        const billPath = await put(billFile, "bill");

        const ok = await move(req, res, row, "shipped", {
            patch: { lr_number: lrNumber, lr_notes: lrNotes || null, lr_proof_path: lrPath, bill_path: billPath },
            eventBody: `Order shipped · LR ${lrNumber}`,
        });
        if (!ok && uploaded.length) supabase.storage.from(BUCKET).remove(uploaded).catch(() => { /* best effort */ });
    } catch (e) {
        if (uploaded.length) supabase.storage.from(BUCKET).remove(uploaded).catch(() => { /* best effort */ });
        oops(res, e);
    }
}