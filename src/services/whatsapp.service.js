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