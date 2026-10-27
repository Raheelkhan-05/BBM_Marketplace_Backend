// controllers/salesThreads.controller.js
// A salesperson's private enquiry threads: create, log notes + files, send quotations (WhatsApp / email).
// Every query is scoped to the CALLING salesperson, so other salespeople of the same team never see a thread.
//
// Speed notes:
//  - Reads go through cache.service (Redis if REDIS_URL is set, else memory). Writers call notify(), which bumps
//    version stamps, so cached data is never stale after a change.
//  - getThread pages entries with a (created_at, id) cursor: newest page first, `before` for older pages,
//    `after` for a tiny "what's new" refresh (used by the live poll / socket).
//
// Outcomes: an enquiry is "open" (db status approved) or closed with sales_outcome "won" | "lost".
// Product: an enquiry may be created with a product tagged from the company catalog (product_submission_id);
// it is set once at creation and never editable afterwards.
import { randomUUID } from "node:crypto";
import { supabase } from "../config/supabase.js";
import { isUuid, RFQ_UNITS } from "../services/rfqValidation.js";
import { sameUnit } from "../services/rfqQuotes.service.js";
import { sendSalesQuotationWhatsApp } from "../services/whatsapp.service.js";
import { sendSalesQuotationEmail } from "../services/mail.service.js";
import { logActivity } from "../services/team.service.js";
import { pingCustomersChanged } from "../services/salesSync.service.js";
import { cached, getVer, bumpVer, hashKey } from "../services/cache.service.js";
import { resolveGstin, addOne } from "./sellerCustomers.controller.js";
import {
    BUCKET, GSTIN_RE, getSalesActor, str, safeSearch, cleanGstin, cleanPhone, cleanEmail, round4,
    saleUnits, priceLine, listingProblem, listingDescription, productUrl, clipPreview, ping,
    threadDto, entryDto, quoteDto, hydrateEntries, inr, fmtDate, whatsappItemsLine,
} from "../services/salesThreads.service.js";
import {
    findBuyerCompanyByGstin, fetchBuyerOverrides, customUnitPriceOf, syncQuoteCustomPrices,
} from "../services/salesQuotePricing.service.js";

const ENTRY_PAGE = 20;          // default entries per page (newest first)
const ENTRY_PAGE_MAX = 50;
const AFTER_MAX = 100;          // more new entries than this -> tell the client to reload instead
const MAX_FILES = 10;
const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "ppt", "pptx"]);
// Quotations never expire for now. Stored as a far-future date so the existing expiry checks keep working.
const NO_EXPIRY = "9999-12-31T23:59:59.000Z";
const validText = (iso) => (new Date(iso).getUTCFullYear() >= 9000 ? "further notice" : fmtDate(iso));
const VALIDITY = [1, 3, 7, 15, 30];
const CHANNELS = ["whatsapp", "email"];
const TS_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}(:?\d{2})?)$/;
const STATUS_FILTERS = ["open", "won", "lost", "reminder"];
const REMINDER_MAX_MS = 366 * 24 * 60 * 60 * 1000;
const REMINDER_TZ = "Asia/Kolkata";   // only used for the wording of the log line; the stored value is a UTC instant
const remText = (iso) => new Date(iso).toLocaleString("en-IN", {
    timeZone: REMINDER_TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
});

const dtoOf = (row, extra) => ({
    ...threadDto(row, extra),
    outcome: row.sales_outcome || null,
    productSubmissionId: row.product_submission_id || null,
    reminderAt: row.reminder_at || null,
});
const SUB_SELECT = "*, hs_generic_product_brands!inner(id, name, brand_name, image, deleted_at)";

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const oops = (res, e) => { console.error("[sales threads]", e?.message || e); return fail(res, 500, "Something went wrong. Please try again."); };
const errText = (e) => String(e?.error?.error?.message || e?.error?.message || e?.message || e || "Failed").slice(0, 200);
const NO_SELLER = "Your company's seller account isn't approved yet, so products can't be quoted.";


const flatSub = ({ hs_generic_product_brands, ...rest }) => ({ ...rest, brand: hs_generic_product_brands || null });

// A change happened: invalidate cached reads (this salesperson's list + this thread) and tell live pages.
async function notify(ownerId, actorId, enquiryId) {
    await bumpVer(`sa:${actorId}`, enquiryId ? `st:${enquiryId}` : null);
    ping([ownerId, actorId], { enquiryId });
}

// The company name as the GST records / our customer list know it (more reliable than what was typed).
async function canonicalCustomerName({ sellerId, ownerId, gstin }) {
    if (!gstin || !GSTIN_RE.test(gstin)) return "";
    try {
        if (sellerId) {
            const { data } = await supabase.from("seller_customers").select("business_name")
                .eq("seller_id", sellerId).eq("gstin", gstin).limit(1).maybeSingle();
            if (data?.business_name) return String(data.business_name).slice(0, 160);
        }
        const r = await resolveGstin(gstin, ownerId);
        if ((r?.state === "registered" || r?.state === "unregistered") && r.name) return String(r.name).slice(0, 160);
    } catch (e) { console.error("[sales threads] gst name lookup failed:", e?.message || e); }
    return "";
}

