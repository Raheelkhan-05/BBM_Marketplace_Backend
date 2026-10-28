// services/orderBookNotify.service.js
// Customer-facing messages for the Order Book. When the team marks an order as processed, the customer gets a
// "thank you for your purchase" email and WhatsApp message sent on behalf of the selling company.
// Best effort only: nothing here may ever fail or slow down the status change.
import { supabase } from "../config/supabase.js";
import { sendOrderProcessedEmail } from "./mail.service.js";
import { sendOrderProcessedWhatsApp } from "./whatsapp.service.js";

// Where the shop link points: {SITE_URL}/sellers/{slug}. Set FRONTEND_URL=http://localhost:5173 for local testing.
const SITE_URL = (process.env.FRONTEND_URL || process.env.SITE_URL || "https://bbm.business").replace(/\/+$/, "");

// ASSUMPTION: adjust these if your sellers table uses other column names.
const SELLERS_TABLE = "sellers";
const SLUG_KEYS = ["slug", "shop_slug", "store_slug"];
const NAME_KEYS = ["shop_name", "store_name", "business_name", "company_name", "name"];

const firstOf = (obj, keys) => {
    for (const k of keys) {
        const v = obj?.[k];
        if (v && String(v).trim()) return String(v).trim();
    }
    return "";
};

async function loadShop(sellerId) {
    try {
        const { data, error } = await supabase.from(SELLERS_TABLE).select("*").eq("id", sellerId).maybeSingle();
        if (error) throw error;
        const slug = firstOf(data, SLUG_KEYS);
        return { name: firstOf(data, NAME_KEYS), url: slug ? `${SITE_URL}/sellers/${encodeURIComponent(slug)}` : "" };
    } catch (e) {
        console.error("[order book] shop lookup failed:", e?.message || e);
        return { name: "", url: "" };
    }
}

const inr = (n, max = 2) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: max });
const qtyFmt = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 4 });

// `row` is the raw order_book_orders row (as loaded before the status change).
export async function notifyOrderProcessed(row) {
    try {
        const phone = row.customer_phone || "";
        const email = row.customer_email || "";
        if (!phone && !email) return;

        const shop = await loadShop(row.seller_id);
        const companyName = shop.name || "our team";
        const items = (Array.isArray(row.items) ? row.items : []).map((i) => ({
            productName: i.productName, brandName: i.brandName || "", unit: i.unit,
            quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal,
        }));
        const total = Number(row.total_amount) || items.reduce((a, i) => a + Number(i.lineTotal || 0), 0);
        const placedOn = row.created_at
            ? new Date(row.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
            : "";

        const jobs = [];
        if (email) {
            jobs.push(sendOrderProcessedEmail({
                to: email, customerName: row.customer_name, companyName, orderNo: row.order_no, placedOn,
                items, total, notes: row.notes, shopUrl: shop.url,
            }));
        }
        if (phone) {
            const itemsLine = items
                .map((i, n) => `${n + 1}) ${i.productName} - ${qtyFmt(i.quantity)} ${i.unit} x ${inr(i.unitPrice, 4)} = ${inr(i.lineTotal)}`)
                .join("; ")
                .slice(0, 900);
            jobs.push(sendOrderProcessedWhatsApp({
                to: phone, customerName: row.customer_name, companyName, orderNo: row.order_no,
                itemsLine, total: inr(total), shopUrl: shop.url || SITE_URL,
            }));
        }

        const results = await Promise.allSettled(jobs);
        results.forEach((r) => {
            if (r.status === "rejected") console.error("[order book] customer notification failed:", r.reason?.message || r.reason);
        });
    } catch (e) {
        console.error("[order book] notifyOrderProcessed failed:", e?.message || e);
    }
}