// services/orderBookNotify.service.js
//
// Customer-facing notifications for Order Book.
//
//   notifyOrderPlaced:    order received                      (email + WhatsApp)
//   notifyOrderProcessed: order confirmed / processing        (email + WhatsApp)
//   notifyOrderStatus:    single entry point used by the controller after EVERY status change;
//                         processed -> notifyOrderProcessed, shipped / completed / cancelled -> notifyStatusChange
//
// WHO GETS THEM: the contacts the salesperson chose when punching the order (order_book_orders.recipients).
// Each chosen contact gets an email (if they have one) and a WhatsApp (if they have a mobile number), addressed to
// the contact by name when it is known. Older orders without recipients use customer_phone / customer_email.
// The salesperson who created the order also gets a copy with the delivery status of every message.
//
// LOGGING: every notification run ends with ONE summary line, e.g.
//   [order book] OB-1042 shipped: 3/4 delivered | FAILED: WhatsApp (Ravi)
// Failures use console.error so they stand out; per-message detail comes from whatsapp.service.js.
//
// Notification failures must not break order operations: nothing here throws.
// Seller names come from seller_profiles.display_name, seller shop links from seller_profiles.shop_slug.
// Billing addresses are normalized to avoid duplicate locations.

import { supabase } from "../config/supabase.js";

import {
    sendOrderProcessedEmail,
    sendOrderPlacedEmail,
    sendOrderStatusEmail,
} from "./mail.service.js";

import {
    sendOrderProcessedWhatsApp,
    sendOrderPlacedWhatsApp,
    sendOrderShippedWhatsApp,
    sendOrderCompletedWhatsApp,
    sendOrderCancelledWhatsApp,
} from "./whatsapp.service.js";

import {
    sendSalespersonCopy, loadSalesperson, creatorIdOf,
} from "./salespersonCopy.service.js";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const SITE_URL = (
    process.env.FRONTEND_URL ||
    process.env.SITE_URL ||
    "https://bbm.business"
).replace(/\/+$/, "");

const SELLERS_TABLE = "seller_profiles";
const SLUG_KEYS = ["shop_slug", "slug", "store_slug"];
const NAME_KEYS = ["display_name", "shop_name", "store_name", "business_name", "company_name", "name"];

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

// Runs one channel, never throws, reports whether it was delivered.
const track = async (channel, promise) => {
    try {
        const r = await promise;
        return { channel, ok: r?.success !== false };
    } catch (error) {
        console.error(`[order book] ${channel} notification failed:`, error?.message || error);
        return { channel, ok: false };
    }
};

// One summary line per notification run, so a missed message is easy to spot in the backend logs.
function logDelivery(row, label, delivery) {
    const failed = delivery.filter((d) => !d.ok);
    const line = `[order book] ${row.order_no} ${label}: ${delivery.length - failed.length}/${delivery.length} delivered`;
    if (failed.length) console.error(`${line} | FAILED: ${failed.map((f) => f.channel).join(", ")}`);
    else console.log(line);
}

// Salesperson(s) who should get the copy: the creator, plus whoever acted if different.
async function copyRecipients(row, actorId) {
    const ids = [...new Set([creatorIdOf(row), actorId].filter(Boolean))];
    const people = await Promise.all(ids.map(loadSalesperson));
    return people.filter(Boolean);
}

const firstOf = (obj, keys) => {
    for (const key of keys) {
        const value = obj?.[key];
        if (value != null && String(value).trim()) return String(value).trim();
    }
    return "";
};

const inr = (value, max = 2) =>
    "₹" + Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: max });

const qtyFmt = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 4 });

const dateFmt = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};

// -----------------------------------------------------------------------------
// Who is messaged
// -----------------------------------------------------------------------------

/**
 * The contacts that get this order's updates: [{ name, phone, email }].
 * Uses the recipients the salesperson chose; older orders fall back to the single customer phone / email.
 */
function recipientsOf(row) {
    const chosen = (Array.isArray(row.recipients) ? row.recipients : [])
        .map((r) => ({
            name: String(r?.name || "").trim(),
            phone: String(r?.phone || "").trim(),
            email: String(r?.email || "").trim(),
        }))
        .filter((r) => r.phone || r.email);
    if (chosen.length) return chosen;

    const phone = String(row.customer_phone || "").trim();
    const email = String(row.customer_email || "").trim();
    return phone || email ? [{ name: "", phone, email }] : [];
}