// Adds the quoted customer to the salesperson's customer list (once). Never fails the quotation.
async function ensureCustomer({ sellerId, companyId, actorId, teamId, thread }) {
    try {
        const out = await addOne(sellerId, companyId, thread.customer_gstin, "gst", {
            assigned_to: actorId, assigned_by: actorId, assigned_kind: "self", assigned_at: new Date().toISOString(),
            contact_name: null, contact_phone: thread.customer_phone || null, contact_email: thread.customer_email || null,
        });
        if (out?.result === "added" || out?.result === "saved") {
            Promise.resolve(pingCustomersChanged(companyId, [actorId])).catch(() => { /* best effort */ });
            try {
                await logActivity({
                    teamId, actorId, actorRole: "member", category: "sales", action: "sales.customer_added",
                    label: `Added customer ${out.name} (from a quotation)`, entityType: "customer", entityId: out.customer?.id,
                    meta: { link: "/grow/customers", gstin: out.gstin },
                });
            } catch { /* best effort */ }
            return { status: "added", name: out.name || "" };
        }
        return { status: out?.result === "exists" ? "exists" : "skipped", name: "" };
    } catch (e) {
        console.error("[sales threads] add customer failed:", e?.message || e);
        return { status: "failed", name: "" };
    }
}

// ---- loading -------------------------------------------------------------------------------------------
async function loadOwnThread(req, res) {
    const { actorId, ownerId } = getSalesActor(req);
    const { id } = req.params;
    if (!isUuid(id)) { fail(res, 404, "Enquiry not found."); return null; }
    const ver = await getVer(`st:${id}`);
    const row = await cached(`sto:${id}:${actorId}:${ver}`, 60, async () => {
        const { data, error } = await supabase.from("rfq_enquiries").select("*")
            .eq("id", id).eq("source", "sales").eq("created_by_actor_id", actorId).eq("buyer_id", ownerId).maybeSingle();
        if (error) throw error;
        return data || null;
    });
    if (!row) { fail(res, 404, "Enquiry not found."); return null; }
    return row;
}

async function touch(enquiryId, preview) {
    await supabase.from("rfq_enquiries")
        .update({ last_activity_at: new Date().toISOString(), last_entry_preview: preview, reminder_at: null })
        .eq("id", enquiryId);
}

// ---- GET /sales/threads?q=&status=open|won|lost&limit=&offset= ------------------------------------------
export async function listThreads(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const { actorId, ownerId } = getSalesActor(req);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const q = safeSearch(req.query.q);
        const status = STATUS_FILTERS.includes(req.query.status) ? req.query.status : "";

        const ver = await getVer(`sa:${actorId}`);
        const body = await cached(`stl:${actorId}:${ver}:${hashKey([q, status, limit, offset])}`, 45, async () => {
            const scoped = (qb) => qb.eq("source", "sales").eq("created_by_actor_id", actorId).eq("buyer_id", ownerId);
            const count = () => scoped(supabase.from("rfq_enquiries").select("id", { count: "exact", head: true }));

            let query = scoped(supabase.from("rfq_enquiries").select("*", { count: "exact" }));
            if (status === "open") query = query.neq("status", "closed");
            if (status === "won") query = query.eq("status", "closed").eq("sales_outcome", "won");
            if (status === "lost") query = query.eq("status", "closed").eq("sales_outcome", "lost");
            if (q) query = query.or(`product_name.ilike.%${q}%,customer_name.ilike.%${q}%,customer_gstin.ilike.%${q}%`);
            query = query.order("last_activity_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + limit - 1);

            if (status === "reminder") query = query.not("reminder_at", "is", null).neq("status", "closed");
            // (keep the open / won / lost lines as they are)
            if (q) query = query.or(`product_name.ilike.%${q}%,customer_name.ilike.%${q}%,customer_gstin.ilike.%${q}%`);
            query = (status === "reminder"
                ? query.order("reminder_at", { ascending: true })        // soonest first
                : query.order("last_activity_at", { ascending: false })
            ).order("id", { ascending: true }).range(offset, offset + limit - 1);

            const first = offset === 0;
            const [list, all, open, won, lost, rem] = await Promise.all([
                query,
                first ? count() : null,
                first ? count().neq("status", "closed") : null,
                first ? count().eq("status", "closed").eq("sales_outcome", "won") : null,
                first ? count().eq("status", "closed").eq("sales_outcome", "lost") : null,
                first ? count().neq("status", "closed").not("reminder_at", "is", null) : null,
            ]);
            if (list.error) throw list.error;

            const rows = list.data || [];
            const qCount = new Map();
            if (rows.length) {
                const { data: qs, error: qErr } = await supabase.from("sales_quotes").select("enquiry_id").in("enquiry_id", rows.map((r) => r.id));
                if (qErr) throw qErr;
                for (const x of qs || []) qCount.set(x.enquiry_id, (qCount.get(x.enquiry_id) || 0) + 1);
            }
            const items = rows.map((r) => dtoOf(r, { quotesCount: qCount.get(r.id) || 0 }));

            const out = {
                success: true, items, total: list.count ?? items.length,
                hasMore: offset + items.length < (list.count ?? 0),
            };
            if (first) out.counts = { all: all?.count || 0, open: open?.count || 0, won: won?.count || 0, lost: lost?.count || 0, reminder: rem?.count || 0 };
            return out;
        });
        res.json(body);
    } catch (e) { oops(res, e); }
}

