// services/whatsapp.service.js
//
// WhatsApp messaging through the DealSMS gateway.
//
// Preserved exports:
//   sendWhatsAppText, sendWhatsAppTemplate, sendOrderUpdateWhatsApp, sendSalesQuotationWhatsApp,
//   sendOrderPlacedWhatsApp, sendOrderProcessedWhatsApp, sendSalespersonCopyWhatsApp,
//   sendDispatcherOrderWhatsApp, sendSalesChatWhatsApp
// New exports:
//   sendOrderShippedWhatsApp, sendOrderCompletedWhatsApp, sendOrderCancelledWhatsApp
//
// RELIABILITY
//   - Messages go out one at a time (the gateway is one WhatsApp session) with a small gap between them.
//   - A failed attempt is retried (timeouts, network errors, 408/429/5xx, gateway-reported errors) with backoff.
//     Permanent failures (bad number, 4xx such as a wrong token) are NOT retried.
//   - Every message logs one line: kind, masked number, attempts, time spent waiting in the queue, time to send.
//   - Failures are logged with console.error. After several failures in a row an ALERT is logged, and retries are
//     reduced to a single attempt so a dead gateway can't block the queue for minutes.
//
// ENV (all optional except the two credentials)
//   DEALSMS_ACCESS_TOKEN, DEALSMS_INSTANCE_ID, DEALSMS_BASE_URL
//   DEALSMS_GAP_MS (1500), DEALSMS_TIMEOUT_MS (15000), DEALSMS_MAX_ATTEMPTS (3)
//
// Notification failures must never break order operations: nothing here throws.

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const BASE_URL = (process.env.DEALSMS_BASE_URL || "https://dealsms.in/api").replace(/\/+$/, "");
const ACCESS_TOKEN = process.env.DEALSMS_ACCESS_TOKEN;
const INSTANCE_ID = process.env.DEALSMS_INSTANCE_ID;

const GAP_MS = Number(process.env.DEALSMS_GAP_MS) || 1500;
const TIMEOUT_MS = Number(process.env.DEALSMS_TIMEOUT_MS) || 15000;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.DEALSMS_MAX_ATTEMPTS) || 3);
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const ALERT_AFTER_FAILURES = 5;
const SLOW_QUEUE_MS = 10000;

const MAX_LEN = 3800;
const BRAND = "BBM Marketplace";
const RULE = "━━━━━━━━━━━━━━━━━━";
const BETA_NOTE =
    "_Please note: BBM Marketplace is currently in its beta phase. Occasional errors may occur and are being addressed. We appreciate your patience._";

// -----------------------------------------------------------------------------
// Phone number formatting
// -----------------------------------------------------------------------------

function toE164(rawPhone) {
    if (!rawPhone) return null;
    const digits = String(rawPhone).replace(/[^\d]/g, "");
    if (!digits) return null;
    // Assumes Indian numbers when the country code is absent.
    if (digits.length === 10) return `91${digits}`;
    return digits;
}

// Logs never contain a full phone number.
const mask = (number) => (number ? `***${String(number).slice(-4)}` : "?");

const brief = (value) => {
    try {
        return (typeof value === "string" ? value : JSON.stringify(value)).slice(0, 200);
    } catch {
        return "";
    }
};

// -----------------------------------------------------------------------------
// Queue and sending
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let chain = Promise.resolve();
let pending = 0;
let consecutiveFailures = 0;

/** Runs tasks strictly one after another, with a gap between them. A failed task never blocks the next one. */
function enqueue(task) {
    pending += 1;
    const run = chain.then(async () => {
        try {
            return await task();
        } finally {
            pending -= 1;
        }
    });
    chain = run.catch(() => { /* a failed message must not block the queue */ }).then(() => sleep(GAP_MS));
    return run;
}

