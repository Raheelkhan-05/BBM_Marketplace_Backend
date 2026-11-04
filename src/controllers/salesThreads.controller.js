
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
// Kinds: sales_kind "enquiry" (product tagged / typed at creation) or "cold_call" (a call log with a first note and
// NO product yet). A cold call can get its product ONCE later (PATCH /:id/product); a quotation needs a product.
// Product: an enquiry may be created with a product tagged from the company catalog (product_submission_id);
// once set it is never editable afterwards.

import { randomUUID } from "node:crypto";
import { supabase } from "../config/supabase.js";
import { isUuid, RFQ_UNITS } from "../services/rfqValidation.js";
import { sameUnit } from "../services/rfqQuotes.service.js";
import { sendSalesQuotationWhatsApp } from "../services/whatsapp.service.js";
import { sendSalesQuotationEmail } from "../services/mail.service.js";
import { sendSalespersonCopy, loadSalesperson } from "../services/salespersonCopy.service.js";
import { logActivity } from "../services/team.service.js";
import { pingCustomersChanged } from "../services/salesSync.service.js";
import { cached, getVer, bumpVer, hashKey } from "../services/cache.service.js";
import { resolveGstin, addOne } from "./sellerCustomers.controller.js";
import { saveContactsForCustomer } from "../services/sellerCustomerContact.service.js";
import { parseContact, parseContactList } from "../services/customerContacts.service.js";
import { cleanMentions, afterMessage } from "../services/salesChat.service.js";

import {
    BUCKET, GSTIN_RE, getSalesActor, str, safeSearch, cleanGstin, cleanPhone, cleanEmail, round4,
    saleUnits, priceLine, listingProblem, listingDescription, productUrl, clipPreview, ping,
    threadDto, entryDto, quoteDto, hydrateEntries, inr, fmtDate, whatsappItemsLine,
} from "../services/salesThreads.service.js";

import {
    findBuyerCompanyByGstin, fetchBuyerOverrides, customUnitPriceOf, syncQuoteCustomPrices, lookupBuyerCompany,
} from "../services/salesQuotePricing.service.js";

const ENTRY_PAGE = 20;
const ENTRY_PAGE_MAX = 50;
const AFTER_MAX = 100;
const MAX_FILES = 10;
const MAX_BYTES = 15 * 1024 * 1024;

const ALLOWED_EXT = new Set([
    "jpg", "jpeg", "png", "webp", "gif", "heic",
    "pdf", "doc", "docx", "xls", "xlsx",
    "csv", "txt", "ppt", "pptx",
]);

// Quotations never expire for now.
const NO_EXPIRY = "9999-12-31T23:59:59.000Z";

const validText = (iso) =>
    new Date(iso).getUTCFullYear() >= 9000
        ? "further notice"
        : fmtDate(iso);

const VALIDITY = [1, 3, 7, 15, 30];
const CHANNELS = ["whatsapp", "email"];
const CONTACTS_MAX = 10;

const primaryOf = (list) => ({
    phone: list.find((c) => c.phone)?.phone || null,
    email: list.find((c) => c.email)?.email || null,
});

const rowContacts = (row) =>
    (Array.isArray(row.customer_contacts) ? row.customer_contacts : [])
        .map((c) => ({
            name: c?.name || "",
            phone: c?.phone || "",
            email: c?.email || "",
        }));

// Who a thread can be quoted to.
const targetsOf = (row) => {
    const l = rowContacts(row).filter((c) => c.phone || c.email);

    if (l.length) return l;

    return row.customer_phone || row.customer_email
        ? [{
            name: "",
            phone: row.customer_phone || "",
            email: row.customer_email || "",
        }]
        : [];
};

const TS_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}(:?\d{2})?)$/;

const STATUS_FILTERS = ["open", "won", "lost", "reminder", "cold"];
const KIND_COLD = "cold_call";

const NOTE_MAX = 4000;
const REMINDER_MAX_MS = 366 * 24 * 60 * 60 * 1000;
const REMINDER_TZ = "Asia/Kolkata";

const remText = (iso) =>
    new Date(iso).toLocaleString("en-IN", {
        timeZone: REMINDER_TZ,
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });

const dtoOf = (row, extra) => ({
    ...threadDto(row, extra),

    productName: row.product_name || "",
    quantity: row.quantity ?? null,
    unit: row.unit || "",
    outcome: row.sales_outcome || null,
    productSubmissionId: row.product_submission_id || null,
    reminderAt: row.reminder_at || null,
    kind: row.sales_kind || "enquiry",
    hasProduct: !!row.product_name,
});

const SUB_SELECT =
    "*, hs_generic_product_brands!inner(id, name, brand_name, image, deleted_at)";

const fail = (res, status, message) =>
    res.status(status).json({
        success: false,
        message,
    });

const oops = (res, e) => {
    console.error("[sales threads]", e?.message || e);
    return fail(res, 500, "Something went wrong. Please try again.");
};

const errText = (e) =>
    String(
        e?.error?.error?.message ||
        e?.error?.message ||
        e?.message ||
        e ||
        "Failed"
    ).slice(0, 200);

const NO_SELLER =
    "Your company's seller account isn't approved yet, so products can't be quoted.";

const flatSub = ({ hs_generic_product_brands, ...rest }) => ({
    ...rest,
    brand: hs_generic_product_brands || null,
});

// A change happened: invalidate cached reads and tell live pages.
async function notify(ownerId, actorId, enquiryId) {
    await bumpVer(
        `sa:${actorId}`,
        enquiryId ? `st:${enquiryId}` : null
    );

    ping([ownerId, actorId], { enquiryId });
}

// The company name as the GST records / customer list know it.
async function canonicalCustomerName({
    sellerId,
    ownerId,
    gstin,
}) {
    if (!gstin || !GSTIN_RE.test(gstin)) return "";

    try {
        if (sellerId) {
            const { data } = await supabase
                .from("seller_customers")
                .select("business_name")
                .eq("seller_id", sellerId)
                .eq("gstin", gstin)
                .limit(1)
                .maybeSingle();

            if (data?.business_name) {
                return String(data.business_name).slice(0, 160);
            }
        }

        const r = await resolveGstin(gstin, ownerId);

        if (
            (r?.state === "registered" || r?.state === "unregistered") &&
            r.name
        ) {
            return String(r.name).slice(0, 160);
        }
    } catch (e) {
        console.error(
            "[sales threads] gst name lookup failed:",
            e?.message || e
        );
    }

    return "";
}

// Adds the quoted customer to the salesperson's customer list.
// Never fails the quotation.
async function ensureCustomer({
    sellerId,
    companyId,
    actorId,
    teamId,
    thread,
    contacts = [],
}) {
    try {
        const out = await addOne(
            sellerId,
            companyId,
            thread.customer_gstin,
            "gst",
            {
                assigned_to: actorId,
                assigned_by: actorId,
                assigned_kind: "self",
                assigned_at: new Date().toISOString(),
                contacts,
            }
        );

        if (
            out?.result === "added" ||
            out?.result === "invited" ||
            out?.result === "saved"
        ) {
            Promise.resolve(
                pingCustomersChanged(companyId, [actorId])
            ).catch(() => { });

            try {
                await logActivity({
                    teamId,
                    actorId,
                    actorRole: "member",
                    category: "sales",
                    action: "sales.customer_added",
                    label: `Added customer ${out.name} (from a quotation)`,
                    entityType: "customer",
                    entityId: out.customer?.id,
                    meta: {
                        link: "/sell/customers",
                        gstin: out.gstin,
                    },
                });
            } catch { }

            return {
                status: "added",
                name: out.name || "",
            };
        }

        await saveContactsForCustomer({
            sellerId,
            companyId,
            actorId,
            gstin: thread.customer_gstin,
            contacts,
        });

        return {
            status: out?.result === "exists" ? "exists" : "skipped",
            name: "",
        };
    } catch (e) {
        console.error(
            "[sales threads] add customer failed:",
            e?.message || e
        );

        return {
            status: "failed",
            name: "",
        };
    }
}