// ---- products (shared shape for the quote picker and the new-enquiry picker) ----------------------------
function productItem(s, { unit, last, overrides, taggedId } = {}) {
    const pack = Number(s.pack_size) > 0 ? Number(s.pack_size) : 1;
    const master = Number(s.units_per_master_pack) > 0 ? Number(s.units_per_master_pack) : 1;
    const list = Number(s.price) > 0 ? round4(Number(s.price) / saleUnits(pack, master)) : null;
    return {
        submissionId: s.id,
        productName: s.brand?.name || s.product_name,
        brandName: s.brand?.brand_name || s.brand_name || "",
        image: s.image || s.brand?.image || null,
        description: listingDescription(s),
        unit: s.unit, packSize: pack, masterPackSize: master,
        gstPercent: Number(s.gst_percent) || 0,
        moq: s.moq != null ? Number(s.moq) : null,
        listUnitPriceIncl: list,
        lastUnitPriceIncl: last?.get(s.id) ?? null,
        customUnitPriceIncl: overrides ? customUnitPriceOf(s, overrides.get(s.id)) : null,
        unitMatches: unit ? sameUnit(s.unit, unit) : true,
        reason: listingProblem(s),   // "In review" / "Paused" / "Expired" ... or null when it can be used
        url: productUrl(s.id),
        tagged: !!taggedId && s.id === taggedId,
    };
}

function productQuery(sellerId, q) {
    let query = supabase.from("seller_product_submissions")
        .select(SUB_SELECT, { count: "exact" })
        .eq("seller_id", sellerId).neq("review_status", "rejected")
        .is("hs_generic_product_brands.deleted_at", null);
    if (q) query = query.or(`product_name.ilike.%${q}%,brand_name.ilike.%${q}%`);
    return query;
}

// ---- GET /sales/threads/products?q=&limit=&offset=  (company catalog, no thread needed) -----------------
export async function listCatalogProducts(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const { sellerId } = getSalesActor(req);
        if (!sellerId) return fail(res, 409, NO_SELLER);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const q = safeSearch(req.query.q);

        const body = await cached(`stc:${sellerId}:${hashKey([q, limit, offset])}`, 20, async () => {
            const { data, count, error } = await productQuery(sellerId, q)
                .order("created_at", { ascending: false }).range(offset, offset + limit - 1);
            if (error) throw error;
            const items = (data || []).map((r) => productItem(flatSub(r)));
            return {
                success: true, items, total: count ?? items.length,
                hasMore: offset + items.length < (count ?? 0), nextOffset: offset + items.length,
            };
        });
        res.json(body);
    } catch (e) { oops(res, e); }
}

// ---- POST /sales/threads -------------------------------------------------------------------------------
// { customerGstin?, customerName?, customerPhone?, customerEmail?, productSubmissionId? | productName, quantity, unit, specifications? }
export async function createThread(req, res) {
    try {
        const { actorId, actorName, ownerId, sellerId } = getSalesActor(req);
        const b = req.body || {};

        let customerName = str(b.customerName, 160);
        const gstin = cleanGstin(b.customerGstin);
        if (gstin && !GSTIN_RE.test(gstin)) return fail(res, 400, "Enter a valid 15-character GST number, or leave it empty.");
        if (!customerName && !gstin) return fail(res, 400, "Enter the customer's GST number or company name.");

        const phoneRaw = str(b.customerPhone, 20), emailRaw = str(b.customerEmail, 200);
        const phone = phoneRaw ? cleanPhone(phoneRaw) : "";
        const email = emailRaw ? cleanEmail(emailRaw) : "";
        if (phoneRaw && !phone) return fail(res, 400, "Enter a valid 10-digit mobile number.");
        if (emailRaw && !email) return fail(res, 400, "Enter a valid email address.");

        // Product: tagged from the company catalog, or typed by hand.
        let product = null;
        if (b.productSubmissionId) {
            if (!isUuid(b.productSubmissionId)) return fail(res, 400, "The selected product is invalid.");
            if (!sellerId) return fail(res, 409, NO_SELLER);
            const { data: sub, error: sErr } = await supabase.from("seller_product_submissions").select(SUB_SELECT)
                .eq("seller_id", sellerId).eq("id", b.productSubmissionId).neq("review_status", "rejected")
                .is("hs_generic_product_brands.deleted_at", null).maybeSingle();
            if (sErr) throw sErr;
            if (!sub) return fail(res, 404, "This product isn't in your company's catalog.");
            product = flatSub(sub);
            const why = listingProblem(product);
            if (why) return fail(res, 409, `"${product.brand?.name || product.product_name}" can't be used right now (${why.toLowerCase()}).`);
        }
        const productName = product ? (product.brand?.name || product.product_name) : str(b.productName, 200);
        if (productName.length < 2) return fail(res, 400, "Product name must be at least 2 characters.");

        const quantity = Number(b.quantity);
        if (!(quantity > 0) || quantity > 1e9) return fail(res, 400, "Enter a valid quantity.");
        const unit = product && RFQ_UNITS.includes(product.unit) ? product.unit : b.unit;
        if (!RFQ_UNITS.includes(unit)) return fail(res, 400, "Select a valid unit.");

        // The company name always comes from the GST number when it can be found.
        if (gstin) {
            const official = await canonicalCustomerName({ sellerId, ownerId, gstin });
            if (official) customerName = official;
        }

        const now = new Date().toISOString();
        const { data, error } = await supabase.from("rfq_enquiries").insert({
            buyer_id: ownerId,                       // belongs to the company, so the team sees it on the Save page
            source: "sales", visibility: "private",  // never listed publicly
            status: "approved", published_at: now,   // no admin review: it is not shown to suppliers
            product_name: productName, product_submission_id: product?.id || null,
            quantity, unit, pack_size: 1,
            specifications: str(b.specifications, 2000) || null,
            accept_equivalent: false, images: [], supplier_locations: [],
            payment_terms: "flexible", consumption_type: "one_time",
            customer_name: customerName || null, customer_gstin: gstin || null,
            customer_phone: phone || null, customer_email: email || null,
            created_by_actor_id: actorId, created_by_actor_name: actorName,
            last_activity_at: now, last_entry_preview: "Enquiry created",
        }).select("*").single();
        if (error) throw error;

        await supabase.from("sales_thread_entries").insert({
            enquiry_id: data.id, author_id: actorId, author_name: actorName, kind: "system",
            body: `Enquiry created: ${productName} · ${quantity} ${unit}`,
        });

        await notify(ownerId, actorId, data.id);
        res.json({ success: true, thread: dtoOf(data, { quotesCount: 0 }), message: "Enquiry created." });
    } catch (e) { oops(res, e); }
}

