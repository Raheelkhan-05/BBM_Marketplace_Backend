// services/whatsapp.service.js
//
// WhatsApp messaging through the DealSMS gateway.
//
// Existing integrations are preserved:
//   - sendWhatsAppText
//   - sendWhatsAppTemplate
//   - sendOrderUpdateWhatsApp
//   - sendSalesQuotationWhatsApp
//   - sendOrderPlacedWhatsApp
//   - sendOrderProcessedWhatsApp
//
// All messages are sent as ordinary WhatsApp text messages.
// Notification failures must not break order operations.

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const BASE_URL = (
    process.env.DEALSMS_BASE_URL ||
    "https://dealsms.in/api"
).replace(/\/+$/, "");

const ACCESS_TOKEN =
    process.env.DEALSMS_ACCESS_TOKEN;

const INSTANCE_ID =
    process.env.DEALSMS_INSTANCE_ID;

const GAP_MS =
    Number(process.env.DEALSMS_GAP_MS) || 1500;

const TIMEOUT_MS = 15000;

const MAX_LEN = 3800;

const BRAND = "BBM Marketplace";

const RULE = "━━━━━━━━━━━━━━━━━━";

// -----------------------------------------------------------------------------
// Phone number formatting
// -----------------------------------------------------------------------------

function toE164(rawPhone) {
    if (!rawPhone) {
        return null;
    }

    const digits = String(rawPhone).replace(
        /[^\d]/g,
        ""
    );

    if (!digits) {
        return null;
    }

    // Assumes Indian numbers when the country code is absent.
    if (digits.length === 10) {
        return `91${digits}`;
    }

    return digits;
}

// -----------------------------------------------------------------------------
// Queue and sending helpers
// -----------------------------------------------------------------------------

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

let chain = Promise.resolve();

/**
 * Send messages sequentially to avoid sending multiple messages
 * simultaneously through the same WhatsApp instance.
 */
function enqueue(task) {
    const run = chain.then(task);

    chain = run
        .catch(() => {
            // A failed message must not block subsequent messages.
        })
        .then(() => sleep(GAP_MS));

    return run;
}

/**
 * Sends an ordinary WhatsApp text message through DealSMS.
 *
 * This function returns a failure result instead of throwing
 * gateway errors into order-related operations.
 */
export async function sendWhatsAppText({
    to,
    message,
}) {
    const number = toE164(to);

    if (!number) {
        console.warn(
            "[whatsapp] Skipped: invalid phone number",
            { to }
        );

        return {
            success: false,
            skipped: true,
        };
    }

    if (!ACCESS_TOKEN || !INSTANCE_ID) {
        console.error(
            "[whatsapp] DEALSMS_ACCESS_TOKEN / DEALSMS_INSTANCE_ID not configured"
        );

        return {
            success: false,
            skipped: true,
        };
    }

    const text = String(message || "")
        .trim()
        .slice(0, MAX_LEN);

    if (!text) {
        return {
            success: false,
            skipped: true,
        };
    }

    return enqueue(async () => {
        const controller = new AbortController();

        const timer = setTimeout(
            () => controller.abort(),
            TIMEOUT_MS
        );

        try {
            const response = await fetch(
                `${BASE_URL}/send`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type": "application/json",
                    },

                    body: JSON.stringify({
                        number,
                        type: "text",
                        message: text,
                        instance_id: INSTANCE_ID,
                        access_token: ACCESS_TOKEN,
                    }),

                    signal: controller.signal,
                }
            );

            let data = {};

            try {
                data = await response.json();
            } catch {
                // Some gateway responses may not contain JSON.
            }

            const failed =
                !response.ok ||
                data?.status === "error" ||
                data?.success === false ||
                Boolean(data?.error);

            if (failed) {
                console.error(
                    "[whatsapp] Send failed",
                    {
                        to: number,
                        status: response.status,
                        response: data,
                    }
                );

                return {
                    success: false,
                    error: data,
                };
            }

            return {
                success: true,
                data,
            };
        } catch (error) {
            console.error(
                "[whatsapp] Send error:",
                error?.name === "AbortError"
                    ? "Request timed out"
                    : error?.message || error
            );

            return {
                success: false,
                error: error?.message || String(error),
            };
        } finally {
            clearTimeout(timer);
        }
    });
}