// Reads + validates the product part of a request.
async function readProduct(b, sellerId) {
    let product = null;

    if (b.productSubmissionId) {
        if (!isUuid(b.productSubmissionId)) {
            return {
                error: {
                    status: 400,
                    message: "The selected product is invalid.",
                },
            };
        }

        if (!sellerId) {
            return {
                error: {
                    status: 409,
                    message: NO_SELLER,
                },
            };
        }

        const { data: sub, error: sErr } = await supabase
            .from("seller_product_submissions")
            .select(SUB_SELECT)
            .eq("seller_id", sellerId)
            .eq("id", b.productSubmissionId)
            .neq("review_status", "rejected")
            .is("hs_generic_product_brands.deleted_at", null)
            .maybeSingle();

        if (sErr) throw sErr;

        if (!sub) {
            return {
                error: {
                    status: 404,
                    message: "This product isn't in your company's catalog.",
                },
            };
        }

        product = flatSub(sub);

        const why = listingProblem(product);

        if (why) {
            return {
                error: {
                    status: 409,
                    message: `"${product.brand?.name || product.product_name}" can't be used right now (${why.toLowerCase()}).`,
                },
            };
        }
    }

    const productName = product
        ? (product.brand?.name || product.product_name)
        : str(b.productName, 200);

    if (productName.length < 2) {
        return {
            error: {
                status: 400,
                message: "Product name must be at least 2 characters.",
            },
        };
    }

    const quantity = Number(b.quantity);

    if (!(quantity > 0) || quantity > 1e9) {
        return {
            error: {
                status: 400,
                message: "Enter a valid quantity.",
            },
        };
    }

    const unit =
        product && RFQ_UNITS.includes(product.unit)
            ? product.unit
            : b.unit;

    if (!RFQ_UNITS.includes(unit)) {
        return {
            error: {
                status: 400,
                message: "Select a valid unit.",
            },
        };
    }

    return {
        product,
        productName,
        quantity,
        unit,
    };
}

// ---- loading -------------------------------------------------------------------------------------------

async function loadOwnThread(req, res) {
    const { actorId, ownerId } = getSalesActor(req);
    const { id } = req.params;

    if (!isUuid(id)) {
        fail(res, 404, "Enquiry not found.");
        return null;
    }

    const ver = await getVer(`st:${id}`);

    const row = await cached(
        `sto:${id}:${actorId}:${ver}`,
        60,
        async () => {
            const { data, error } = await supabase
                .from("rfq_enquiries")
                .select("*")
                .eq("id", id)
                .eq("source", "sales")
                .eq("created_by_actor_id", actorId)
                .eq("buyer_id", ownerId)
                .maybeSingle();

            if (error) throw error;

            return data || null;
        }
    );

    if (!row) {
        fail(res, 404, "Enquiry not found.");
        return null;
    }

    return row;
}

// Shared updater for notes and quotations.
// The updater columns are stored on rfq_enquiries.
async function touch(
    enquiryId,
    preview,
    actorId,
    actorName
) {
    await supabase
        .from("rfq_enquiries")
        .update({
            last_activity_at: new Date().toISOString(),
            last_entry_preview: preview,
            reminder_at: null,

            ...(actorId
                ? { last_updated_by_actor_id: actorId }
                : {}),

            ...(actorName
                ? { last_updated_by_actor_name: actorName }
                : {}),
        })
        .eq("id", enquiryId);
}

// ---- GET /sales/threads -------------------------------------------------------------------------------

export async function listThreads(req, res) {
    try {
        res.set("Cache-Control", "no-store");

        const { actorId, ownerId } = getSalesActor(req);

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 15, 1),
            100
        );

        const offset = Math.max(
            parseInt(req.query.offset, 10) || 0,
            0
        );

        const q = safeSearch(req.query.q);

        const status = STATUS_FILTERS.includes(req.query.status)
            ? req.query.status
            : "";

        const ver = await getVer(`sa:${actorId}`);

        const body = await cached(
            `stl:${actorId}:${ver}:${hashKey([q, status, limit, offset])}`,
            45,
            async () => {
                const scoped = (qb) =>
                    qb
                        .eq("source", "sales")
                        .eq("created_by_actor_id", actorId)
                        .eq("buyer_id", ownerId);

                const count = () =>
                    scoped(
                        supabase
                            .from("rfq_enquiries")
                            .select("id", {
                                count: "exact",
                                head: true,
                            })
                    );

                let query = scoped(
                    supabase
                        .from("rfq_enquiries")
                        .select("*", {
                            count: "exact",
                        })
                );

                if (status === "open") {
                    query = query.neq("status", "closed");
                } else if (status === "won") {
                    query = query
                        .eq("status", "closed")
                        .eq("sales_outcome", "won");
                } else if (status === "lost") {
                    query = query
                        .eq("status", "closed")
                        .eq("sales_outcome", "lost");
                } else if (status === "reminder") {
                    query = query
                        .not("reminder_at", "is", null)
                        .neq("status", "closed");
                } else if (status === "cold") {
                    query = query.eq("sales_kind", KIND_COLD);
                }

                if (q) {
                    query = query.or(
                        `product_name.ilike.%${q}%,customer_name.ilike.%${q}%,customer_gstin.ilike.%${q}%`
                    );
                }

                query = (
                    status === "reminder"
                        ? query.order("reminder_at", {
                            ascending: true,
                        })
                        : query.order("last_activity_at", {
                            ascending: false,
                        })
                )
                    .order("id", {
                        ascending: true,
                    })
                    .range(offset, offset + limit - 1);

                const first = offset === 0;

                const [
                    list,
                    all,
                    open,
                    won,
                    lost,
                    rem,
                    cold,
                ] = await Promise.all([
                    query,
                    first ? count() : null,
                    first ? count().neq("status", "closed") : null,
                    first
                        ? count()
                            .eq("status", "closed")
                            .eq("sales_outcome", "won")
                        : null,
                    first
                        ? count()
                            .eq("status", "closed")
                            .eq("sales_outcome", "lost")
                        : null,
                    first
                        ? count()
                            .neq("status", "closed")
                            .not("reminder_at", "is", null)
                        : null,
                    first ? count().eq("sales_kind", KIND_COLD) : null,
                ]);

                if (list.error) throw list.error;

                const rows = list.data || [];
                const qCount = new Map();

                if (rows.length) {
                    const { data: qs, error: qErr } = await supabase
                        .from("sales_quotes")
                        .select("enquiry_id")
                        .in("enquiry_id", rows.map((r) => r.id));

                    if (qErr) throw qErr;

                    for (const x of qs || []) {
                        qCount.set(
                            x.enquiry_id,
                            (qCount.get(x.enquiry_id) || 0) + 1
                        );
                    }
                }

                const items = rows.map((r) =>
                    dtoOf(r, {
                        quotesCount: qCount.get(r.id) || 0,
                    })
                );

                const out = {
                    success: true,
                    items,
                    total: list.count ?? items.length,
                    hasMore: offset + items.length < (list.count ?? 0),
                };

                if (first) {
                    out.counts = {
                        all: all?.count || 0,
                        open: open?.count || 0,
                        won: won?.count || 0,
                        lost: lost?.count || 0,
                        reminder: rem?.count || 0,
                        cold: cold?.count || 0,
                    };
                }

                return out;
            }
        );

        res.json(body);
    } catch (e) {
        oops(res, e);
    }
}

// ---- products ------------------------------------------------------------------------------------------

function productItem(
    s,
    { unit, last, overrides, taggedId } = {}
) {
    const pack = Number(s.pack_size) > 0
        ? Number(s.pack_size)
        : 1;

    const master = Number(s.units_per_master_pack) > 0
        ? Number(s.units_per_master_pack)
        : 1;

    const list = Number(s.price) > 0
        ? round4(Number(s.price) / saleUnits(pack, master))
        : null;

    return {
        submissionId: s.id,
        productName: s.brand?.name || s.product_name,
        brandName: s.brand?.brand_name || s.brand_name || "",
        image: s.image || s.brand?.image || null,
        description: listingDescription(s),
        unit: s.unit,
        packSize: pack,
        masterPackSize: master,
        gstPercent: Number(s.gst_percent) || 0,
        moq: s.moq != null ? Number(s.moq) : null,
        listSalePrice: Number(s.price) > 0 ? Number(s.price) : null,
        listUnitPriceIncl: list,
        lastUnitPriceIncl: last?.get(s.id) ?? null,
        customUnitPriceIncl: overrides
            ? customUnitPriceOf(s, overrides.get(s.id))
            : null,
        unitMatches: unit ? sameUnit(s.unit, unit) : true,
        reason: listingProblem(s),
        url: productUrl(s.id),
        tagged: !!taggedId && s.id === taggedId,
    };
}