// ---- GET /sales/threads/:id?limit=&before=&beforeId=&after= --------------------------------------------
//   (no cursor)      -> newest `limit` entries, oldest-first, plus hasOlder
//   before(+beforeId)-> the `limit` entries just older than that entry
//   after            -> entries created at/after that time (cheap refresh). `reset: true` if there are too many.
export async function getThread(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const row = await loadOwnThread(req, res); if (!row) return;

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || ENTRY_PAGE, 1), ENTRY_PAGE_MAX);
        const before = req.query.before ? String(req.query.before) : "";
        const after = req.query.after ? String(req.query.after) : "";
        const beforeId = isUuid(req.query.beforeId) ? String(req.query.beforeId) : "";
        if ((before && !TS_RE.test(before)) || (after && !TS_RE.test(after))) return fail(res, 400, "Invalid cursor.");

        const ver = await getVer(`st:${row.id}`);
        const body = await cached(`sth:${row.id}:${ver}:${hashKey([limit, before, beforeId, after])}`, 30, async () => {
            const quotesQ = supabase.from("sales_quotes").select("id", { count: "exact", head: true }).eq("enquiry_id", row.id);

            if (after) {
                const [list, qc] = await Promise.all([
                    supabase.from("sales_thread_entries").select("*").eq("enquiry_id", row.id)
                        .gte("created_at", after)
                        .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(AFTER_MAX + 1),
                    quotesQ,
                ]);
                if (list.error) throw list.error;
                const thread = dtoOf(row, { quotesCount: qc.count || 0 });
                const data = list.data || [];
                if (data.length > AFTER_MAX) return { success: true, thread, entries: [], reset: true };
                return { success: true, thread, entries: await hydrateEntries(data) };
            }

            let q = supabase.from("sales_thread_entries").select("*").eq("enquiry_id", row.id)
                .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
            if (before) {
                q = beforeId
                    ? q.or(`created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`)
                    : q.lt("created_at", before);
            }
            const [list, qc] = await Promise.all([q, quotesQ]);
            if (list.error) throw list.error;
            const data = list.data || [];
            const hasOlder = data.length > limit;
            const page = data.slice(0, limit).reverse();
            return {
                success: true, thread: dtoOf(row, { quotesCount: qc.count || 0 }),
                entries: await hydrateEntries(page), hasOlder,
            };
        });
        res.json(body);
    } catch (e) { oops(res, e); }
}

// ---- PATCH /sales/threads/:id  (customer details only; the product is locked after creation) ------------
export async function updateThread(req, res) {
    try {
        const { actorId, ownerId, sellerId } = getSalesActor(req);
        const row = await loadOwnThread(req, res); if (!row) return;
        const b = req.body || {};
        const patch = {};

        if ("customerName" in b) patch.customer_name = str(b.customerName, 160) || null;
        if ("customerGstin" in b) {
            const g = cleanGstin(b.customerGstin);
            if (g && !GSTIN_RE.test(g)) return fail(res, 400, "Enter a valid 15-character GST number.");
            patch.customer_gstin = g || null;
        }
        if ("customerPhone" in b) {
            const raw = str(b.customerPhone, 20), p = raw ? cleanPhone(raw) : "";
            if (raw && !p) return fail(res, 400, "Enter a valid 10-digit mobile number.");
            patch.customer_phone = p || null;
        }
        if ("customerEmail" in b) {
            const raw = str(b.customerEmail, 200), e = raw ? cleanEmail(raw) : "";
            if (raw && !e) return fail(res, 400, "Enter a valid email address.");
            patch.customer_email = e || null;
        }
        if (!Object.keys(patch).length) return fail(res, 400, "Nothing to update.");

        // A new GST number: take the company name from the GST records instead of what was typed.
        if (patch.customer_gstin && patch.customer_gstin !== row.customer_gstin) {
            const official = await canonicalCustomerName({ sellerId, ownerId, gstin: patch.customer_gstin });
            if (official) patch.customer_name = official;
        }

        const name = "customer_name" in patch ? patch.customer_name : row.customer_name;
        const gst = "customer_gstin" in patch ? patch.customer_gstin : row.customer_gstin;
        if (!name && !gst) return fail(res, 400, "Keep either the company name or the GST number.");

        const { data, error } = await supabase.from("rfq_enquiries").update(patch).eq("id", row.id).select("*").single();
        if (error) throw error;
        await notify(ownerId, actorId, row.id);
        res.json({ success: true, thread: dtoOf(data) });
    } catch (e) { oops(res, e); }
}