// "Email (Ravi)" when several people are messaged, plain "Email" for one.
const tagFor = (target, many) => (many && target.name ? ` (${target.name})` : "");

const sentToFact = (targets) =>
    targets.length > 1 ? targets.map((t) => t.name || t.phone || t.email).join(", ") : "";

// -----------------------------------------------------------------------------
// Seller profile lookup
// -----------------------------------------------------------------------------

/**
 * Loads the seller's public-facing shop name and URL (row.seller_id = seller_profiles.id).
 * Intentionally does not throw, because notifications must not break the order flow.
 */
async function loadShop(sellerId) {
    const fallback = { name: "", url: "" };

    if (!sellerId) {
        console.warn("[order book] Cannot load shop: seller ID is missing");
        return fallback;
    }

    try {
        const { data, error } = await supabase
            .from(SELLERS_TABLE)
            .select("id, shop_slug, display_name, status, deleted_at")
            .eq("id", sellerId)
            .is("deleted_at", null)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            console.warn("[order book] Seller profile not found:", sellerId);
            return fallback;
        }

        const name = firstOf(data, NAME_KEYS);
        const slug = firstOf(data, SLUG_KEYS);
        const url = slug ? `${SITE_URL}/seller/${encodeURIComponent(slug)}` : "";

        return { name, url };
    } catch (error) {
        console.error("[order book] Shop lookup failed:", error?.message || error);
        return fallback;
    }
}

// -----------------------------------------------------------------------------
// Customer address formatting
// -----------------------------------------------------------------------------

// Only used to compare address components. The original address is preserved for display.
function normalizeAddressPart(value) {
    return String(value || "")
        .normalize("NFKC")
        .replace(/[–—-]/g, " ")
        .replace(/[,\s]+/g, " ")
        .trim()
        .toLowerCase();
}

// Builds the customer address without appending the same city, state or pincode twice.
function buildCustomerAddress(row) {
    const address = String(row.customer_address || "").trim();
    const city = String(row.customer_city || "").trim();
    const state = String(row.customer_state || "").trim();
    const pincode = String(row.customer_pincode || "").trim();

    const locationParts = [city, state, pincode].filter(Boolean);
    const place = locationParts.join(", ");

    if (!address) return place;
    if (!place) return address;

    const normalizedAddress = normalizeAddressPart(address);
    const normalizedPlace = normalizeAddressPart(place);

    // If the entire location is already present, don't append it.
    if (normalizedAddress.includes(normalizedPlace)) return address;

    // Append only the location components that are not already in the address.
    const missingParts = locationParts.filter(
        (part) => !normalizedAddress.includes(normalizeAddressPart(part))
    );

    if (!missingParts.length) return address;

    return `${address}, ${missingParts.join(", ")}`;
}

// -----------------------------------------------------------------------------
// Order item formatting
// -----------------------------------------------------------------------------

/**
 * Formats pack-based or quantity-based order lines.
 *   5 packs × ₹500.00 per pack
 *   5 master packs × ₹1,200.00 per master pack
 *   500 Kg × ₹2.47
 */
function describeLine(item) {
    const quantity = Number(item.quantity || 0);

    if (item.basis) {
        const isMasterPack = item.basis === "per_master_pack";
        const unitName = isMasterPack ? "master pack" : "pack";
        const pluralUnitName = quantity === 1 ? unitName : `${unitName}s`;

        return {
            qtyText: `${qtyFmt(quantity)} ${pluralUnitName} × ${inr(item.unitPrice, 4)} per ${unitName}`,
            packText:
                Number(item.totalUnits) > 0
                    ? `${qtyFmt(item.totalUnits)} ${item.baseUnit || ""} in total`.trim()
                    : "",
        };
    }

    const unit = String(item.unit || "").trim();

    return {
        qtyText: `${qtyFmt(quantity)}${unit ? ` ${unit}` : ""} × ${inr(item.unitPrice, 4)}`,
        packText: "",
    };
}