function productQuery(sellerId, q) {
    let query = supabase
        .from("seller_product_submissions")
        .select(SUB_SELECT, {
            count: "exact",
        })
        .eq("seller_id", sellerId)
        .neq("review_status", "rejected")
        .is("hs_generic_product_brands.deleted_at", null);

    if (q) {
        query = query.or(
            `product_name.ilike.%${q}%,brand_name.ilike.%${q}%`
        );
    }

    return query;
}

const CATALOG_IDS_MAX = 50;

const idsOf = (raw) =>
    [
        ...new Set(
            String(raw || "")
                .split(",")
                .map((s) => s.trim())
                .filter((s) => isUuid(s))
        ),
    ].slice(0, CATALOG_IDS_MAX);

// Customer prices for the product picker.
async function customerPriceOverlay({
    sellerId,
    ownerId,
    gstin,
    items,
}) {
    if (!gstin || !items.length) {
        return {
            items,
            buyer: null,
        };
    }

    const subIds = items.map((i) => i.submissionId);

    const lastP = (async () => {
        const m = new Map();

        try {
            const { data, error } = await supabase
                .from("sales_customer_prices")
                .select("submission_id, unit_price_incl")
                .eq("seller_id", sellerId)
                .eq("customer_gstin", gstin)
                .in("submission_id", subIds);

            if (error) throw error;

            for (const c of data || []) {
                m.set(c.submission_id, Number(c.unit_price_incl));
            }
        } catch (e) {
            console.error(
                "[sales] last prices lookup failed:",
                e?.message || e
            );
        }

        return m;
    })();

    const buyerP = (async () => {
        try {
            const b = await lookupBuyerCompany(gstin, ownerId);

            if (b && !b.self) {
                return {
                    buyer: {
                        onBbm: true,
                        name: b.name,
                    },
                    overrides: await fetchBuyerOverrides(
                        sellerId,
                        b.companyId,
                        subIds
                    ),
                };
            }

            return {
                buyer: {
                    onBbm: false,
                    name: null,
                    own: !!b?.self,
                },
                overrides: new Map(),
            };
        } catch (e) {
            console.error(
                "[sales] buyer lookup failed:",
                e?.message || e
            );

            return {
                buyer: null,
                overrides: new Map(),
            };
        }
    })();

    const [last, { buyer, overrides }] = await Promise.all([
        lastP,
        buyerP,
    ]);

    return {
        buyer,
        items: items.map((i) => {
            const ov = overrides.get(i.submissionId);

            return {
                ...i,

                lastUnitPriceIncl:
                    last.get(i.submissionId) ?? null,

                customUnitPriceIncl:
                    ov && i.listSalePrice
                        ? customUnitPriceOf(
                            {
                                price: i.listSalePrice,
                                pack_size: i.packSize,
                                units_per_master_pack: i.masterPackSize,
                            },
                            ov
                        )
                        : null,
            };
        }),
    };
}

// ---- GET /sales/threads/products -----------------------------------------------------------------------

export async function listCatalogProducts(req, res) {
    try {
        res.set("Cache-Control", "no-store");

        const { sellerId, ownerId } = getSalesActor(req);

        if (!sellerId) {
            return fail(res, 409, NO_SELLER);
        }

        const ids = idsOf(req.query.ids);

        const limit = ids.length
            ? CATALOG_IDS_MAX
            : Math.min(
                Math.max(parseInt(req.query.limit, 10) || 8, 1),
                50
            );

        const offset = Math.max(
            parseInt(req.query.offset, 10) || 0,
            0
        );

        const q = safeSearch(req.query.q);
        const g = cleanGstin(req.query.gstin);
        const gstin = GSTIN_RE.test(g) ? g : "";

        const base = await cached(
            `stc:${sellerId}:${hashKey([q, limit, offset, ids.join(",")])}`,
            20,
            async () => {
                let query = productQuery(sellerId, q);

                if (ids.length) {
                    query = query.in("id", ids);
                }

                const { data, count, error } = await query
                    .order("created_at", {
                        ascending: false,
                    })
                    .range(offset, offset + limit - 1);

                if (error) throw error;

                const items = (data || []).map((r) =>
                    productItem(flatSub(r))
                );

                return {
                    success: true,
                    items,
                    total: count ?? items.length,
                    hasMore: offset + items.length < (count ?? 0),
                    nextOffset: offset + items.length,
                };
            }
        );

        const { items, buyer } = await customerPriceOverlay({
            sellerId,
            ownerId,
            gstin,
            items: base.items,
        });

        res.json({
            ...base,
            items,
            buyer,
        });
    } catch (e) {
        oops(res, e);
    }
}

// ---- POST /sales/threads -------------------------------------------------------------------------------

export async function createThread(req, res) {
    try {
        const {
            actorId,
            actorName,
            ownerId,
            sellerId,
        } = getSalesActor(req);

        const b = req.body || {};
        const cold = b.kind === KIND_COLD;

        let customerName = str(b.customerName, 160);
        const gstin = cleanGstin(b.customerGstin);

        if (gstin && !GSTIN_RE.test(gstin)) {
            return fail(
                res,
                400,
                "Enter a valid 15-character GST number, or leave it empty."
            );
        }

        if (!customerName && !gstin) {
            return fail(
                res,
                400,
                "Enter the customer's GST number or company name."
            );
        }

        let contacts = [];

        if (Array.isArray(b.contacts) && b.contacts.length) {
            const p = parseContactList(
                b.contacts,
                CONTACTS_MAX
            );

            if (p.error) return fail(res, 400, p.error);

            contacts = p.list;
        } else {
            const lp = str(b.customerPhone, 20);
            const le = str(b.customerEmail, 200);

            if (lp || le) {
                const one = parseContact({
                    phone: lp,
                    email: le,
                });

                if (one.error) return fail(res, 400, one.error);

                contacts = [one];
            }
        }

        const { phone, email } = primaryOf(contacts);

        let product = null;
        let productName = null;
        let quantity = null;
        let unit = null;
        let note = "";

        if (cold) {
            note = str(b.note, NOTE_MAX);

            if (note.length < 2) {
                return fail(
                    res,
                    400,
                    "Write a short note about the call."
                );
            }
        } else {
            const r = await readProduct(b, sellerId);

            if (r.error) {
                return fail(
                    res,
                    r.error.status,
                    r.error.message
                );
            }

            ({
                product,
                productName,
                quantity,
                unit,
            } = r);
        }

        if (gstin) {
            const official = await canonicalCustomerName({
                sellerId,
                ownerId,
                gstin,
            });

            if (official) {
                customerName = official;
            }
        }

        const t0 = Date.now();
        const now = new Date(t0).toISOString();

        const { data, error } = await supabase
            .from("rfq_enquiries")
            .insert({
                buyer_id: ownerId,
                source: "sales",
                visibility: "private",
                status: "approved",
                published_at: now,

                product_name: productName,
                product_submission_id: product?.id || null,

                quantity,
                unit,
                pack_size: 1,

                specifications: cold
                    ? null
                    : (str(b.specifications, 2000) || null),

                accept_equivalent: false,
                images: [],
                supplier_locations: [],

                payment_terms: "flexible",
                consumption_type: "one_time",

                customer_name: customerName || null,
                customer_gstin: gstin || null,
                customer_phone: phone,
                customer_email: email,
                customer_contacts: contacts,

                // Original creator.
                created_by_actor_id: actorId,
                created_by_actor_name: actorName,

                // Initial last updater is also the creator.
                last_updated_by_actor_id: actorId,
                last_updated_by_actor_name: actorName,

                last_activity_at: now,
                last_entry_preview: cold
                    ? clipPreview(note, 0)
                    : "Enquiry created",

                ...(cold ? { sales_kind: KIND_COLD } : {}),
            })
            .select("*")
            .single();

        if (error) throw error;

        const entries = cold
            ? [
                {
                    enquiry_id: data.id,
                    author_id: actorId,
                    author_name: actorName,
                    kind: "system",
                    body: "Cold call logged",
                    created_at: now,
                },
                {
                    enquiry_id: data.id,
                    author_id: actorId,
                    author_name: actorName,
                    kind: "note",
                    body: note,
                    attachments: [],
                    created_at: new Date(t0 + 1).toISOString(),
                },
            ]
            : [
                {
                    enquiry_id: data.id,
                    author_id: actorId,
                    author_name: actorName,
                    kind: "system",
                    body: `Enquiry created: ${productName} · ${quantity} ${unit}`,
                },
            ];

        const { error: eErr } = await supabase
            .from("sales_thread_entries")
            .insert(entries);

        if (eErr) {
            console.error(
                "[sales threads] first entries failed:",
                eErr.message
            );
        }

        await notify(ownerId, actorId, data.id);

        res.json({
            success: true,
            thread: dtoOf(data, {
                quotesCount: 0,
            }),
            message: cold
                ? "Cold call logged."
                : "Enquiry created.",
        });
    } catch (e) {
        oops(res, e);
    }
}