// ---- PATCH /sales/threads/:id/status  { status: "open" | "won" | "lost" } ------------------------------
export async function setThreadStatus(req, res) {
    try {
        const { actorId, actorName, ownerId } = getSalesActor(req);
        const row = await loadOwnThread(req, res); if (!row) return;
        const next = req.body?.status;
        if (!["open", "won", "lost"].includes(next)) return fail(res, 400, "Invalid status.");
        const dbStatus = next === "open" ? "approved" : "closed";
        const outcome = next === "open" ? null : next;
        if (row.status === dbStatus && (row.sales_outcome || null) === outcome) return res.json({ success: true, thread: dtoOf(row) });

        const body = next === "won" ? "Enquiry marked as won" : next === "lost" ? "Enquiry marked as lost" : "Enquiry reopened";
        const { data, error } = await supabase.from("rfq_enquiries")
            // .update({ status: dbStatus, sales_outcome: outcome, last_activity_at: new Date().toISOString(), last_entry_preview: body })
            .update({ status: dbStatus, sales_outcome: outcome, reminder_at: null, last_activity_at: new Date().toISOString(), last_entry_preview: body })
            .eq("id", row.id).select("*").single();
        if (error) throw error;
        await supabase.from("sales_thread_entries").insert({ enquiry_id: row.id, author_id: actorId, author_name: actorName, kind: "system", body });
        await notify(ownerId, actorId, row.id);
        res.json({ success: true, thread: dtoOf(data) });
    } catch (e) { oops(res, e); }
}

// ---- PATCH /sales/threads/:id/reminder  { reminderAt: ISO string | null } ------------------------------
// The client works out "9:00 AM when no time is given" in the user's own timezone and sends the final instant.
export async function setReminder(req, res) {
    try {
        const { actorId, actorName, ownerId } = getSalesActor(req);
        const row = await loadOwnThread(req, res); if (!row) return;
        if (row.status === "closed") return fail(res, 409, "Reopen this enquiry to set a reminder.");
        const raw = req.body?.reminderAt;
        const now = Date.now();

        // cancel
        if (raw === null) {
            if (!row.reminder_at) return res.json({ success: true, thread: dtoOf(row) });
            const { data, error } = await supabase.from("rfq_enquiries").update({ reminder_at: null }).eq("id", row.id).select("*").single();
            if (error) throw error;
            await supabase.from("sales_thread_entries").insert({
                enquiry_id: row.id, author_id: actorId, author_name: actorName, kind: "system", body: "Reminder removed",
            });
            await notify(ownerId, actorId, row.id);
            return res.json({ success: true, thread: dtoOf(data) });
        }

        // set / change
        if (typeof raw !== "string" || !TS_RE.test(raw)) return fail(res, 400, "Choose a valid date and time.");
        const at = new Date(raw).getTime();
        if (Number.isNaN(at)) return fail(res, 400, "Choose a valid date and time.");
        if (at <= now) return fail(res, 400, "The reminder must be set for a future date and time.");
        if (at > now + REMINDER_MAX_MS) return fail(res, 400, "Reminders can be set up to a year ahead.");

        const iso = new Date(at).toISOString();
        const body = `Reminder set for ${remText(iso)}`;
        const { data, error } = await supabase.from("rfq_enquiries")
            .update({ reminder_at: iso, last_activity_at: new Date().toISOString(), last_entry_preview: body })
            .eq("id", row.id).select("*").single();
        if (error) throw error;
        await supabase.from("sales_thread_entries").insert({
            enquiry_id: row.id, author_id: actorId, author_name: actorName, kind: "system", body,
        });
        await notify(ownerId, actorId, row.id);
        res.json({ success: true, thread: dtoOf(data) });
    } catch (e) { oops(res, e); }
}

// ---- POST /sales/threads/:id/attachments/sign  { name, type, size } ------------------------------------
// The browser uploads straight to private storage with the returned URL, so the API never handles file bytes.
export async function signAttachment(req, res) {
    try {
        const row = await loadOwnThread(req, res); if (!row) return;
        const name = str(req.body?.name, 150);
        const size = Number(req.body?.size);
        const ext = (name.split(".").pop() || "").toLowerCase();
        if (!name || !ALLOWED_EXT.has(ext)) return fail(res, 400, "This file type isn't supported. Use photos, PDF, Word, Excel, PowerPoint, CSV or text files.");
        if (!(size > 0) || size > MAX_BYTES) return fail(res, 400, "Files can be up to 15 MB.");

        const path = `${row.id}/${randomUUID()}.${ext}`;
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
        if (error) throw error;
        res.json({ success: true, uploadUrl: data.signedUrl, path });
    } catch (e) { oops(res, e); }
}

function cleanAttachments(list, enquiryId) {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > MAX_FILES) return null;
    const out = [];
    for (const a of list) {
        const path = typeof a?.path === "string" ? a.path : "";
        if (!path.startsWith(`${enquiryId}/`) || path.includes("..") || path.length > 200) return null;
        out.push({ path, name: str(a.name, 150) || "file", type: str(a.type, 100), size: Math.max(0, Math.min(Number(a.size) || 0, MAX_BYTES)) });
    }
    return out;
}