/** One HTTP attempt. Never throws. */
async function attemptSend(number, text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${BASE_URL}/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                number,
                type: "text",
                message: text,
                instance_id: INSTANCE_ID,
                access_token: ACCESS_TOKEN,
            }),
            signal: controller.signal,
        });

        let data = {};
        try { data = await response.json(); } catch { /* some gateway responses are not JSON */ }

        const failed =
            !response.ok ||
            data?.status === "error" ||
            data?.success === false ||
            Boolean(data?.error);

        if (!failed) return { ok: true, data };

        // 4xx (wrong token, bad request) will not fix itself; everything else might.
        const clientError = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
        return { ok: false, retryable: !clientError, reason: `HTTP ${response.status} ${brief(data)}`.trim() };
    } catch (error) {
        const timedOut = error?.name === "AbortError";
        return { ok: false, retryable: true, reason: timedOut ? `timeout after ${TIMEOUT_MS}ms` : (error?.message || String(error)) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Sends an ordinary WhatsApp text message through DealSMS, with retries.
 * Returns { success, attempts, data? , error?, skipped? }. Never throws.
 * `kind` is only used to label the log lines (e.g. "order_shipped").
 */
export async function sendWhatsAppText({ to, message, kind = "message" }) {
    const number = toE164(to);

    if (!number) {
        console.warn(`[whatsapp] SKIPPED kind=${kind}: invalid phone number`, { to });
        return { success: false, skipped: true, attempts: 0, error: "invalid phone number" };
    }

    if (!ACCESS_TOKEN || !INSTANCE_ID) {
        console.error(`[whatsapp] SKIPPED kind=${kind} to=${mask(number)}: DEALSMS_ACCESS_TOKEN / DEALSMS_INSTANCE_ID not configured`);
        return { success: false, skipped: true, attempts: 0, error: "gateway not configured" };
    }

    let text = String(message || "").trim();
    if (!text) return { success: false, skipped: true, attempts: 0, error: "empty message" };
    if (text.length > MAX_LEN) {
        console.warn(`[whatsapp] kind=${kind} to=${mask(number)}: message is ${text.length} chars, truncated to ${MAX_LEN}`);
        text = text.slice(0, MAX_LEN);
    }

    const queuedAt = Date.now();

    return enqueue(async () => {
        const waited = Date.now() - queuedAt;
        if (waited > SLOW_QUEUE_MS) {
            console.warn(`[whatsapp] SLOW QUEUE: kind=${kind} to=${mask(number)} waited ${waited}ms (${pending - 1} more queued)`);
        }

        // If the gateway has been failing repeatedly, don't stall the queue with long retry cycles.
        const maxAttempts = consecutiveFailures >= ALERT_AFTER_FAILURES ? 1 : MAX_ATTEMPTS;
        const started = Date.now();
        let attempts = 0;
        let last = null;

        while (attempts < maxAttempts) {
            attempts += 1;
            last = await attemptSend(number, text);
            if (last.ok) break;

            console.warn(`[whatsapp] attempt ${attempts}/${maxAttempts} failed kind=${kind} to=${mask(number)}: ${last.reason}`);
            if (!last.retryable || attempts >= maxAttempts) break;
            await sleep(RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
        }

        const took = Date.now() - started;

        if (last?.ok) {
            consecutiveFailures = 0;
            console.log(`[whatsapp] SENT kind=${kind} to=${mask(number)} attempts=${attempts} queued=${waited}ms took=${took}ms`);
            return { success: true, data: last.data, attempts };
        }

        consecutiveFailures += 1;
        console.error(`[whatsapp] FAILED kind=${kind} to=${mask(number)} attempts=${attempts} queued=${waited}ms took=${took}ms reason=${last?.reason}`);
        if (consecutiveFailures % ALERT_AFTER_FAILURES === 0) {
            console.error(`[whatsapp] ALERT: ${consecutiveFailures} messages failed in a row. Check that the DealSMS instance is connected (reconnect / re-scan QR), the token is valid and the account has credit.`);
        }
        return { success: false, error: last?.reason || "unknown error", attempts };
    });
}

// -----------------------------------------------------------------------------
// Legacy compatibility
// -----------------------------------------------------------------------------

/** Retained for older call sites. DealSMS sends plain text, so the params are joined into one message. */
export async function sendWhatsAppTemplate({ to, bodyParams = [] }) {
    return sendWhatsAppText({ to, kind: "template", message: bodyParams.filter(Boolean).join("\n\n") });
}

// -----------------------------------------------------------------------------
// Message formatting helpers
// -----------------------------------------------------------------------------

const bold = (value) => {
    const text = String(value ?? "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
    return text ? `*${text}*` : "";
};

const clean = (value) =>
    String(value ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();

const money = (value) => {
    if (typeof value === "string") return value;
    return "₹" + Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const field = (label, value) => (clean(value) ? `${bold(label)}: ${clean(value)}` : null);

/** Drops null, undefined and false entries while keeping intentional empty strings used as line breaks. */
const join = (parts, separator = "\n") =>
    parts.filter((part) => part != null && part !== false).join(separator);

const sign = () => `_${BRAND}_`;

// -----------------------------------------------------------------------------
// Order item formatting
// -----------------------------------------------------------------------------

/** Accepts either a structured array of order items or the older itemsLine string. */
function itemsBlock({ items, itemsLine }) {
    let list = Array.isArray(items) ? items : null;

    if (!list || !list.length) {
        list = clean(itemsLine)
            .split(/;\s*/)
            .map((s) => s.replace(/^\d+\)\s*/, "").trim())
            .filter(Boolean)
            .map((text) => ({ text }));
    }

    const MAX_ITEMS = 12;

    const shown = list.slice(0, MAX_ITEMS).map((item, index) => {
        if (item.text) return `${index + 1}. ${clean(item.text)}`;

        const productName = clean(item.productName) || "Product";
        const brandName = clean(item.brandName);

        return join([
            `${index + 1}. ${bold(productName)}${brandName ? ` (${brandName})` : ""}`,
            item.qtyText ? `    ${clean(item.qtyText)}` : null,
            item.packText ? `    ${clean(item.packText)}` : null,
            item.lineTotal != null ? `    Amount: ${money(item.lineTotal)}` : null,
        ]);
    });

    if (list.length > MAX_ITEMS) shown.push(`...and ${list.length - MAX_ITEMS} more items.`);

    return shown.join("\n\n");
}

// -----------------------------------------------------------------------------
// Generic order updates
// -----------------------------------------------------------------------------

export async function sendOrderUpdateWhatsApp({ to, name, headline, detail, footer }) {
    const message = join([
        bold(headline || "Order update"),
        "",
        `Hello ${clean(name) || "there"},`,
        "",
        clean(detail),
        "",
        "If you have any questions about this order, please reply to this message or contact our support team.",
        "",
        clean(footer) || "Thank you for shopping with BBM Marketplace.",
        "",
        BETA_NOTE,
        sign(),
    ]);

    return sendWhatsAppText({ to, message, kind: "order_update" });
}

// -----------------------------------------------------------------------------
// Sales quotations
// -----------------------------------------------------------------------------

export async function sendSalesQuotationWhatsApp({
    to, customerName, sellerName, enquiryProduct, itemsLine, items, total, validUntil, closing,
}) {
    const message = join([
        `${bold("Quotation")} `,
        "",
        `Hello ${clean(customerName) || "there"},`,
        "",
        `${bold(sellerName || "The seller")} has shared a quotation for your enquiry: ${bold(enquiryProduct || "your enquiry")}.`,
        "",
        RULE,
        bold("ITEMS"),
        itemsBlock({ items, itemsLine }),
        RULE,
        "",
        field("Total (incl. GST)", total),
        field("Valid until", validUntil),
        "",
        clean(closing) || "Please get in touch with us to confirm your order.",
        "",
        BETA_NOTE,
        "",
        sign(),
    ]);

    return sendWhatsAppText({ to, message, kind: "quotation" });
}

// -----------------------------------------------------------------------------
// Order Book: Order received
// -----------------------------------------------------------------------------

export async function sendOrderPlacedWhatsApp({
    to, customerName, companyName, orderNo, placedOn, items, billing, totals, notes, itemsLine, billingLine, total,
}) {
    const b = billing || {};
    const t = totals || {};
    const sellerName = clean(companyName) || "the selling company";

    const hasBilling = Boolean(b.name || b.gstin || b.address || b.phone || b.email || clean(billingLine));

    const billingBlock = hasBilling
        ? join([
            bold("BILLING DETAILS"),
            field("Billed to", b.name),
            field("GSTIN", b.gstin),
            field("Address", b.address),
            field("Mobile", b.phone),
            field("Email", b.email),
            !b.name && !b.gstin && !b.address && !b.phone && !b.email ? clean(billingLine) : null,
        ])
        : null;

    const totalsBlock = join([
        t.split ? field("Taxable value", money(t.taxable)) : null,
        t.split ? field("GST", money(t.gst)) : null,
        `${bold("Order Total (incl. GST)")}: ${bold(money(t.total ?? total))}`,
    ]);

    const message = join([
        bold("ORDER RECEIVED"),
        "",
        `Hello ${clean(customerName) || "there"},`,
        "",
        `Thank you for placing your order with ${bold(sellerName)}.`,
        "Your order has been recorded successfully. Please review the details below.",
        "",
        field("Order Number", orderNo),
        field("Order Date", placedOn),
        field("Status", "Order received"),
        "",
        RULE,
        bold("ORDER DETAILS"),
        itemsBlock({ items, itemsLine }),
        RULE,
        billingBlock,
        billingBlock ? RULE : null,
        totalsBlock,
        "",
        "The selling company will review and process your order. You will receive further updates as its status changes.",
        "",
        "If any order or billing detail is incorrect, please reply to this message.",
        "",
        `Thank you for choosing ${bold(sellerName)}.`,
        "",
        BETA_NOTE,
        sign(),
    ]);

    return sendWhatsAppText({ to, message, kind: "order_placed" });
}

// -----------------------------------------------------------------------------
// Order Book: status updates (processed / shipped / completed / cancelled)
// -----------------------------------------------------------------------------

/**
 * One layout for all status messages so they look consistent:
 *   header, greeting, lead sentence, order facts, items, total, closing, shop link, sign-off.
 */
function statusMessage({
    header, lead, status, customerName, orderNo, placedOn, items, itemsLine, total,
    extraFields = [], notes, closing, shopUrl, sellerName, showItems = true,
}) {
    return join([
        bold(header),
        "",
        `Hello ${clean(customerName) || "there"},`,
        "",
        lead,
        "",
        field("Order Number", orderNo),
        field("Order Date", placedOn),
        field("Status", status),
        ...extraFields.map(([label, value]) => field(label, value)),
        "",
        showItems ? RULE : null,
        showItems ? bold("ORDER DETAILS") : null,
        showItems ? itemsBlock({ items, itemsLine }) : null,
        showItems ? RULE : null,
        total != null ? `${bold("Order Total (incl. GST)")}: ${bold(money(total))}` : null,
        clean(notes) ? "" : null,
        clean(notes) ? field("Order Notes", notes) : null,
        "",
        closing,
        shopUrl ? "" : null,
        shopUrl ? `Visit our shop: ${clean(shopUrl)}` : null,
        "",
        `Thank you for choosing ${bold(sellerName)}.`,
        "",
        BETA_NOTE,
        sign(),
    ]);
}

export async function sendOrderProcessedWhatsApp({
    to, customerName, companyName, orderNo, placedOn, items, itemsLine, total, notes, shopUrl,
}) {
    const sellerName = clean(companyName) || "the selling company";
    const message = statusMessage({
        header: "ORDER CONFIRMED",
        lead: `Thank you for your purchase from ${bold(sellerName)}. Your order has been confirmed and is now being processed.`,
        status: "Processing",
        customerName, orderNo, placedOn, items, itemsLine, total, notes, shopUrl, sellerName,
        closing: "If you have any questions, simply reply to this message.",
    });
    return sendWhatsAppText({ to, message, kind: "order_processed" });
}

export async function sendOrderShippedWhatsApp({
    to, customerName, companyName, orderNo, placedOn, items, itemsLine, total, lrNumber, lrNotes, notes, shopUrl,
}) {
    const sellerName = clean(companyName) || "the selling company";
    const message = statusMessage({
        header: "ORDER SHIPPED",
        lead: `Good news! Your order from ${bold(sellerName)} has been shipped and is on its way to you.`,
        status: "Shipped",
        extraFields: [["LR Number", lrNumber], ["Shipping Notes", lrNotes]],
        customerName, orderNo, placedOn, items, itemsLine, total, notes, shopUrl, sellerName,
        closing: "If you have any questions about the delivery, simply reply to this message and mention your order number.",
    });
    return sendWhatsAppText({ to, message, kind: "order_shipped" });
}

export async function sendOrderCompletedWhatsApp({
    to, customerName, companyName, orderNo, placedOn, items, itemsLine, total, notes, shopUrl,
}) {
    const sellerName = clean(companyName) || "the selling company";
    const message = statusMessage({
        header: "ORDER COMPLETED",
        lead: `Your order from ${bold(sellerName)} has been completed. We hope everything reached you in good order.`,
        status: "Completed",
        customerName, orderNo, placedOn, items, itemsLine, total, notes, shopUrl, sellerName,
        closing: "If anything is not as expected, please reply to this message and mention your order number so we can help.",
    });
    return sendWhatsAppText({ to, message, kind: "order_completed" });
}

export async function sendOrderCancelledWhatsApp({
    to, customerName, companyName, orderNo, placedOn, items, itemsLine, total, reason, notes, shopUrl,
}) {
    const sellerName = clean(companyName) || "the selling company";
    const message = statusMessage({
        header: "ORDER CANCELLED",
        lead: `We're sorry to let you know that your order with ${bold(sellerName)} has been cancelled.`,
        status: "Cancelled",
        extraFields: [["Reason", reason]],
        customerName, orderNo, placedOn, items, itemsLine, total, notes, shopUrl, sellerName,
        closing: "If you were not expecting this or have any questions, please reply to this message and mention your order number.",
    });
    return sendWhatsAppText({ to, message, kind: "order_cancelled" });
}

// -----------------------------------------------------------------------------
// Salesperson copy
// -----------------------------------------------------------------------------

/**
 * A record for the salesperson of what was just sent to a customer.
 * Deliberately different from the customer message: no greeting to the
 * customer, no beta note, adds delivery status and a next step.
 */
export async function sendSalespersonCopyWhatsApp({
    to, salespersonName, title, customerName, customerContact, facts = [], items = [], total, delivery = [], note,
}) {
    const MAX = 12;

    const lines = items.slice(0, MAX).map((it, i) =>
        join([
            `${i + 1}. ${clean(it.name)}`,
            it.detail ? `    ${clean(it.detail)}` : null,
            it.amount ? `    ${clean(it.amount)}` : null,
        ])
    );
    if (items.length > MAX) lines.push(`...and ${items.length - MAX} more items.`);

    const deliveryLine = delivery
        .map((d) => `${d.channel}: ${d.ok ? "delivered" : "failed"}`)
        .join("  |  ");

    const message = join([
        bold(`YOUR COPY: ${title}`),
        "",
        `Hi ${clean(salespersonName) || "there"},`,
        "",
        `Here's a record of what was just sent to ${bold(customerName || "your customer")}. Only you receive this copy.`,
        "",
        field("Customer contact", customerContact),
        field("Delivery", deliveryLine),
        ...facts.map(([label, value]) => field(label, value)),
        lines.length ? "" : null,
        lines.length ? RULE : null,
        lines.length ? bold("SENT TO CUSTOMER") : null,
        lines.length ? lines.join("\n\n") : null,
        lines.length ? RULE : null,
        total != null ? `${bold("Total (incl. GST)")}: ${bold(money(total))}` : null,
        clean(note) ? "" : null,
        clean(note) ? `${bold("Next step")}: ${clean(note)}` : null,
        "",
        sign(),
    ]);

    return sendWhatsAppText({ to, message, kind: "salesperson_copy" });
}

// -----------------------------------------------------------------------------
// Order Book: new order alert for dispatchers
// -----------------------------------------------------------------------------
export async function sendDispatcherOrderWhatsApp({
    to, dispatcherName, companyName, orderNo, poNumber, placedOn, salespersonName,
    customer = {}, items, total, notes, link,
}) {
    const message = join([
        bold("NEW ORDER TO DISPATCH"),
        "",
        `Hello ${clean(dispatcherName) || "there"},`,
        "",
        `A new order was just punched${salespersonName ? ` by ${bold(salespersonName)}` : ""}${companyName ? ` for ${bold(companyName)}` : ""}.`,
        "",
        field("Order Number", orderNo),
        field("PO Number", poNumber),
        field("Placed on", placedOn),
        "",
        RULE,
        bold("CUSTOMER"),
        field("Name", customer.name),
        field("GSTIN", customer.gstin),
        field("Address", customer.address),
        field("Mobile", customer.phone),
        field("Email", customer.email),
        RULE,
        bold("ITEMS"),
        itemsBlock({ items }),
        RULE,
        `${bold("Order Total (incl. GST)")}: ${bold(money(total))}`,
        clean(notes) ? "" : null,
        clean(notes) ? field("Order Notes", notes) : null,
        "",
        link ? `Open order: ${clean(link)}` : null,
        "",
        sign(),
    ]);
    return sendWhatsAppText({ to, message, kind: "dispatcher_alert" });
}

// Enquiry chat: kind = "new" (instant) | "reminder" (1-hour unread) | "added"
export async function sendSalesChatWhatsApp({ to, name, kind, customer, product, from, preview, unread = 1, mentioned = false, link }) {
    const head = kind === "added" ? "ADDED TO AN ENQUIRY CHAT" : kind === "reminder" ? "UNREAD MESSAGES" : "NEW MESSAGE";
    const lead = kind === "added"
        ? `${bold(from || "A teammate")} added you to the chat for the enquiry from ${bold(customer)}.`
        : kind === "reminder"
            ? `You have ${bold(unread === 1 ? "1 unread message" : `${unread} unread messages`)} in the enquiry chat for ${bold(customer)}${mentioned ? ", including one where you were tagged" : ""}.`
            : `${bold(from || "A teammate")} sent a message in the enquiry chat for ${bold(customer)}.`;
    const quote = clean(preview) ? `${kind === "reminder" && from ? `${clean(from)}: ` : ""}"${clean(preview).slice(0, 160)}"` : null;
    const message = join([
        bold(head), "", `Hello ${clean(name) || "there"},`, "", lead,
        field("Product", product), quote, "",
        link ? `Open chat: ${clean(link)}` : null, "", sign(),
    ]);
    return sendWhatsAppText({ to, message, kind: `sales_chat_${kind || "new"}` });
}