// ---- GET /sales/threads/:id ---------------------------------------------------------------------------

export async function getThread(req, res) {
    try {
        res.set("Cache-Control", "no-store");

        const row = await loadOwnThread(req, res);
        if (!row) return;

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || ENTRY_PAGE, 1),
            ENTRY_PAGE_MAX
        );

        const before = req.query.before
            ? String(req.query.before)
            : "";

        const after = req.query.after
            ? String(req.query.after)
            : "";

        const beforeId = isUuid(req.query.beforeId)
            ? String(req.query.beforeId)
            : "";

        if (
            (before && !TS_RE.test(before)) ||
            (after && !TS_RE.test(after))
        ) {
            return fail(res, 400, "Invalid cursor.");
        }

        const ver = await getVer(`st:${row.id}`);

        const body = await cached(
            `sth:${row.id}:${ver}:${hashKey([limit, before, beforeId, after])}`,
            30,
            async () => {
                const quotesQ = supabase
                    .from("sales_quotes")
                    .select("id", {
                        count: "exact",
                        head: true,
                    })
                    .eq("enquiry_id", row.id);

                if (after) {
                    const [list, qc] = await Promise.all([
                        supabase
                            .from("sales_thread_entries")
                            .select("*")
                            .eq("enquiry_id", row.id)
                            .gte("created_at", after)
                            .order("created_at", {
                                ascending: true,
                            })
                            .order("id", {
                                ascending: true,
                            })
                            .limit(AFTER_MAX + 1),

                        quotesQ,
                    ]);

                    if (list.error) throw list.error;

                    const thread = dtoOf(row, {
                        quotesCount: qc.count || 0,
                    });

                    const data = list.data || [];

                    if (data.length > AFTER_MAX) {
                        return {
                            success: true,
                            thread,
                            entries: [],
                            reset: true,
                        };
                    }

                    return {
                        success: true,
                        thread,
                        entries: await hydrateEntries(data),
                    };
                }

                let q = supabase
                    .from("sales_thread_entries")
                    .select("*")
                    .eq("enquiry_id", row.id)
                    .order("created_at", {
                        ascending: false,
                    })
                    .order("id", {
                        ascending: false,
                    })
                    .limit(limit + 1);

                if (before) {
                    q = beforeId
                        ? q.or(
                            `created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`
                        )
                        : q.lt("created_at", before);
                }

                const [list, qc] = await Promise.all([
                    q,
                    quotesQ,
                ]);

                if (list.error) throw list.error;

                const data = list.data || [];
                const hasOlder = data.length > limit;
                const page = data.slice(0, limit).reverse();

                return {
                    success: true,
                    thread: dtoOf(row, {
                        quotesCount: qc.count || 0,
                    }),
                    entries: await hydrateEntries(page),
                    hasOlder,
                };
            }
        );

        res.json(body);
    } catch (e) {
        oops(res, e);
    }
}

// ---- PATCH /sales/threads/:id -------------------------------------------------------------------------

export async function updateThread(req, res) {
    try {
        const {
            actorId,
            actorName,
            ownerId,
            sellerId,
        } = getSalesActor(req);

        const row = await loadOwnThread(req, res);
        if (!row) return;

        const b = req.body || {};
        const patch = {};

        if ("customerName" in b) {
            patch.customer_name = str(b.customerName, 160) || null;
        }

        if ("customerGstin" in b) {
            const g = cleanGstin(b.customerGstin);

            if (g && !GSTIN_RE.test(g)) {
                return fail(
                    res,
                    400,
                    "Enter a valid 15-character GST number."
                );
            }

            patch.customer_gstin = g || null;
        }

        let newContacts = null;

        if ("contacts" in b) {
            const p = parseContactList(
                Array.isArray(b.contacts) ? b.contacts : [],
                CONTACTS_MAX
            );

            if (p.error) return fail(res, 400, p.error);

            newContacts = p.list;

            const pr = primaryOf(newContacts);

            patch.customer_contacts = newContacts;
            patch.customer_phone = pr.phone;
            patch.customer_email = pr.email;
        } else {
            if ("customerPhone" in b) {
                const raw = str(b.customerPhone, 20);
                const p = raw ? cleanPhone(raw) : "";

                if (raw && !p) {
                    return fail(
                        res,
                        400,
                        "Enter a valid 10-digit mobile number."
                    );
                }

                patch.customer_phone = p || null;
            }

            if ("customerEmail" in b) {
                const raw = str(b.customerEmail, 200);
                const e = raw ? cleanEmail(raw) : "";

                if (raw && !e) {
                    return fail(
                        res,
                        400,
                        "Enter a valid email address."
                    );
                }

                patch.customer_email = e || null;
            }
        }

        if (!Object.keys(patch).length) {
            return fail(res, 400, "Nothing to update.");
        }

        // A new GST number: use the official registered company name.
        if (
            patch.customer_gstin &&
            patch.customer_gstin !== row.customer_gstin
        ) {
            const official = await canonicalCustomerName({
                sellerId,
                ownerId,
                gstin: patch.customer_gstin,
            });

            if (official) {
                patch.customer_name = official;
            }
        }

        const name =
            "customer_name" in patch
                ? patch.customer_name
                : row.customer_name;

        const gst =
            "customer_gstin" in patch
                ? patch.customer_gstin
                : row.customer_gstin;

        if (!name && !gst) {
            return fail(
                res,
                400,
                "Keep either the company name or the GST number."
            );
        }

        const editedAt = new Date().toISOString();

        patch.last_activity_at = editedAt;
        patch.last_entry_preview = "Customer details updated";

        // Record the salesperson who performed the edit.
        patch.last_updated_by_actor_id = actorId;
        patch.last_updated_by_actor_name = actorName;

        const { data, error } = await supabase
            .from("rfq_enquiries")
            .update(patch)
            .eq("id", row.id)
            .select("*")
            .single();

        if (error) throw error;

        if (
            newContacts?.length &&
            data.customer_gstin &&
            sellerId
        ) {
            Promise.resolve(
                saveContactsForCustomer({
                    sellerId,
                    companyId: ownerId,
                    actorId,
                    gstin: data.customer_gstin,
                    contacts: newContacts,
                })
            ).catch(() => { });
        }

        const { error: auditError } = await supabase
            .from("sales_thread_entries")
            .insert({
                enquiry_id: row.id,
                author_id: actorId,
                author_name: actorName,
                kind: "system",
                body: "Customer details updated",
                created_at: editedAt,
            });

        if (auditError) {
            console.error(
                "[sales threads] customer edit audit failed:",
                auditError.message
            );
        }

        await notify(ownerId, actorId, row.id);

        res.json({
            success: true,
            thread: dtoOf(data),
        });
    } catch (e) {
        oops(res, e);
    }
}

// ---- PATCH /sales/threads/:id/product -----------------------------------------------------------------