// ---- POST /sales/threads/:id/entries  { body, attachments } --------------------------------------------
export async function addEntry(req, res) {
    try {
        const { actorId, actorName, ownerId } = getSalesActor(req);
        const row = await loadOwnThread(req, res); if (!row) return;
        if (row.status === "closed") return fail(res, 409, "This enquiry is closed. Reopen it to add updates.");

        const body = str(req.body?.body, 4000);
        const attachments = cleanAttachments(req.body?.attachments, row.id);
        if (attachments === null) return fail(res, 400, "Attachments are invalid.");
        if (!body && !attachments.length) return fail(res, 400, "Write an update or attach a file.");

        const { data, error } = await supabase.from("sales_thread_entries")
            .insert({ enquiry_id: row.id, author_id: actorId, author_name: actorName, kind: "note", body, attachments })
            .select("*").single();
        if (error) throw error;
        await touch(row.id, clipPreview(body, attachments.length));
        await notify(ownerId, actorId, row.id);
        const [entry] = await hydrateEntries([data]);
        res.json({ success: true, entry });
    } catch (e) { oops(res, e); }
}

// ---- GET /sales/threads/:id/products?q=&limit=&offset= -------------------------------------------------
// The company's own products (unavailable ones carry a `reason`), with the price last quoted to THIS customer (by GST number)
// and, when the customer is a BBM buyer, the custom price they currently have on each product.
// The product tagged on the enquiry (if any) is put first on the first page and flagged `tagged`.
// `nextOffset` is the offset of the next database page (the tagged product may be an extra row on top of the page).
export async function listQuoteProducts(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const { sellerId, ownerId } = getSalesActor(req);
        if (!sellerId) return fail(res, 409, NO_SELLER);
        const row = await loadOwnThread(req, res); if (!row) return;

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const q = safeSearch(req.query.q);
        const taggedId = row.product_submission_id || null;

        const ver = await getVer(`st:${row.id}`);
        const body = await cached(`stp:${sellerId}:${row.id}:${ver}:${hashKey([q, limit, offset])}`, 20, async () => {
            const { data, count, error } = await productQuery(sellerId, q)
                .order("created_at", { ascending: false }).range(offset, offset + limit - 1);
            if (error) throw error;
            const dbRows = (data || []).length;
            const subs = (data || []).map(flatSub);

            if (taggedId && offset === 0 && !q) {
                const at = subs.findIndex((s) => s.id === taggedId);
                if (at > 0) subs.unshift(...subs.splice(at, 1));
                else if (at < 0) {
                    const { data: t, error: tErr } = await supabase.from("seller_product_submissions").select(SUB_SELECT)
                        .eq("seller_id", sellerId).eq("id", taggedId).neq("review_status", "rejected")
                        .is("hs_generic_product_brands.deleted_at", null).maybeSingle();
                    if (tErr) throw tErr;
                    if (t) subs.unshift(flatSub(t));
                }
            }
            const subIds = subs.map((s) => s.id);

            const lastP = (async () => {
                const m = new Map();
                if (!row.customer_gstin || !subIds.length) return m;
                const { data: cp, error: cErr } = await supabase.from("sales_customer_prices").select("submission_id, unit_price_incl")
                    .eq("seller_id", sellerId).eq("customer_gstin", row.customer_gstin).in("submission_id", subIds);
                if (cErr) throw cErr;
                for (const c of cp || []) m.set(c.submission_id, Number(c.unit_price_incl));
                return m;
            })();
            // Is the customer a BBM buyer? (null = unknown: no GST number on the enquiry yet)
            const buyerP = (async () => {
                if (!row.customer_gstin) return { buyer: null, overrides: new Map() };
                try {
                    const b = await findBuyerCompanyByGstin(row.customer_gstin, ownerId);
                    if (b && !b.self) return { buyer: { onBbm: true, name: b.name }, overrides: await fetchBuyerOverrides(sellerId, b.companyId, subIds) };
                    return { buyer: { onBbm: false, name: null, own: !!b?.self }, overrides: new Map() };
                } catch (e) {
                    console.error("[sales] buyer lookup failed:", e?.message || e);
                    return { buyer: null, overrides: new Map() };
                }
            })();
            const [last, { buyer, overrides }] = await Promise.all([lastP, buyerP]);

            const items = subs.map((s) => productItem(s, { unit: row.unit, last, overrides, taggedId }));
            return {
                success: true, items, buyer, total: count ?? items.length,
                hasMore: offset + dbRows < (count ?? 0), nextOffset: offset + dbRows,
            };
        });
        res.json(body);
    } catch (e) { oops(res, e); }
}

// ---- delivery ------------------------------------------------------------------------------------------
async function deliver({ quote, thread, sellerName, actorName, actorEmail, channels }) {
    const items = quote.items;
    const out = {};
    const run = async (channel, fn) => {
        try { out[channel] = await fn(); }
        catch (e) { out[channel] = { status: "failed", error: errText(e), at: new Date().toISOString() }; }
    };
    const tasks = [];
    if (channels.includes("whatsapp")) tasks.push(run("whatsapp", async () => {
        const r = await sendSalesQuotationWhatsApp({
            to: thread.customer_phone,
            customerName: thread.customer_name || "there",
            sellerName, enquiryProduct: thread.product_name,
            itemsLine: whatsappItemsLine(items),
            total: inr(quote.total), validUntil: validText(quote.valid_until),
            closing: quote.note || "Please get in touch with us to confirm your order.",
        });
        return r.success
            ? { status: "sent", at: new Date().toISOString() }
            : { status: "failed", error: r.skipped ? "WhatsApp isn't configured or the number is invalid." : errText(r.error), at: new Date().toISOString() };
    }));
    if (channels.includes("email")) tasks.push(run("email", async () => {
        await sendSalesQuotationEmail({
            to: thread.customer_email, customerName: thread.customer_name || "there",
            sellerName, salespersonName: actorName, enquiryProduct: thread.product_name,
            items, subtotal: quote.subtotal, gstAmount: quote.gst_amount, total: quote.total,
            validUntil: validText(quote.valid_until), note: quote.note || "", replyTo: actorEmail || undefined,
        });
        return { status: "sent", at: new Date().toISOString() };
    }));
    await Promise.all(tasks);
    return out;
}

