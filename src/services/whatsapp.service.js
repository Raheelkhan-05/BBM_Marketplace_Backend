// services/whatsapp.service.js
//
// WhatsApp messaging through the DealSMS gateway (https://dealsms.in), replacing the Meta Cloud API.
// DealSMS sends ordinary text messages from a linked WhatsApp number, so there are no templates to get approved:
// every message below is written in full here and can be changed at any time.
//
// Every exported helper keeps the same name and arguments as before, so existing call sites do not change:
//   sendOrderUpdateWhatsApp, sendSalesQuotationWhatsApp, sendOrderProcessedWhatsApp, sendOrderPlacedWhatsApp
//
// Environment (.env):
//   DEALSMS_ACCESS_TOKEN=...        your DealSMS access token
//   DEALSMS_INSTANCE_ID=...         the instance that is linked to the sending WhatsApp number
//   DEALSMS_BASE_URL=https://dealsms.in/api     (optional)
//   DEALSMS_GAP_MS=1500             (optional) pause between two messages, keeps sending human-paced
//
// Never put the token in the code or in git.

const BASE_URL = (process.env.DEALSMS_BASE_URL || "https://dealsms.in/api").replace(/\/+$/, "");
const ACCESS_TOKEN = process.env.DEALSMS_ACCESS_TOKEN;
const INSTANCE_ID = process.env.DEALSMS_INSTANCE_ID;
const GAP_MS = Number(process.env.DEALSMS_GAP_MS) || 1500;
const TIMEOUT_MS = 15000;
const MAX_LEN = 3800;                       // stay well under WhatsApp's message limit
const BRAND = "BBM Marketplace";
const RULE = "━━━━━━━━━━━━━━━━━━";

/* ------------------------------ sending ------------------------------ */