export async function setThreadProduct(req, res) {
    try {
        const {
            actorId,
            actorName,
            ownerId,
            sellerId,
        } = getSalesActor(req);

        const row = await loadOwnThread(req, res);
        if (!row) return;

        if (row.product_name) {
            return fail(
                res,
                409,
                "This enquiry already has a product. It can't be changed."
            );
        }

        if (row.status === "closed") {
            return fail(
                res,
                409,
                "This enquiry is closed. Reopen it to add a product."
            );
        }

        const b = req.body || {};
        const r = await readProduct(b, sellerId);

        if (r.error) {
            return fail(
                res,
                r.error.status,
                r.error.message
            );
        }

        const {
            product,
            productName,
            quantity,
            unit,
        } = r;

        const specs = str(b.specifications, 2000);

        const body =
            `Product added: ${productName} · ${quantity} ${unit}`;

        const updatedAt = new Date().toISOString();

        // IMPORTANT:
        // Last updater fields belong on rfq_enquiries,
        // not sales_thread_entries.
        const patch = {
            product_name: productName,
            product_submission_id: product?.id || null,

            quantity,
            unit,
            pack_size: 1,

            last_activity_at: updatedAt,
            last_entry_preview: body,
            reminder_at: null,

            last_updated_by_actor_id: actorId,
            last_updated_by_actor_name: actorName,

            ...(specs
                ? { specifications: specs }
                : {}),
        };

        // Race-safe: two quick taps cannot add two products.
        const { data, error } = await supabase
            .from("rfq_enquiries")
            .update(patch)
            .eq("id", row.id)
            .is("product_name", null)
            .select("*")
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            return fail(
                res,
                409,
                "A product was just added to this enquiry. Refresh to see it."
            );
        }

        const {
            data: entryRow,
            error: eErr,
        } = await supabase
            .from("sales_thread_entries")
            .insert({
                enquiry_id: row.id,
                author_id: actorId,
                author_name: actorName,
                kind: "system",
                body,
                created_at: updatedAt,
            })
            .select("*")
            .single();

        if (eErr) throw eErr;

        await notify(ownerId, actorId, row.id);

        const [entry] = await hydrateEntries([entryRow]);

        res.json({
            success: true,
            thread: dtoOf(data, {
                quotesCount: 0,
            }),
            entry,
            message: "Product added.",
        });
    } catch (e) {
        oops(res, e);
    }
}

// ---- PATCH /sales/threads/:id/status ------------------------------------------------------------------

export async function setThreadStatus(req, res) {
    try {
        const {
            actorId,
            actorName,
            ownerId,
        } = getSalesActor(req);

        const row = await loadOwnThread(req, res);
        if (!row) return;

        const next = req.body?.status;

        if (!["open", "won", "lost"].includes(next)) {
            return fail(res, 400, "Invalid status.");
        }

        const dbStatus =
            next === "open"
                ? "approved"
                : "closed";

        const outcome =
            next === "open"
                ? null
                : next;

        if (
            row.status === dbStatus &&
            (row.sales_outcome || null) === outcome
        ) {
            return res.json({
                success: true,
                thread: dtoOf(row),
            });
        }

        const body =
            next === "won"
                ? "Enquiry marked as won"
                : next === "lost"
                    ? "Enquiry marked as lost"
                    : "Enquiry reopened";

        const { data, error } = await supabase
            .from("rfq_enquiries")
            .update({
                status: dbStatus,
                sales_outcome: outcome,
                reminder_at: null,
                last_activity_at: new Date().toISOString(),
                last_updated_by_actor_id: actorId,
                last_updated_by_actor_name: actorName,
                last_entry_preview: body,
            })
            .eq("id", row.id)
            .select("*")
            .single();

        if (error) throw error;

        const { error: entryError } = await supabase
            .from("sales_thread_entries")
            .insert({
                enquiry_id: row.id,
                author_id: actorId,
                author_name: actorName,
                kind: "system",
                body,
            });

        if (entryError) {
            console.error(
                "[sales threads] status audit failed:",
                entryError.message
            );
        }

        await notify(ownerId, actorId, row.id);

        res.json({
            success: true,
            thread: dtoOf(data),
        });
    } catch (e) {
        oops(res, e);
    }
}

// ---- PATCH /sales/threads/:id/reminder ---------------------------------------------------------------

export async function setReminder(req, res) {
    try {
        const {
            actorId,
            actorName,
            ownerId,
        } = getSalesActor(req);

        const row = await loadOwnThread(req, res);
        if (!row) return;

        if (row.status === "closed") {
            return fail(
                res,
                409,
                "Reopen this enquiry to set a reminder."
            );
        }

        const raw = req.body?.reminderAt;
        const now = Date.now();

        // Cancel reminder.
        if (raw === null) {
            if (!row.reminder_at) {
                return res.json({
                    success: true,
                    thread: dtoOf(row),
                });
            }

            const body = "Reminder removed";
            const updatedAt = new Date().toISOString();

            const { data, error } = await supabase
                .from("rfq_enquiries")
                .update({
                    reminder_at: null,
                    last_activity_at: updatedAt,
                    last_entry_preview: body,

                    last_updated_by_actor_id: actorId,
                    last_updated_by_actor_name: actorName,
                })
                .eq("id", row.id)
                .select("*")
                .single();

            if (error) throw error;

            const { error: entryError } = await supabase
                .from("sales_thread_entries")
                .insert({
                    enquiry_id: row.id,
                    author_id: actorId,
                    author_name: actorName,
                    kind: "system",
                    body,
                    created_at: updatedAt,
                });

            if (entryError) {
                console.error(
                    "[sales threads] reminder audit failed:",
                    entryError.message
                );
            }

            await notify(ownerId, actorId, row.id);

            return res.json({
                success: true,
                thread: dtoOf(data),
            });
        }

        // Set / change reminder.
        if (
            typeof raw !== "string" ||
            !TS_RE.test(raw)
        ) {
            return fail(
                res,
                400,
                "Choose a valid date and time."
            );
        }

        const at = new Date(raw).getTime();

        if (Number.isNaN(at)) {
            return fail(
                res,
                400,
                "Choose a valid date and time."
            );
        }

        if (at <= now) {
            return fail(
                res,
                400,
                "The reminder must be set for a future date and time."
            );
        }

        if (at > now + REMINDER_MAX_MS) {
            return fail(
                res,
                400,
                "Reminders can be set up to a year ahead."
            );
        }

        const iso = new Date(at).toISOString();

        const body = `Reminder set for ${remText(iso)}`;
        const updatedAt = new Date().toISOString();

        const { data, error } = await supabase
            .from("rfq_enquiries")
            .update({
                reminder_at: iso,
                last_activity_at: updatedAt,
                last_entry_preview: body,

                last_updated_by_actor_id: actorId,
                last_updated_by_actor_name: actorName,
            })
            .eq("id", row.id)
            .select("*")
            .single();

        if (error) throw error;

        const { error: entryError } = await supabase
            .from("sales_thread_entries")
            .insert({
                enquiry_id: row.id,
                author_id: actorId,
                author_name: actorName,
                kind: "system",
                body,
                created_at: updatedAt,
            });

        if (entryError) {
            console.error(
                "[sales threads] reminder audit failed:",
                entryError.message
            );
        }

        await notify(ownerId, actorId, row.id);

        res.json({
            success: true,
            thread: dtoOf(data),
        });
    } catch (e) {
        oops(res, e);
    }
}

// ---- POST /sales/threads/:id/attachments/sign -------------------------------------------------------

export async function signAttachment(req, res) {
    try {
        const row = await loadOwnThread(req, res);
        if (!row) return;

        const name = str(req.body?.name, 150);
        const size = Number(req.body?.size);
        const ext = (name.split(".").pop() || "").toLowerCase();

        if (!name || !ALLOWED_EXT.has(ext)) {
            return fail(
                res,
                400,
                "This file type isn't supported. Use photos, PDF, Word, Excel, PowerPoint, CSV or text files."
            );
        }

        if (!(size > 0) || size > MAX_BYTES) {
            return fail(res, 400, "Files can be up to 15 MB.");
        }

        const path = `${row.id}/${randomUUID()}.${ext}`;

        const { data, error } = await supabase
            .storage
            .from(BUCKET)
            .createSignedUploadUrl(path);

        if (error) throw error;

        res.json({
            success: true,
            uploadUrl: data.signedUrl,
            path,
        });
    } catch (e) {
        oops(res, e);
    }
}