const sellerNameOf = (sellerId) => cached(`sn:${sellerId}`, 600, async () => {
    const { data } = await supabase.from("seller_profiles").select("display_name").eq("id", sellerId).maybeSingle();
    return data?.display_name || "Our team";
});

function contactCheck(thread, channels) {
    if (!channels.length) return "Choose WhatsApp, email or both.";
    if (channels.includes("whatsapp") && !thread.customer_phone) return "Add the customer's mobile number to send on WhatsApp.";
    if (channels.includes("email") && !thread.customer_email) return "Add the customer's email address to send by email.";
    return null;
}

const cleanChannels = (list) => [...new Set((Array.isArray(list) ? list : []).filter((c) => CHANNELS.includes(c)))];

// ---- POST /sales/threads/:id/quotes --------------------------------------------------------------------
// { items: [{ submissionId, quantity, price, gstInclusive, setCustomPrice }], channels, validityDays, note }
// setCustomPrice === true also stores the quoted price as this buyer's custom price on BBM (when the customer is a BBM buyer).
// The customer is added to the salesperson's customer list on the first quotation (if not already there).
export async function sendQuote(req, res) {
    try {
        const { actorId, actorName, actorEmail, ownerId, sellerId } = getSalesActor(req);
        const loaded = await loadOwnThread(req, res); if (!loaded) return;
        if (loaded.status === "closed") return fail(res, 409, "This enquiry is closed. Reopen it to send a quotation.");
        if (!sellerId) return fail(res, 409, NO_SELLER);

        const b = req.body || {};
        if (!loaded.customer_gstin) return fail(res, 400, "Add the customer's GST number before sending a quotation.");
        const channels = cleanChannels(b.channels);
        const contactErr = contactCheck(loaded, channels);
        if (contactErr) return fail(res, 400, contactErr);

        const validityDays = VALIDITY.includes(Number(b.validityDays)) ? Number(b.validityDays) : 7;
        const raw = Array.isArray(b.items) ? b.items : [];
        if (!raw.length || raw.length > 20) return fail(res, 400, "Add between 1 and 20 products.");
        const ids = raw.map((i) => i?.submissionId);
        if (ids.some((id) => !isUuid(id)) || new Set(ids).size !== ids.length) return fail(res, 400, "The product list is invalid.");

        // Always read products fresh here (never from cache): this is the price/availability check that matters.
        const { data: subs, error: sErr } = await supabase.from("seller_product_submissions")
            .select(SUB_SELECT)
            .eq("seller_id", sellerId).in("id", ids).is("hs_generic_product_brands.deleted_at", null);
        if (sErr) throw sErr;
        const byId = new Map((subs || []).map((r) => { const s = flatSub(r); return [s.id, s]; }));

        const items = [];
        for (const r of raw) {
            const s = byId.get(r.submissionId);
            if (!s) return fail(res, 404, "One of the products is not in your company's catalog.");
            const why = listingProblem(s);
            if (why) return fail(res, 409, `"${s.brand?.name || s.product_name}" can't be quoted right now (${why.toLowerCase()}).`);
            const price = Number(r.price), quantity = Number(r.quantity);
            if (!(price > 0) || price > 1e7) return fail(res, 400, `Enter a valid price for ${s.brand?.name || s.product_name}.`);
            if (!(quantity > 0) || quantity > 1e9) return fail(res, 400, `Enter a valid quantity for ${s.brand?.name || s.product_name}.`);
            const gstPercent = Number(s.gst_percent) || 0;
            const gstInclusive = r.gstInclusive !== false;
            items.push({
                submissionId: s.id, productName: s.brand?.name || s.product_name, brandName: s.brand?.brand_name || s.brand_name || "",
                description: listingDescription(s), image: s.image || s.brand?.image || null, unit: s.unit,
                quantity, gstPercent, gstInclusive, enteredPrice: price,
                ...priceLine({ price, gstInclusive, gstPercent, quantity }),
                url: productUrl(s.id),
                setCustomPrice: r.setCustomPrice === true,
            });
        }

        // Make sure the customer is in the customer list. addOne also resolves the official company name from the GST number,
        // which then replaces whatever was typed (so the quotation and the thread carry the reliable name).
        const companyId = req.sales?.companyId ?? ownerId;
        const ensured = await ensureCustomer({ sellerId, companyId, actorId, teamId: req.sales?.teamId, thread: loaded });
        let thread = loaded;   // a copy: the loaded row may come from the shared cache and must not be mutated
        if (ensured.name && ensured.name !== loaded.customer_name) {
            thread = { ...loaded, customer_name: ensured.name };
            await supabase.from("rfq_enquiries").update({ customer_name: ensured.name }).eq("id", loaded.id);
        }

        const total = items.reduce((a, i) => a + i.totalIncl, 0);
        const subtotal = items.reduce((a, i) => a + i.taxable, 0);
        const validUntil = NO_EXPIRY;

        const { data: quote, error: qErr } = await supabase.from("sales_quotes").insert({
            enquiry_id: thread.id, seller_id: sellerId, actor_id: actorId, actor_name: actorName,
            customer_name: thread.customer_name, customer_gstin: thread.customer_gstin,
            customer_phone: thread.customer_phone, customer_email: thread.customer_email,
            items, subtotal: Math.round(subtotal * 100) / 100, total: Math.round(total * 100) / 100,
            gst_amount: Math.round((total - subtotal) * 100) / 100,
            note: str(b.note, 500) || null, validity_days: validityDays, valid_until: validUntil, channels,
        }).select("*").single();
        if (qErr) throw qErr;

        // Remember this price for this customer's GST number (pre-filled next time).
        const { error: pErr } = await supabase.from("sales_customer_prices").upsert(
            items.map((i) => ({
                seller_id: sellerId, customer_gstin: thread.customer_gstin, submission_id: i.submissionId,
                unit_price_incl: i.unitPriceIncl, updated_by: actorId, updated_at: new Date().toISOString(),
            })), { onConflict: "seller_id,customer_gstin,submission_id" });
        if (pErr) console.error("[sales] customer price save failed:", pErr.message);

        // Make it the buyer's real price on BBM too (only for BBM buyers and only for lines the salesperson ticked).
        // Done BEFORE delivery, so the product link in the message already shows this price. Never fails the quotation.
        const customPricing = await syncQuoteCustomPrices({
            sellerId, ownerId, gstin: thread.customer_gstin, items, subsById: byId,
        });
        if (customPricing.status === "done" && (customPricing.applied.length || customPricing.removed.length)) {
            try {
                await logActivity({
                    teamId: req.sales?.teamId, actorId, actorRole: "member", category: "sales", action: "sales.quote_custom_price",
                    label: `Set quoted prices for ${customPricing.buyerName || thread.customer_name || "a buyer"} (${customPricing.applied.length} product${customPricing.applied.length === 1 ? "" : "s"})`,
                    entityType: "rfq", entityId: thread.id, meta: { link: "/grow/customers", quoteId: quote.id },
                });
            } catch { /* best effort */ }
        }

        const { data: entryRow, error: eErr } = await supabase.from("sales_thread_entries").insert({
            enquiry_id: thread.id, author_id: actorId, author_name: actorName, kind: "quote", quote_id: quote.id,
            body: `Quotation sent · ${inr(quote.total)}`,
        }).select("*").single();
        if (eErr) throw eErr;

        const delivery = await deliver({ quote, thread, sellerName: await sellerNameOf(sellerId), actorName, actorEmail, channels });
        const { data: done } = await supabase.from("sales_quotes").update({ delivery }).eq("id", quote.id).select("*").single();
        await touch(thread.id, `Quotation sent · ${inr(quote.total)}`);
        await notify(ownerId, actorId, thread.id);

        const okCount = Object.values(delivery).filter((d) => d.status === "sent").length;
        res.json({
            success: true, delivery, customPricing,
            customerAdded: ensured.status === "added" ? (ensured.name || thread.customer_name || "The customer") : null,
            quote: quoteDto(done || { ...quote, delivery }),
            entry: entryDto(entryRow, quoteDto(done || { ...quote, delivery })),
            message: okCount === channels.length ? "Quotation sent." : okCount ? "Quotation sent on some channels. Retry the others from the thread." : "Quotation saved, but it couldn't be delivered. Retry from the thread.",
        });
    } catch (e) { oops(res, e); }
}