const lineItems = (rawItems) =>
    rawItems.map((item) => ({
        productName: item.productName || "Product",
        brandName: item.brandName || "",
        lineTotal: Number(item.lineTotal) || 0,
        ...describeLine(item),
    }));

// -----------------------------------------------------------------------------
// Billing totals
// -----------------------------------------------------------------------------

/**
 * Order prices include GST. When every item has a valid GST percentage this works out the taxable value,
 * the GST amount and the total; if GST information is incomplete it does not invent a split.
 */
function billingTotals(items, total) {
    let taxable = 0;
    let known = items.length > 0;

    for (const item of items) {
        const gstPercent = item.details?.gstPercent;

        if (gstPercent == null || !Number.isFinite(Number(gstPercent))) {
            known = false;
            break;
        }

        taxable += Number(item.lineTotal || 0) / (1 + Number(gstPercent) / 100);
    }

    if (!known) return { split: false, taxable: 0, gst: 0, total };

    const taxableRounded = Math.round(taxable * 100) / 100;

    return {
        split: true,
        taxable: taxableRounded,
        gst: Math.round((total - taxableRounded) * 100) / 100,
        total,
    };
}

// -----------------------------------------------------------------------------
// Shared order data
// -----------------------------------------------------------------------------

const getOrderItems = (row) => (Array.isArray(row.items) ? row.items : []);

function getOrderTotal(row, items) {
    const savedTotal = Number(row.total_amount);
    if (row.total_amount != null && Number.isFinite(savedTotal)) return savedTotal;
    return items.reduce((sum, item) => sum + (Number(item.lineTotal) || 0), 0);
}

function getBillingDetails(row) {
    return {
        name: row.customer_name || "",
        gstin: row.customer_gstin || "",
        phone: row.customer_phone || "",
        email: row.customer_email || "",
        address: buildCustomerAddress(row),
    };
}

// The salesperson copy shows the first recipient's contact; everyone is listed under "Sent to" when there are several.
const copyContact = (targets) => ({
    customerPhone: targets.find((t) => t.phone)?.phone || "",
    customerEmail: targets.find((t) => t.email)?.email || "",
});

// -----------------------------------------------------------------------------
// Order placed notification
// -----------------------------------------------------------------------------

/**
 * Called after an order is inserted into order_book_orders.
 * row must be the raw order_book_orders database row.
 */
export async function notifyOrderPlaced(row) {
    try {
        if (!row) {
            console.warn("[order book] Order placed notification skipped: missing row");
            return;
        }

        const targets = recipientsOf(row);
        if (!targets.length) {
            console.warn(`[order book] ${row.order_no} placed: no recipients, nothing sent`);
            return;
        }
        const many = targets.length > 1;

        // Seller lookup is best-effort.
        const shop = await loadShop(row.seller_id);
        const companyName = shop.name || "the selling company";

        const rawItems = getOrderItems(row);
        const items = lineItems(rawItems);

        const total = getOrderTotal(row, rawItems);
        const totals = billingTotals(rawItems, total);
        const placedOn = dateFmt(row.created_at);
        const billing = getBillingDetails(row);

        const jobs = [];

        for (const t of targets) {
            const who = t.name || row.customer_name;
            const tag = tagFor(t, many);

            if (t.email) {
                jobs.push(track(`Email${tag}`, sendOrderPlacedEmail({
                    to: t.email, customerName: who, companyName,
                    orderNo: row.order_no, placedOn, items, billing, totals,
                    notes: row.notes, shopUrl: shop.url,
                })));
            }
            if (t.phone) {
                jobs.push(track(`WhatsApp${tag}`, sendOrderPlacedWhatsApp({
                    to: t.phone, customerName: who, companyName,
                    orderNo: row.order_no, placedOn, items, billing, totals,
                    notes: row.notes,
                })));
            }
        }

        const delivery = await Promise.all(jobs);
        logDelivery(row, "placed", delivery);

        // Salesperson's own copy (best-effort, after the customer's messages).
        for (const salesperson of await copyRecipients(row)) {
            await sendSalespersonCopy({
                salesperson,
                title: "Order recorded",
                customerName: row.customer_name,
                ...copyContact(targets),
                facts: [
                    ["Order No", row.order_no],
                    ["Order Date", placedOn],
                    ["Seller", companyName],
                    ["Sent to", sentToFact(targets)],
                    ["Notes", row.notes],
                ],
                items: items.map((i) => ({
                    name: `${i.productName}${i.brandName ? ` (${i.brandName})` : ""}`,
                    detail: i.qtyText,
                    amount: inr(i.lineTotal),
                })),
                total: inr(total),
                delivery,
                note: delivery.some((d) => !d.ok)
                    ? "One channel failed. Please share the order details with the customer directly."
                    : "When the order is ready, mark it as processed so the customer is updated.",
            });
        }
    } catch (error) {
        console.error("[order book] notifyOrderPlaced failed:", error?.message || error);
    }
}