// -----------------------------------------------------------------------------
// Legacy compatibility
// -----------------------------------------------------------------------------

/**
 * Retained for older call sites.
 *
 * DealSMS sends plain text, so the supplied parameters are
 * joined into a single message.
 */
export async function sendWhatsAppTemplate({
    to,
    bodyParams = [],
}) {
    return sendWhatsAppText({
        to,
        message: bodyParams
            .filter(Boolean)
            .join("\n\n"),
    });
}

// -----------------------------------------------------------------------------
// Message formatting helpers
// -----------------------------------------------------------------------------

const bold = (value) => {
    const text = String(value ?? "")
        .replace(/\*/g, "")
        .replace(/\s+/g, " ")
        .trim();

    return text ? `*${text}*` : "";
};

const clean = (value) =>
    String(value ?? "")
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .trim();

const money = (value) => {
    if (typeof value === "string") {
        return value;
    }

    return (
        "₹" +
        Number(value || 0).toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })
    );
};

const field = (label, value) =>
    clean(value)
        ? `${bold(label)}: ${clean(value)}`
        : null;

/**
 * Drops null, undefined and false entries while retaining
 * intentional empty strings used as line breaks.
 */
const join = (parts, separator = "\n") =>
    parts
        .filter(
            (part) =>
                part != null && part !== false
        )
        .join(separator);

const sign = () => `_${BRAND}_`;

// -----------------------------------------------------------------------------
// Order item formatting
// -----------------------------------------------------------------------------

/**
 * Accepts either:
 *   - A structured array of order items
 *   - The older itemsLine string format
 */
function itemsBlock({ items, itemsLine }) {
    let list = Array.isArray(items) ? items : null;

    if (!list || !list.length) {
        list = clean(itemsLine)
            .split(/;\s*/)
            .map((s) =>
                s.replace(/^\d+\)\s*/, "").trim()
            )
            .filter(Boolean)
            .map((text) => ({ text }));
    }

    const MAX_ITEMS = 12;

    const shown = list.slice(0, MAX_ITEMS).map((item, index) => {
        if (item.text) {
            return `${index + 1}. ${clean(item.text)}`;
        }

        const productName = clean(item.productName) || "Product";
        const brandName = clean(item.brandName);

        return join([
            `${index + 1}. ${bold(productName)}${brandName ? ` (${brandName})` : ""
            }`,
            item.qtyText ? `    ${clean(item.qtyText)}` : null,
            item.packText ? `    ${clean(item.packText)}` : null,
            item.lineTotal != null
                ? `    Amount: ${money(item.lineTotal)}`
                : null,
        ]);
    });

    if (list.length > MAX_ITEMS) {
        shown.push(
            `...and ${list.length - MAX_ITEMS} more items.`
        );
    }

    return shown.join("\n\n");
}

// -----------------------------------------------------------------------------
// Generic order updates
// -----------------------------------------------------------------------------

export async function sendOrderUpdateWhatsApp({
    to,
    name,
    headline,
    detail,
    footer,
}) {
    const message = join([
        bold(headline || "Order update"),

        "",

        `Hello ${clean(name) || "there"},`,

        "",

        clean(detail),

        "",

        "If you have any questions about this order, please reply to this message or contact our support team.",

        "",

        clean(footer) ||
        "Thank you for shopping with BBM Marketplace.",

        sign(),
    ]);

    return sendWhatsAppText({
        to,
        message,
    });
}

// -----------------------------------------------------------------------------
// Sales quotations
// -----------------------------------------------------------------------------

export async function sendSalesQuotationWhatsApp({
    to,
    customerName,
    sellerName,
    enquiryProduct,
    itemsLine,
    items,
    total,
    validUntil,
    closing,
}) {
    const message = join([
        `${bold("Quotation")} `,

        "",

        `Hello ${clean(customerName) || "there"},`,

        "",

        `${bold(
            sellerName || "The seller"
        )} has shared a quotation for your enquiry: ${bold(
            enquiryProduct || "your enquiry"
        )}.`,

        "",

        RULE,

        bold("ITEMS"),

        itemsBlock({
            items,
            itemsLine,
        }),

        RULE,

        "",

        field("Total (incl. GST)", total),

        field("Valid until", validUntil),

        "",

        clean(closing) ||
        "Please get in touch with us to confirm your order.",

        "",

        sign(),
    ]);

    return sendWhatsAppText({
        to,
        message,
    });
}