function cleanAttachments(list, enquiryId) {
    if (list == null) return [];

    if (!Array.isArray(list) || list.length > MAX_FILES) {
        return null;
    }

    const out = [];

    for (const a of list) {
        const path =
            typeof a?.path === "string"
                ? a.path
                : "";

        if (
            !path.startsWith(`${enquiryId}/`) ||
            path.includes("..") ||
            path.length > 200
        ) {
            return null;
        }

        out.push({
            path,
            name: str(a.name, 150) || "file",
            type: str(a.type, 100),
            size: Math.max(
                0,
                Math.min(Number(a.size) || 0, MAX_BYTES)
            ),
        });
    }

    return out;
}

// ---- POST /sales/threads/:id/entries ------------------------------------------------------------------

export async function addEntry(req, res) {
    try {
        const {
            actorId,
            actorName,
            ownerId,
        } = getSalesActor(req);

        const row = await loadOwnThread(req, res);
        if (!row) return;

        if (row.status === "closed") {
            return fail(
                res,
                409,
                "This enquiry is closed. Reopen it to add updates."
            );
        }

        const body = str(req.body?.body, NOTE_MAX);

        const attachments = cleanAttachments(
            req.body?.attachments,
            row.id
        );

        if (attachments === null) {
            return fail(res, 400, "Attachments are invalid.");
        }

        if (!body && !attachments.length) {
            return fail(
                res,
                400,
                "Write an update or attach a file."
            );
        }

        const mentions = await cleanMentions(
            req.body?.mentions,
            row,
            actorId
        );

        const { data, error } = await supabase
            .from("sales_thread_entries")
            .insert({
                enquiry_id: row.id,
                author_id: actorId,
                author_name: actorName,
                kind: "note",
                body,
                attachments,
                mentions,
            })
            .select("*")
            .single();

        if (error) throw error;

        // Update latest activity and latest updater.
        await touch(
            row.id,
            clipPreview(body, attachments.length),
            actorId,
            actorName
        );

        await notify(ownerId, actorId, row.id);

        const [entry] = await hydrateEntries([data]);

        res.json({
            success: true,
            entry,
        });

        afterMessage({
            row,
            companyId: ownerId,
            entry,
            senderId: actorId,
            senderName: actorName,
            preview: clipPreview(body, attachments.length),
            touch: false,
        }).catch((e) => {
            console.error(
                "[sales threads] chat fan-out failed:",
                e?.message || e
            );
        });
    } catch (e) {
        oops(res, e);
    }
}

// ---- GET /sales/threads/:id/products -----------------------------------------------------------------

export async function listQuoteProducts(req, res) {
    try {
        res.set("Cache-Control", "no-store");

        const {
            sellerId,
            ownerId,
        } = getSalesActor(req);

        if (!sellerId) {
            return fail(res, 409, NO_SELLER);
        }

        const row = await loadOwnThread(req, res);
        if (!row) return;

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 20, 1),
            50
        );

        const offset = Math.max(
            parseInt(req.query.offset, 10) || 0,
            0
        );

        const q = safeSearch(req.query.q);
        const taggedId = row.product_submission_id || null;

        const ver = await getVer(`st:${row.id}`);

        const body = await cached(
            `stp:${sellerId}:${row.id}:${ver}:${hashKey([q, limit, offset])}`,
            20,
            async () => {
                const {
                    data,
                    count,
                    error,
                } = await productQuery(sellerId, q)
                    .order("created_at", {
                        ascending: false,
                    })
                    .range(offset, offset + limit - 1);

                if (error) throw error;

                const dbRows = (data || []).length;
                const subs = (data || []).map(flatSub);

                if (taggedId && offset === 0 && !q) {
                    const at = subs.findIndex(
                        (s) => s.id === taggedId
                    );

                    if (at > 0) {
                        subs.unshift(...subs.splice(at, 1));
                    } else if (at < 0) {
                        const { data: t, error: tErr } = await supabase
                            .from("seller_product_submissions")
                            .select(SUB_SELECT)
                            .eq("seller_id", sellerId)
                            .eq("id", taggedId)
                            .neq("review_status", "rejected")
                            .is("hs_generic_product_brands.deleted_at", null)
                            .maybeSingle();

                        if (tErr) throw tErr;

                        if (t) subs.unshift(flatSub(t));
                    }
                }

                const subIds = subs.map((s) => s.id);

                const lastP = (async () => {
                    const m = new Map();

                    if (!row.customer_gstin || !subIds.length) {
                        return m;
                    }

                    const { data: cp, error: cErr } = await supabase
                        .from("sales_customer_prices")
                        .select("submission_id, unit_price_incl")
                        .eq("seller_id", sellerId)
                        .eq("customer_gstin", row.customer_gstin)
                        .in("submission_id", subIds);

                    if (cErr) throw cErr;

                    for (const c of cp || []) {
                        m.set(
                            c.submission_id,
                            Number(c.unit_price_incl)
                        );
                    }

                    return m;
                })();

                const buyerP = (async () => {
                    if (!row.customer_gstin) {
                        return {
                            buyer: null,
                            overrides: new Map(),
                        };
                    }

                    try {
                        const b = await findBuyerCompanyByGstin(
                            row.customer_gstin,
                            ownerId
                        );

                        if (b && !b.self) {
                            return {
                                buyer: {
                                    onBbm: true,
                                    name: b.name,
                                },
                                overrides: await fetchBuyerOverrides(
                                    sellerId,
                                    b.companyId,
                                    subIds
                                ),
                            };
                        }

                        return {
                            buyer: {
                                onBbm: false,
                                name: null,
                                own: !!b?.self,
                            },
                            overrides: new Map(),
                        };
                    } catch (e) {
                        console.error(
                            "[sales] buyer lookup failed:",
                            e?.message || e
                        );

                        return {
                            buyer: null,
                            overrides: new Map(),
                        };
                    }
                })();

                const [
                    last,
                    { buyer, overrides },
                ] = await Promise.all([
                    lastP,
                    buyerP,
                ]);

                const items = subs.map((s) =>
                    productItem(s, {
                        unit: row.unit,
                        last,
                        overrides,
                        taggedId,
                    })
                );

                return {
                    success: true,
                    items,
                    buyer,
                    total: count ?? items.length,
                    hasMore: offset + dbRows < (count ?? 0),
                    nextOffset: offset + dbRows,
                };
            }
        );

        res.json(body);
    } catch (e) {
        oops(res, e);
    }
}

// ---- delivery ------------------------------------------------------------------------------------------