// -----------------------------------------------------------------------------
// Order processed notification
// -----------------------------------------------------------------------------

/** Called when the order is marked as processed. */
export async function notifyOrderProcessed(row, { actorId, processedBy } = {}) {
    try {
        if (!row) {
            console.warn("[order book] Order-processed notification skipped: missing row");
            return;
        }

        const targets = recipientsOf(row);
        if (!targets.length) {
            console.warn(`[order book] ${row.order_no} processed: no recipients, nothing sent`);
            return;
        }
        const many = targets.length > 1;

        const shop = await loadShop(row.seller_id);
        const companyName = shop.name || "the selling company";

        const rawItems = getOrderItems(row);
        const total = getOrderTotal(row, rawItems);
        const placedOn = dateFmt(row.created_at);

        // Keep the existing email item structure.
        const emailItems = rawItems.map((item) => ({
            productName: item.productName,
            brandName: item.brandName || "",
            unit: item.unit,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
        }));

        // Same detailed line formatting as the order-placed notification, for WhatsApp.
        const whatsappItems = lineItems(rawItems);

        const jobs = [];

        for (const t of targets) {
            const who = t.name || row.customer_name;
            const tag = tagFor(t, many);

            if (t.email) {
                jobs.push(track(`Email${tag}`, sendOrderProcessedEmail({
                    to: t.email, customerName: who, companyName,
                    orderNo: row.order_no, placedOn, items: emailItems, total,
                    notes: row.notes, shopUrl: shop.url,
                })));
            }
            if (t.phone) {
                jobs.push(track(`WhatsApp${tag}`, sendOrderProcessedWhatsApp({
                    to: t.phone, customerName: who, companyName,
                    orderNo: row.order_no, placedOn, items: whatsappItems, total,
                    notes: row.notes, shopUrl: shop.url || SITE_URL,
                })));
            }
        }

        const delivery = await Promise.all(jobs);
        logDelivery(row, "processed", delivery);

        for (const salesperson of await copyRecipients(row, actorId)) {
            await sendSalespersonCopy({
                salesperson,
                title: "Order marked as processed",
                customerName: row.customer_name,
                ...copyContact(targets),
                facts: [
                    ["Order No", row.order_no],
                    ["Order Date", placedOn],
                    ["Status", "Processing"],
                    ["Processed by", processedBy],
                    ["Sent to", sentToFact(targets)],
                ],
                items: whatsappItems.map((i) => ({
                    name: `${i.productName}${i.brandName ? ` (${i.brandName})` : ""}`,
                    detail: i.qtyText,
                    amount: inr(i.lineTotal),
                })),
                total: inr(total),
                delivery,
                note: delivery.some((d) => !d.ok)
                    ? "One channel failed. Please confirm the order with the customer directly."
                    : "The customer has been told the order is being processed.",
            });
        }
    } catch (error) {
        console.error("[order book] notifyOrderProcessed failed:", error?.message || error);
    }
}

// -----------------------------------------------------------------------------
// Shipped / completed / cancelled notifications
// -----------------------------------------------------------------------------