function toE164(rawPhone) {
    if (!rawPhone) return null;
    const digits = String(rawPhone).replace(/[^\d]/g, "");
    if (!digits) return null;
    // Assumes Indian 10-digit numbers when no country code is present. Adjust if you onboard users outside India.
    if (digits.length === 10) return `91${digits}`;
    return digits;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Messages go out one at a time with a short pause between them. WhatsApp can restrict a number that sends in bursts.
let chain = Promise.resolve();
function enqueue(task) {
    const run = chain.then(task);
    chain = run.catch(() => { /* a failed send must not block the next one */ }).then(() => sleep(GAP_MS));
    return run;
}

// Low-level: send one text message. Best effort: never throws, so a WhatsApp problem can never break an order or a status change.
export async function sendWhatsAppText({ to, message }) {
    const number = toE164(to);
    if (!number) {
        console.warn("[whatsapp] skipped: no valid phone number", { to });
        return { success: false, skipped: true };
    }
    if (!ACCESS_TOKEN || !INSTANCE_ID) {
        console.error("[whatsapp] DEALSMS_ACCESS_TOKEN / DEALSMS_INSTANCE_ID not configured");
        return { success: false, skipped: true };
    }
    const text = String(message || "").trim().slice(0, MAX_LEN);
    if (!text) return { success: false, skipped: true };

    return enqueue(async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(`${BASE_URL}/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ number, type: "text", message: text, instance_id: INSTANCE_ID, access_token: ACCESS_TOKEN }),
                signal: ctl.signal,
            });
            let data = {};
            try { data = await res.json(); } catch { /* non-JSON reply */ }
            const bad = !res.ok || data?.status === "error" || data?.success === false || data?.error;
            if (bad) {
                console.error("[whatsapp] send failed", { to: number, status: res.status, response: data });
                return { success: false, error: data };
            }
            return { success: true, data };
        } catch (err) {
            console.error("[whatsapp] send threw", err?.name === "AbortError" ? "timeout" : (err?.message || err));
            return { success: false, error: err?.message || String(err) };
        } finally {
            clearTimeout(timer);
        }
    });
}

// Kept only so older imports do not break. Templates no longer exist: the variables are simply sent as lines of text.
export async function sendWhatsAppTemplate({ to, bodyParams = [] }) {
    return sendWhatsAppText({ to, message: bodyParams.filter(Boolean).join("\n\n") });
}

/* ------------------------------ message building ------------------------------ */

// *bold* in WhatsApp breaks if the text itself contains an asterisk, so strip them from names.
const bold = (t) => `*${String(t ?? "").replace(/\*/g, "").trim()}*`;
const clean = (v) => String(v ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
const money = (n) => (typeof n === "string" ? n : "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const field = (label, value) => (clean(value) ? `${bold(label)}: ${clean(value)}` : null);
// null / false / undefined entries are dropped; "" stays and becomes a blank line.
const join = (parts, sep = "\n") => parts.filter((p) => p != null && p !== false).join(sep);
const sign = () => `_${BRAND}_`;

// Items as a numbered list. Accepts structured items, or the old single "itemsLine" string ("1) A - ...; 2) B - ...").
function itemsBlock({ items, itemsLine }) {
    let list = Array.isArray(items) ? items : null;
    if (!list || !list.length) {
        list = clean(itemsLine).split(/;\s*/).map((s) => s.replace(/^\d+\)\s*/, "").trim()).filter(Boolean).map((t) => ({ text: t }));
    }
    const MAX_ITEMS = 12;
    const shown = list.slice(0, MAX_ITEMS).map((i, n) => {
        if (i.text) return `${n + 1}. ${i.text}`;
        return join([
            `${n + 1}. ${bold(i.productName)}${i.brandName ? ` (${clean(i.brandName)})` : null}`,
            i.qtyText ? `    ${clean(i.qtyText)}` : null,
            i.packText ? `    ${clean(i.packText)}` : null,
            i.lineTotal != null ? `    Amount: ${money(i.lineTotal)}` : null,
        ]);
    });
    if (list.length > MAX_ITEMS) shown.push(`…and ${list.length - MAX_ITEMS} more item${list.length - MAX_ITEMS === 1 ? "" : "s"}.`);
    return shown.join("\n\n");
}

/* ------------------------------ generic order update ------------------------------ */

// One shape for the order events that already call this (payment verified, confirmed, rejected, delivered ...).
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
        sign(),
    ]);
    return sendWhatsAppText({ to, message });
}

/* ------------------------------ sales quotation ------------------------------ */

export async function sendSalesQuotationWhatsApp({ to, customerName, sellerName, enquiryProduct, itemsLine, items, total, validUntil, closing }) {
    const message = join([
        `${bold("Quotation")} 🧾`,
        "",
        `Hello ${clean(customerName) || "there"},`,
        "",
        `${bold(sellerName)} has shared a quotation for your enquiry: ${bold(enquiryProduct)}.`,
        "",
        RULE,
        bold("Items"),
        itemsBlock({ items, itemsLine }),
        RULE,
        "",
        field("Total (incl. GST)", total),
        field("Valid until", validUntil),
        "",
        clean(closing) || "Please get in touch with us to confirm your order.",
        "",
        sign(),
    ]);
    return sendWhatsAppText({ to, message });
}

/* ------------------------------ order book: order received ------------------------------ */

// Sent the moment the salesperson punches the order: greeting, details received, order + billing details.
// items: [{ productName, brandName, qtyText, packText, lineTotal }]
// billing: { name, gstin, phone, email, address }      totals: { split, taxable, gst, total }
export async function sendOrderPlacedWhatsApp({ to, customerName, companyName, orderNo, placedOn, items, billing, totals, notes, itemsLine, billingLine, total }) {
    const b = billing || {};
    const hasBilling = b.name || b.gstin || b.address || b.phone || b.email;
    const t = totals || {};

    const billingBlock = hasBilling
        ? join([
            `${bold("Billing Details")} 🧾`,
            field("Billed to", b.name),
            field("GSTIN", b.gstin),
            field("Address", b.address),
            field("Mobile", b.phone),
            field("Email", b.email),
        ])
        : (clean(billingLine) ? join([`${bold("Billing Details")} 🧾`, clean(billingLine)]) : null);

    const totalsBlock = join([
        t.split ? field("Taxable value", money(t.taxable)) : null,
        t.split ? field("GST", money(t.gst)) : null,
        `${bold("Order total (incl. GST)")}: ${bold(money(t.total ?? total))}`,
    ]);

    const message = join([
        `${bold("Order Received")} ✅`,
        "",
        `Hello ${clean(customerName) || "there"},`,
        "",
        `Thank you for placing your order with ${bold(companyName || "our team")}. We have received your details and your order has been recorded.`,
        "",
        field("Order No", orderNo),
        field("Date", placedOn),
        field("Status", "Order received"),
        "",
        RULE,
        `${bold("Your Order")} 📦`,
        itemsBlock({ items, itemsLine }),
        RULE,
        billingBlock,
        billingBlock ? RULE : null,
        totalsBlock,
        clean(notes) ? "" : null,
        clean(notes) ? field("Your notes", notes) : null,
        "",
        "Our team will confirm and process your order shortly, and we will keep you updated at every step.",
        "If anything above looks incorrect, please reply to this message.",
        "",
        `Thank you for choosing ${bold(companyName || "us")}.`,
        sign(),
    ]);
    return sendWhatsAppText({ to, message });
}

/* ------------------------------ order book: order processed ------------------------------ */

export async function sendOrderProcessedWhatsApp({ to, customerName, companyName, orderNo, placedOn, items, itemsLine, total, notes, shopUrl }) {
    const message = join([
        `${bold("Thank You for Your Purchase")} 🙏`,
        "",
        `Hello ${clean(customerName) || "there"},`,
        "",
        `Thank you for your purchase from ${bold(companyName || "our team")}. Your order is confirmed and is now being processed.`,
        "",
        field("Order No", orderNo),
        field("Date", placedOn),
        field("Status", "Processing"),
        "",
        RULE,
        `${bold("Your Order")} 📦`,
        itemsBlock({ items, itemsLine }),
        RULE,
        `${bold("Order total (incl. GST)")}: ${bold(money(total))}`,
        clean(notes) ? "" : null,
        clean(notes) ? field("Your notes", notes) : null,
        "",
        "We will update you again once your order is shipped. If you have any questions about this order, simply reply to this message.",
        shopUrl ? "" : null,
        shopUrl ? `Visit our shop: ${clean(shopUrl)}` : null,
        "",
        `Thank you once again for choosing ${bold(companyName || "us")}.`,
        sign(),
    ]);
    return sendWhatsAppText({ to, message });
}