async function deliver({
    quote,
    thread,
    targets,
    sellerName,
    actorId,
    actorName,
    actorEmail,
    channels,
    resend = false,
    only = {},
}) {
    const items = quote.items;
    const out = {};

    const keyOf = {
        whatsapp: "phone",
        email: "email",
    };

    const run = async (channel, one) => {
        const key = keyOf[channel];
        const again = only[channel]?.failedTo;

        const list = targets.filter(
            (t) =>
                t[key] &&
                (!again?.length || again.includes(t[key]))
        );

        if (!list.length) return;

        const at = new Date().toISOString();

        const results = await Promise.all(
            list.map(async (t) => {
                try {
                    await one(t);
                    return { ok: true };
                } catch (e) {
                    return {
                        ok: false,
                        to: t[key],
                        error: errText(e),
                    };
                }
            })
        );

        const bad = results.filter((r) => !r.ok);

        out[channel] = bad.length
            ? {
                status: "failed",
                error: bad[0].error,
                failedTo: bad.map((r) => r.to),
                sent: list.length - bad.length,
                total: list.length,
                at,
            }
            : {
                status: "sent",
                sent: list.length,
                total: list.length,
                at,
            };
    };

    const tasks = [];

    if (channels.includes("whatsapp")) {
        tasks.push(
            run("whatsapp", async (t) => {
                const r = await sendSalesQuotationWhatsApp({
                    to: t.phone,
                    customerName: t.name || thread.customer_name || "there",
                    sellerName,
                    enquiryProduct: thread.product_name,
                    itemsLine: whatsappItemsLine(items),
                    total: inr(quote.total),
                    validUntil: validText(quote.valid_until),
                    closing: quote.note ||
                        "Please get in touch with us to confirm your order.",
                });

                if (!r.success) {
                    throw new Error(
                        r.skipped
                            ? "WhatsApp isn't configured or the number is invalid."
                            : errText(r.error)
                    );
                }
            })
        );
    }

    if (channels.includes("email")) {
        tasks.push(
            run("email", async (t) => {
                await sendSalesQuotationEmail({
                    to: t.email,
                    customerName: t.name || thread.customer_name || "there",
                    sellerName,
                    salespersonName: actorName,
                    enquiryProduct: thread.product_name,
                    items,
                    subtotal: quote.subtotal,
                    gstAmount: quote.gst_amount,
                    total: quote.total,
                    validUntil: validText(quote.valid_until),
                    note: quote.note || "",
                    replyTo: actorEmail || undefined,
                });
            })
        );
    }

    await Promise.all(tasks);

    void (async () => {
        const me = await loadSalesperson(actorId);

        const salesperson = me
            ? { ...me, email: me.email || actorEmail }
            : (
                actorEmail
                    ? { name: actorName, email: actorEmail }
                    : null
            );

        await sendSalespersonCopy({
            salesperson,
            title: resend
                ? "Quotation resent"
                : "Quotation sent",

            customerName: thread.customer_name,

            customerPhone: channels.includes("whatsapp")
                ? targets.map((t) => t.phone)
                    .filter(Boolean)
                    .join(", ")
                : "",

            customerEmail: channels.includes("email")
                ? targets.map((t) => t.email)
                    .filter(Boolean)
                    .join(", ")
                : "",

            facts: [
                ["Enquiry", thread.product_name],
                ["Valid until", validText(quote.valid_until)],
                ["Your note", quote.note],
            ],

            items: items.map((i) => ({
                name: `${i.productName}${i.brandName ? ` (${i.brandName})` : ""}`,
                detail: `${i.quantity} ${i.unit} × ${inr(i.unitPriceIncl)}`,
                amount: inr(i.totalIncl),
            })),

            total: inr(quote.total),

            delivery: Object.entries(out).map(([ch, d]) => ({
                channel: ch === "whatsapp" ? "WhatsApp" : "Email",
                ok: d.status === "sent",
            })),

            note: Object.values(out).some(
                (d) => d.status !== "sent"
            )
                ? "Some channels failed. Retry them from the enquiry thread."
                : channels.includes("email")
                    ? "Customer email replies come straight to you. Set a follow-up reminder on this enquiry."
                    : "Set a follow-up reminder on this enquiry so the quote doesn't go cold.",
        });
    })().catch((e) => {
        console.error(
            "[sales threads] salesperson copy failed:",
            e?.message || e
        );
    });

    return out;
}

const sellerNameOf = (sellerId) =>
    cached(
        `sn:${sellerId}`,
        600,
        async () => {
            const { data } = await supabase
                .from("seller_profiles")
                .select("display_name")
                .eq("id", sellerId)
                .maybeSingle();

            return data?.display_name || "Our team";
        }
    );

function contactCheck(thread, channels) {
    if (!channels.length) {
        return "Choose WhatsApp, email or both.";
    }

    if (
        channels.includes("whatsapp") &&
        !thread.customer_phone
    ) {
        return "Add the customer's mobile number to send on WhatsApp.";
    }

    if (
        channels.includes("email") &&
        !thread.customer_email
    ) {
        return "Add the customer's email address to send by email.";
    }

    return null;
}

const cleanChannels = (list) =>
    [
        ...new Set(
            (Array.isArray(list) ? list : [])
                .filter((c) => CHANNELS.includes(c))
        ),
    ];

// ---- POST /sales/threads/:id/quotes --------------------------------------------------------------------

