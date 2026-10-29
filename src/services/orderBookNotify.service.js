// services/orderBookNotify.service.js
// Customer-facing messages for the Order Book, sent on behalf of the selling company. Best effort only:
// nothing here may ever fail or slow down punching an order or changing its status.
//   notifyOrderPlaced     -> when the salesperson punches the order: greeting, "we have your details", order + billing details
//   notifyOrderProcessed  -> when the team marks it processed: "thank you for your purchase"
import { supabase } from "../config/supabase.js";
import { sendOrderProcessedEmail, sendOrderPlacedEmail } from "./mail.service.js";
import { sendOrderProcessedWhatsApp, sendOrderPlacedWhatsApp } from "./whatsapp.service.js";

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
const dateFmt = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "");

/* ------------------------------ order placed ------------------------------ */

// "5 master packs x ₹1,200 per master pack" + "5,000 Kg in total" (pack-based lines), or "500 Kg x ₹2.47" (older / typed lines).
function describeLine(i) {
    const n = Number(i.quantity);
    if (i.basis) {
        const master = i.basis === "per_master_pack";
        const word = master ? (n === 1 ? "master pack" : "master packs") : (n === 1 ? "pack" : "packs");
        return {
            qtyText: `${qtyFmt(n)} ${word} × ${inr(i.unitPrice, 4)} per ${master ? "master pack" : "pack"}`,
            packText: Number(i.totalUnits) > 0 ? `${qtyFmt(i.totalUnits)} ${i.baseUnit || ""} in total`.trim() : "",
        };
    }
    return { qtyText: `${qtyFmt(n)} ${i.unit} × ${inr(i.unitPrice, 4)}`, packText: "" };
}

// Prices are saved GST included. When every line has its GST % (catalog products), split the total into taxable value + GST.
function billingTotals(items, total) {
    let taxable = 0, known = items.length > 0;
    for (const i of items) {
        const g = i.details?.gstPercent;
        if (g == null || !Number.isFinite(Number(g))) { known = false; break; }
        taxable += Number(i.lineTotal || 0) / (1 + Number(g) / 100);
    }
    if (!known) return { split: false, taxable: 0, gst: 0, total };
    const t = Math.round(taxable * 100) / 100;
    return { split: true, taxable: t, gst: Math.round((total - t) * 100) / 100, total };
}

// `row` is the raw order_book_orders row that was just inserted.
export async function notifyOrderPlaced(row) {
    try {
        const phone = row.customer_phone || "";
        const email = row.customer_email || "";
        if (!phone && !email) return;

        const shop = await loadShop(row.seller_id);
        const companyName = shop.name || "our team";
        const raw = Array.isArray(row.items) ? row.items : [];
        const items = raw.map((i) => ({
            productName: i.productName, brandName: i.brandName || "", lineTotal: Number(i.lineTotal) || 0, ...describeLine(i),
        }));
        const total = Number(row.total_amount) || items.reduce((a, i) => a + i.lineTotal, 0);
        const totals = billingTotals(raw, total);
        const placedOn = dateFmt(row.created_at);
        const place = [row.customer_city, row.customer_state, row.customer_pincode].filter(Boolean).join(", ");
        const address = [row.customer_address, place && !String(row.customer_address || "").includes(place) ? place : ""].filter(Boolean).join(", ");
        const billing = { name: row.customer_name, gstin: row.customer_gstin || "", phone, email, address };

        const jobs = [];
        if (email) {
            jobs.push(sendOrderPlacedEmail({
                to: email, customerName: row.customer_name, companyName, orderNo: row.order_no, placedOn,
                items, billing, totals, notes: row.notes, shopUrl: shop.url,
            }));
        }
        if (phone) {
            const itemsLine = items
                .map((i, n) => `${n + 1}) ${i.productName} - ${i.qtyText}${i.packText ? ` (${i.packText})` : ""} = ${inr(i.lineTotal)}`)
                .join("; ")
                .slice(0, 900);
            const billingLine = (
                `Billed to ${billing.name}${billing.gstin ? `, GSTIN ${billing.gstin}` : ""}${address ? `, ${address}` : ""}. `
                + (totals.split ? `Taxable value ${inr(totals.taxable)}, GST ${inr(totals.gst)}.` : "All prices include GST.")
            ).slice(0, 500);
            jobs.push(sendOrderPlacedWhatsApp({
                to: phone, customerName: row.customer_name, companyName, orderNo: row.order_no,
                itemsLine, billingLine, total: inr(total),
            }));
        }
        const results = await Promise.allSettled(jobs);
        results.forEach((r) => {
            if (r.status === "rejected") console.error("[order book] order-placed notification failed:", r.reason?.message || r.reason);
        });
    } catch (e) {
        console.error("[order book] notifyOrderPlaced failed:", e?.message || e);
    }
}

/* ------------------------------ order processed (unchanged) ------------------------------ */

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
        const placedOn = dateFmt(row.created_at);

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