// ---- POST /sales/threads/:id/quotes/:quoteId/resend  { channels } --------------------------------------
export async function resendQuote(req, res) {
    try {
        const { actorId, actorName, actorEmail, ownerId, sellerId } = getSalesActor(req);
        const thread = await loadOwnThread(req, res); if (!thread) return;
        if (!isUuid(req.params.quoteId)) return fail(res, 404, "Quotation not found.");
        const { data: quote, error } = await supabase.from("sales_quotes").select("*")
            .eq("id", req.params.quoteId).eq("enquiry_id", thread.id).maybeSingle();
        if (error) throw error;
        if (!quote) return fail(res, 404, "Quotation not found.");
        if (new Date(quote.valid_until).getTime() <= Date.now()) return fail(res, 409, "This quotation has expired. Send a new one.");

        const channels = cleanChannels(req.body?.channels);
        const contactErr = contactCheck(thread, channels);
        if (contactErr) return fail(res, 400, contactErr);

        const sent = await deliver({ quote, thread, sellerName: await sellerNameOf(sellerId), actorName, actorEmail, channels });
        const delivery = { ...(quote.delivery || {}), ...sent };
        const merged = [...new Set([...(quote.channels || []), ...channels])];
        const { data: upd, error: uErr } = await supabase.from("sales_quotes").update({ delivery, channels: merged }).eq("id", quote.id).select("*").single();
        if (uErr) throw uErr;
        await touch(thread.id, "Quotation resent");
        await notify(ownerId, actorId, thread.id);
        const failed = Object.values(sent).some((d) => d.status !== "sent");
        res.json({ success: true, quote: quoteDto(upd), message: failed ? "Couldn't deliver on every channel." : "Quotation sent again." });
    } catch (e) { oops(res, e); }
}