export async function sendQuote(req, res) {
    try {
        const {
            actorId,
            actorName,
            actorEmail,
            ownerId,
            sellerId,
        } = getSalesActor(req);

        const loaded = await loadOwnThread(req, res);
        if (!loaded) return;

        if (loaded.status === "closed") {
            return fail(
                res,
                409,
                "This enquiry is closed. Reopen it to send a quotation."
            );
        }

        if (!loaded.product_name) {
            return fail(
                res,
                409,
                "Add the product to this enquiry before sending a quotation."
            );
        }

        if (!sellerId) {
            return fail(res, 409, NO_SELLER);
        }

        const b = req.body || {};

        if (!loaded.customer_gstin) {
            return fail(
                res,
                400,
                "Add the customer's GST number before sending a quotation."
            );
        }

        let targets;

        if (
            Array.isArray(b.recipients) &&
            b.recipients.length
        ) {
            const p = parseContactList(
                b.recipients,
                CONTACTS_MAX
            );

            if (p.error) return fail(res, 400, p.error);

            targets = p.list;
        } else {
            targets = targetsOf(loaded);
        }

        if (!targets.length) {
            return fail(
                res,
                400,
                "Choose at least one contact (a mobile number or an email) to send the quotation to."
            );
        }

        const channels = CHANNELS.filter(
            (c) =>
                targets.some((t) =>
                    c === "whatsapp"
                        ? t.phone
                        : t.email
                )
        );

        const validityDays = VALIDITY.includes(
            Number(b.validityDays)
        )
            ? Number(b.validityDays)
            : 7;

        const raw = Array.isArray(b.items)
            ? b.items
            : [];

        if (!raw.length || raw.length > 20) {
            return fail(
                res,
                400,
                "Add between 1 and 20 products."
            );
        }

        const ids = raw.map((i) => i?.submissionId);

        if (
            ids.some((id) => !isUuid(id)) ||
            new Set(ids).size !== ids.length
        ) {
            return fail(
                res,
                400,
                "The product list is invalid."
            );
        }

        // Always read products fresh here.
        const {
            data: subs,
            error: sErr,
        } = await supabase
            .from("seller_product_submissions")
            .select(SUB_SELECT)
            .eq("seller_id", sellerId)
            .in("id", ids)
            .is("hs_generic_product_brands.deleted_at", null);

        if (sErr) throw sErr;

        const byId = new Map(
            (subs || []).map((r) => {
                const s = flatSub(r);
                return [s.id, s];
            })
        );

        const items = [];

        for (const r of raw) {
            const s = byId.get(r.submissionId);

            if (!s) {
                return fail(
                    res,
                    404,
                    "One of the products is not in your company's catalog."
                );
            }

            const why = listingProblem(s);

            if (why) {
                return fail(
                    res,
                    409,
                    `"${s.brand?.name || s.product_name}" can't be quoted right now (${why.toLowerCase()}).`
                );
            }

            const price = Number(r.price);
            const quantity = Number(r.quantity);

            if (!(price > 0) || price > 1e7) {
                return fail(
                    res,
                    400,
                    `Enter a valid price for ${s.brand?.name || s.product_name}.`
                );
            }

            if (!(quantity > 0) || quantity > 1e9) {
                return fail(
                    res,
                    400,
                    `Enter a valid quantity for ${s.brand?.name || s.product_name}.`
                );
            }

            const gstPercent = Number(s.gst_percent) || 0;
            const gstInclusive = r.gstInclusive !== false;

            items.push({
                submissionId: s.id,
                productName: s.brand?.name || s.product_name,
                brandName: s.brand?.brand_name || s.brand_name || "",
                description: listingDescription(s),
                image: s.image || s.brand?.image || null,
                unit: s.unit,

                quantity,
                gstPercent,
                gstInclusive,
                enteredPrice: price,

                ...priceLine({
                    price,
                    gstInclusive,
                    gstPercent,
                    quantity,
                }),

                url: productUrl(s.id),
                setCustomPrice: r.setCustomPrice === true,
            });
        }

        const companyId =
            req.sales?.companyId ?? ownerId;

        const saveList = parseContactList([
            ...rowContacts(loaded),
            ...targets,
        ]).list;

        const ensured = await ensureCustomer({
            sellerId,
            companyId,
            actorId,
            teamId: req.sales?.teamId,
            thread: loaded,
            contacts: saveList,
        });

        let thread = loaded;

        if (
            ensured.name &&
            ensured.name !== loaded.customer_name
        ) {
            thread = {
                ...loaded,
                customer_name: ensured.name,
            };

            // Record who changed the canonical customer name.
            const { error: customerNameError } = await supabase
                .from("rfq_enquiries")
                .update({
                    customer_name: ensured.name,
                    last_updated_by_actor_id: actorId,
                    last_updated_by_actor_name: actorName,
                })
                .eq("id", loaded.id);

            if (customerNameError) {
                throw customerNameError;
            }
        }

        const total = items.reduce(
            (a, i) => a + i.totalIncl,
            0
        );

        const subtotal = items.reduce(
            (a, i) => a + i.taxable,
            0
        );

        const validUntil = NO_EXPIRY;

        const {
            data: quote,
            error: qErr,
        } = await supabase
            .from("sales_quotes")
            .insert({
                enquiry_id: thread.id,
                seller_id: sellerId,
                actor_id: actorId,
                actor_name: actorName,

                customer_name: thread.customer_name,
                customer_gstin: thread.customer_gstin,

                customer_phone: primaryOf(targets).phone,
                customer_email: primaryOf(targets).email,
                recipients: targets,

                items,
                subtotal: Math.round(subtotal * 100) / 100,
                total: Math.round(total * 100) / 100,

                gst_amount: Math.round(
                    (total - subtotal) * 100
                ) / 100,

                note: str(b.note, 500) || null,
                validity_days: validityDays,
                valid_until: validUntil,
                channels,
            })
            .select("*")
            .single();

        if (qErr) throw qErr;

        // Remember this price for this customer's GST number.
        const { error: pErr } = await supabase
            .from("sales_customer_prices")
            .upsert(
                items.map((i) => ({
                    seller_id: sellerId,
                    customer_gstin: thread.customer_gstin,
                    submission_id: i.submissionId,
                    unit_price_incl: i.unitPriceIncl,
                    updated_by: actorId,
                    updated_at: new Date().toISOString(),
                })),
                {
                    onConflict: "seller_id,customer_gstin,submission_id",
                }
            );

        if (pErr) {
            console.error(
                "[sales] customer price save failed:",
                pErr.message
            );
        }

        const customPricing = await syncQuoteCustomPrices({
            sellerId,
            ownerId,
            gstin: thread.customer_gstin,
            items,
            subsById: byId,
        });

        if (
            customPricing.status === "done" &&
            (
                customPricing.applied.length ||
                customPricing.removed.length
            )
        ) {
            try {
                await logActivity({
                    teamId: req.sales?.teamId,
                    actorId,
                    actorRole: "member",
                    category: "sales",
                    action: "sales.quote_custom_price",

                    label:
                        `Set quoted prices for ${customPricing.buyerName || thread.customer_name || "a buyer"} (${customPricing.applied.length} product${customPricing.applied.length === 1 ? "" : "s"})`,

                    entityType: "rfq",
                    entityId: thread.id,

                    meta: {
                        link: "/sell/customers",
                        quoteId: quote.id,
                    },
                });
            } catch { }
        }

        const {
            data: entryRow,
            error: eErr,
        } = await supabase
            .from("sales_thread_entries")
            .insert({
                enquiry_id: thread.id,
                author_id: actorId,
                author_name: actorName,
                kind: "quote",
                quote_id: quote.id,
                body: `Quotation sent · ${inr(quote.total)}`,
            })
            .select("*")
            .single();

        if (eErr) throw eErr;

        const delivery = await deliver({
            quote,
            thread,
            targets,
            sellerName: await sellerNameOf(sellerId),
            actorId,
            actorName,
            actorEmail,
            channels,
        });

        const {
            data: done,
        } = await supabase
            .from("sales_quotes")
            .update({ delivery })
            .eq("id", quote.id)
            .select("*")
            .single();

        // Record the salesperson who sent the quotation.
        await touch(
            thread.id,
            `Quotation sent · ${inr(quote.total)}`,
            actorId,
            actorName
        );

        await notify(ownerId, actorId, thread.id);

        const okCount = Object.values(delivery)
            .filter((d) => d.status === "sent")
            .length;

        res.json({
            success: true,
            delivery,
            customPricing,

            customerAdded:
                ensured.status === "added"
                    ? (
                        ensured.name ||
                        thread.customer_name ||
                        "The customer"
                    )
                    : null,

            quote: quoteDto(
                done || { ...quote, delivery }
            ),

            entry: entryDto(
                entryRow,
                quoteDto(done || { ...quote, delivery })
            ),

            message:
                okCount === channels.length
                    ? "Quotation sent."
                    : okCount
                        ? "Quotation sent on some channels. Retry the others from the thread."
                        : "Quotation saved, but it couldn't be delivered. Retry from the thread.",
        });
    } catch (e) {
        oops(res, e);
    }
}

// ---- POST /sales/threads/:id/quotes/:quoteId/resend ----------------------------------------------------

export async function resendQuote(req, res) {
    try {
        const {
            actorId,
            actorName,
            actorEmail,
            ownerId,
            sellerId,
        } = getSalesActor(req);

        const thread = await loadOwnThread(req, res);
        if (!thread) return;

        if (!isUuid(req.params.quoteId)) {
            return fail(res, 404, "Quotation not found.");
        }

        const {
            data: quote,
            error,
        } = await supabase
            .from("sales_quotes")
            .select("*")
            .eq("id", req.params.quoteId)
            .eq("enquiry_id", thread.id)
            .maybeSingle();

        if (error) throw error;

        if (!quote) {
            return fail(res, 404, "Quotation not found.");
        }

        if (
            new Date(quote.valid_until).getTime() <=
            Date.now()
        ) {
            return fail(
                res,
                409,
                "This quotation has expired. Send a new one."
            );
        }

        const channels = cleanChannels(req.body?.channels);

        if (!channels.length) {
            return fail(
                res,
                400,
                "Choose WhatsApp, email or both."
            );
        }

        const targets =
            Array.isArray(quote.recipients) &&
                quote.recipients.length
                ? quote.recipients.map((c) => ({
                    name: c?.name || "",
                    phone: c?.phone || "",
                    email: c?.email || "",
                }))
                : targetsOf(thread);

        const lacking = channels.find(
            (c) =>
                !targets.some((t) =>
                    c === "whatsapp"
                        ? t.phone
                        : t.email
                )
        );

        if (lacking) {
            return fail(
                res,
                400,
                lacking === "whatsapp"
                    ? "No contact on this quotation has a mobile number."
                    : "No contact on this quotation has an email address."
            );
        }

        const sent = await deliver({
            quote,
            thread,
            targets,
            sellerName: await sellerNameOf(sellerId),
            actorId,
            actorName,
            actorEmail,
            channels,
            resend: true,
            only: quote.delivery || {},
        });

        const delivery = {
            ...(quote.delivery || {}),
            ...sent,
        };

        const merged = [
            ...new Set([
                ...(quote.channels || []),
                ...channels,
            ]),
        ];

        const {
            data: upd,
            error: uErr,
        } = await supabase
            .from("sales_quotes")
            .update({
                delivery,
                channels: merged,
            })
            .eq("id", quote.id)
            .select("*")
            .single();

        if (uErr) throw uErr;

        const resendAt = new Date().toISOString();

        const { error: auditError } = await supabase
            .from("sales_thread_entries")
            .insert({
                enquiry_id: thread.id,
                author_id: actorId,
                author_name: actorName,
                kind: "system",
                body: "Quotation resent",
                created_at: resendAt,
            });

        if (auditError) {
            console.error(
                "[sales threads] quotation resend audit failed:",
                auditError.message
            );
        }

        await touch(
            thread.id,
            "Quotation resent",
            actorId,
            actorName
        );

        await notify(ownerId, actorId, thread.id);

        const failed = Object.values(sent)
            .some((d) => d.status !== "sent");

        res.json({
            success: true,
            quote: quoteDto(upd),
            message: failed
                ? "Couldn't deliver on every channel."
                : "Quotation sent again.",
        });
    } catch (e) {
        oops(res, e);
    }
}
