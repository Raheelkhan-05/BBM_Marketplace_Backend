// services/whatsapp.service.js
//
// Thin wrapper around WhatsApp Cloud API's /messages endpoint. Deliberately
// generic: one low-level sendWhatsAppTemplate() that takes any approved
// template name + ordered body variables, and one high-level
// sendOrderUpdateWhatsApp() that maps a plain {name, headline, detail,
// footer} shape onto our single reusable "order_status_update" utility
// template. Every call site (order placed, payment verified, order
// confirmed/rejected/delivered, wallet blocked) calls ONLY the high-level
// helper — nothing here needs to change to support a new event type.

const WHATSAPP_API_VERSION = "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const ORDER_UPDATE_TEMPLATE_NAME = "order_status_update";
const TEMPLATE_LANGUAGE = "en";

function toE164(rawPhone) {
    if (!rawPhone) return null;
    const digits = String(rawPhone).replace(/[^\d]/g, "");
    if (!digits) return null;
    // Assumes Indian 10-digit numbers when no country code is present —
    // adjust if you onboard users outside India.
    if (digits.length === 10) return `91${digits}`;
    return digits;
}

// Low-level — routes through here for ANY approved template. Keep every
// event-specific helper on top of this one function.
export async function sendWhatsAppTemplate({ to, templateName, languageCode = TEMPLATE_LANGUAGE, bodyParams = [] }) {
    const toPhone = toE164(to);
    if (!toPhone) {
        console.warn("[whatsapp] skipped — no valid phone number", { to });
        return { success: false, skipped: true };
    }
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
        console.error("[whatsapp] WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not configured");
        return { success: false, skipped: true };
    }

    const payload = {
        messaging_product: "whatsapp",
        to: toPhone,
        type: "template",
        template: {
            name: templateName,
            language: { code: languageCode },
            components: bodyParams.length
                ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text: String(text) })) }]
                : [],
        },
    };

    try {
        const res = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
            console.error("[whatsapp] send failed", { to: toPhone, templateName, error: data });
            return { success: false, error: data };
        }
        return { success: true, data };
    } catch (err) {
        // Best-effort, same philosophy as the existing notifyUser()/socket
        // broadcasts — a WhatsApp outage must never break order placement,
        // payment verification, etc.
        console.error("[whatsapp] send threw", err?.message || err);
        return { success: false, error: err?.message || String(err) };
    }
}

// High-level — the ONE shape every event maps onto. bodyParams order here
// MUST match {{1}}, {{2}}, {{3}}, {{4}} in the "order_status_update"
// template exactly:
//   Hello {{1}},
//   {{2}}
//   {{3}}
//   {{4}}
//   If you have any questions about this order, please contact our support team.
export async function sendOrderUpdateWhatsApp({ to, name, headline, detail, footer }) {
    return sendWhatsAppTemplate({
        to,
        templateName: ORDER_UPDATE_TEMPLATE_NAME,
        bodyParams: [
            name || "there",
            headline || "",
            detail || "",
            footer || "Thank you for shopping with BBM Marketplace.",
        ],
    });
}


//
// You must create this UTILITY template in Meta WhatsApp Manager, name: sales_quotation, language: English (en).
// Body (7 variables, in this exact order):
//
//   Hello {{1}},
//
//   {{2}} has shared a quotation for your enquiry: {{3}}.
//
//   Items: {{4}}
//
//   Total (incl. GST): {{5}}
//   Valid until: {{6}}
//
//   {{7}}
//
// Sample values for approval: Acme Traders / BBM Supplies / Stainless Steel Hinges / 1) Hinge 4 inch - 500 Kg x ₹2.47 = ₹1,235.00 - https://bbm.business/p/123 / ₹1,235.00 / 30 Oct 2026 / Please get in touch with us to confirm your order.
// =====================================================================================================
const SALES_QUOTE_TEMPLATE_NAME = "sales_quotation";

export async function sendSalesQuotationWhatsApp({ to, customerName, sellerName, enquiryProduct, itemsLine, total, validUntil, closing }) {
    const v = (x, fallback = "-") => String(x ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim() || fallback;
    return sendWhatsAppTemplate({
        to,
        templateName: SALES_QUOTE_TEMPLATE_NAME,
        bodyParams: [v(customerName, "there"), v(sellerName), v(enquiryProduct), v(itemsLine), v(total), v(validUntil), v(closing)],
    });
}


//
// ORDER BOOK: sent to the customer when the company's team marks their order as processed.
// You must create this UTILITY template in Meta WhatsApp Manager, name: order_processed, language: English (en).
// Body (6 variables, in this exact order):
//
//   Hello {{1}},
//
//   Thank you for your purchase from {{2}}. Your order {{3}} is confirmed and is now being processed.
//
//   Order details: {{4}}
//
//   Order total (incl. GST): {{5}}
//
//   You can view our shop here: {{6}}
//
//   We will update you again once your order is shipped. If you have any questions about this order, please contact {{2}}.
//
// (Meta counts a repeated {{2}} as the same variable; if the form rejects that, reword the last line to
//  "please reply to this message" and the code needs no change.)
// Sample values for approval: Acme Traders / BBM Supplies / ORD-1042 / 1) Hinge 4 inch - 500 Kg x ₹2.47 = ₹1,235.00 / ₹1,235.00 / https://bbm.business/sellers/bbm-supplies
// =====================================================================================================
const ORDER_PROCESSED_TEMPLATE_NAME = "order_processed";

export async function sendOrderProcessedWhatsApp({ to, customerName, companyName, orderNo, itemsLine, total, shopUrl }) {
    const v = (x, fallback = "-") => String(x ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim() || fallback;
    return sendWhatsAppTemplate({
        to,
        templateName: ORDER_PROCESSED_TEMPLATE_NAME,
        bodyParams: [v(customerName, "there"), v(companyName, "our team"), v(orderNo), v(itemsLine), v(total), v(shopUrl)],
    });
}