// -----------------------------------------------------------------------------
// Order Book: Order received
// -----------------------------------------------------------------------------

/**
 * Sends an order acknowledgement to the customer.
 *
 * Expected arguments:
 *   to
 *   customerName
 *   companyName
 *   orderNo
 *   placedOn
 *   items
 *   billing
 *   totals
 *   notes
 *
 * The companyName must be the seller's display_name where available.
 */
export async function sendOrderPlacedWhatsApp({
    to,
    customerName,
    companyName,
    orderNo,
    placedOn,
    items,
    billing,
    totals,
    notes,
    itemsLine,
    billingLine,
    total,
}) {
    const b = billing || {};

    const t = totals || {};

    const sellerName =
        clean(companyName) ||
        "the selling company";

    const hasBilling = Boolean(
        b.name ||
        b.gstin ||
        b.address ||
        b.phone ||
        b.email ||
        clean(billingLine)
    );

    const billingBlock = hasBilling
        ? join([
            bold("BILLING DETAILS"),

            field("Billed to", b.name),

            field("GSTIN", b.gstin),

            field("Address", b.address),

            field("Mobile", b.phone),

            field("Email", b.email),

            !b.name &&
                !b.gstin &&
                !b.address &&
                !b.phone &&
                !b.email
                ? clean(billingLine)
                : null,
        ])
        : null;

    const totalsBlock = join([
        t.split
            ? field("Taxable value", money(t.taxable))
            : null,

        t.split
            ? field("GST", money(t.gst))
            : null,

        `${bold("Order Total (incl. GST)")}: ${bold(
            money(t.total ?? total)
        )}`,
    ]);

    const message = join([
        bold("ORDER RECEIVED"),

        "",

        `Hello ${clean(customerName) || "there"},`,

        "",

        `Thank you for placing your order with ${bold(
            sellerName
        )}.`,

        "Your order has been recorded successfully. Please review the details below.",

        "",

        field("Order Number", orderNo),

        field("Order Date", placedOn),

        field("Status", "Order received"),

        "",

        RULE,

        bold("ORDER DETAILS"),

        itemsBlock({
            items,
            itemsLine,
        }),

        RULE,

        billingBlock,

        billingBlock ? RULE : null,

        totalsBlock,

        clean(notes) ? "" : null,

        clean(notes)
            ? field("Order Notes", notes)
            : null,

        "",

        "The selling company will review and process your order. You will receive further updates as its status changes.",

        "",

        "If any order or billing detail is incorrect, please reply to this message.",

        "",

        `Thank you for choosing ${bold(sellerName)}.`,

        sign(),
    ]);

    return sendWhatsAppText({
        to,
        message,
    });
}

// -----------------------------------------------------------------------------
// Order Book: Order processed
// -----------------------------------------------------------------------------

export async function sendOrderProcessedWhatsApp({
    to,
    customerName,
    companyName,
    orderNo,
    placedOn,
    items,
    itemsLine,
    total,
    notes,
    shopUrl,
}) {
    const sellerName =
        clean(companyName) ||
        "the selling company";

    const message = join([
        bold("ORDER CONFIRMED"),

        "",

        `Hello ${clean(customerName) || "there"},`,

        "",

        `Thank you for your purchase from ${bold(
            sellerName
        )}. Your order has been confirmed and is now being processed.`,

        "",

        field("Order Number", orderNo),

        field("Order Date", placedOn),

        field("Status", "Processing"),

        "",

        RULE,

        bold("ORDER DETAILS"),

        itemsBlock({
            items,
            itemsLine,
        }),

        RULE,

        `${bold("Order Total (incl. GST)")}: ${bold(
            money(total)
        )}`,

        clean(notes) ? "" : null,

        clean(notes)
            ? field("Order Notes", notes)
            : null,

        "",

        "If you have any questions, simply reply to this message.",

        shopUrl ? "" : null,

        shopUrl
            ? `Visit our shop: ${clean(shopUrl)}`
            : null,

        "",

        `Thank you for choosing ${bold(sellerName)}.`,

        sign(),
    ]);

    return sendWhatsAppText({
        to,
        message,
    });
}