// Everything that differs between the three statuses lives here.
const STATUS_CONFIG = {
    shipped: {
        label: "shipped",
        status: "Shipped",
        copyTitle: "Order shipped",
        whatsapp: sendOrderShippedWhatsApp,
        okNote: "The customer has been told the order is shipped. Once it reaches them, the team will mark it as completed.",
        failNote: "One channel failed. Please share the shipping details with the customer directly.",
    },
    completed: {
        label: "completed",
        status: "Completed",
        copyTitle: "Order completed",
        whatsapp: sendOrderCompletedWhatsApp,
        okNote: "The customer has been told the order is completed.",
        failNote: "One channel failed. Please confirm the order completion with the customer directly.",
    },
    cancelled: {
        label: "cancelled",
        status: "Cancelled",
        copyTitle: "Order cancelled",
        whatsapp: sendOrderCancelledWhatsApp,
        okNote: "The customer has been told the order is cancelled.",
        failNote: "One channel failed. Please tell the customer about the cancellation directly.",
    },
};

/**
 * Shipped / completed / cancelled.
 * row must be the order_book_orders row AFTER the status change (it carries lr_number, lr_notes, cancel_reason).
 */
async function notifyStatusChange(row, status) {
    const cfg = STATUS_CONFIG[status];
    try {
        if (!row) {
            console.warn(`[order book] Order-${cfg.label} notification skipped: missing row`);
            return;
        }

        const targets = recipientsOf(row);
        if (!targets.length) {
            console.warn(`[order book] ${row.order_no} ${cfg.label}: no recipients, nothing sent`);
            return;
        }
        const many = targets.length > 1;

        const shop = await loadShop(row.seller_id);
        const companyName = shop.name || "the selling company";

        const rawItems = getOrderItems(row);
        const items = lineItems(rawItems);
        const total = getOrderTotal(row, rawItems);
        const placedOn = dateFmt(row.created_at);

        const lrNumber = String(row.lr_number || "").trim();
        const lrNotes = String(row.lr_notes || "").trim();
        const reason = String(row.cancel_reason || "").trim();

        const common = {
            companyName, orderNo: row.order_no, placedOn, items, total,
            notes: row.notes, shopUrl: shop.url || SITE_URL,
            lrNumber, lrNotes, reason,
        };

        const jobs = [];

        for (const t of targets) {
            const customerName = t.name || row.customer_name;
            const tag = tagFor(t, many);

            if (t.email) {
                jobs.push(track(`Email${tag}`, sendOrderStatusEmail({ kind: status, to: t.email, customerName, ...common })));
            }
            if (t.phone) {
                jobs.push(track(`WhatsApp${tag}`, cfg.whatsapp({ to: t.phone, customerName, ...common })));
            }
        }

        const delivery = await Promise.all(jobs);
        logDelivery(row, cfg.label, delivery);

        for (const salesperson of await copyRecipients(row)) {
            await sendSalespersonCopy({
                salesperson,
                title: cfg.copyTitle,
                customerName: row.customer_name,
                ...copyContact(targets),
                facts: [
                    ["Order No", row.order_no],
                    ["Order Date", placedOn],
                    ["Status", cfg.status],
                    ["LR Number", status === "shipped" ? lrNumber : ""],
                    ["Shipping Notes", status === "shipped" ? lrNotes : ""],
                    ["Reason", status === "cancelled" ? reason : ""],
                    ["Sent to", sentToFact(targets)],
                ],
                items: items.map((i) => ({
                    name: `${i.productName}${i.brandName ? ` (${i.brandName})` : ""}`,
                    detail: i.qtyText,
                    amount: inr(i.lineTotal),
                })),
                total: inr(total),
                delivery,
                note: delivery.some((d) => !d.ok) ? cfg.failNote : cfg.okNote,
            });
        }
    } catch (error) {
        console.error(`[order book] notifyOrder ${cfg.label} failed:`, error?.message || error);
    }
}

// -----------------------------------------------------------------------------
// Single entry point for status changes
// -----------------------------------------------------------------------------

/**
 * Called by the controller after every successful status change.
 *   row    the order_book_orders row AFTER the change
 *   status "processed" | "shipped" | "completed" | "cancelled"
 */
export function notifyOrderStatus(row, status, { processedBy } = {}) {
    if (status === "processed") return notifyOrderProcessed(row, { actorId: null, processedBy });
    if (STATUS_CONFIG[status]) return notifyStatusChange(row, status);
    console.warn(`[order book] No customer notification defined for status "${status}"`);
    return Promise.resolve();
}