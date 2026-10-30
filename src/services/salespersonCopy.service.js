// services/salespersonCopy.service.js
//
// Sends the salesperson their own "copy" of what a customer was just sent.
// It is a record for the salesperson (delivery status, summary, next step),
// not a duplicate of the customer's message. Never throws.
import { supabase } from "../config/supabase.js";
import { sendSalespersonCopyWhatsApp } from "./whatsapp.service.js";
import { sendSalespersonCopyEmail } from "./mail.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Columns on order_book_orders that may hold the salesperson who created the order.
const CREATOR_KEYS = ["created_by_actor_id", "actor_id", "created_by", "salesperson_id", "punched_by"];

const digits = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
const lower = (v) => String(v ?? "").trim().toLowerCase();

export const creatorIdOf = (row) =>
    CREATOR_KEYS.map((k) => row?.[k]).find((v) => typeof v === "string" && UUID_RE.test(v)) || null;

export async function loadSalesperson(userId) {
    if (!userId || !UUID_RE.test(String(userId))) return null;
    try {
        const { data } = await supabase.from("profiles")
            .select("id, name, phone, email").eq("id", userId).maybeSingle();
        return data || null;
    } catch (e) {
        console.error("[salesperson copy] profile lookup failed:", e?.message || e);
        return null;
    }
}

/**
 * @param {object} p
 * @param {object} p.salesperson   { id, name, phone, email }
 * @param {string} p.title         e.g. "Quotation sent"
 * @param {string} p.customerName
 * @param {string} p.customerPhone
 * @param {string} p.customerEmail
 * @param {Array}  p.facts         [[label, value], ...]
 * @param {Array}  p.items         [{ name, detail, amount }]
 * @param {string} p.total         already formatted, e.g. "₹1,200.00"
 * @param {Array}  p.delivery      [{ channel: "WhatsApp" | "Email", ok: boolean }]
 * @param {string} p.note          one-line next step for the salesperson
 */
export async function sendSalespersonCopy({ salesperson, customerPhone, customerEmail, ...copy }) {
    try {
        if (!salesperson) return;
        const payload = {
            ...copy,
            salespersonName: salesperson.name,
            customerContact: [customerPhone && `+91 ${digits(customerPhone)}`, customerEmail].filter(Boolean).join(" · "),
        };
        const jobs = [];

        // Skip when the salesperson is also the customer's contact, to avoid a duplicate.
        if (salesperson.phone && digits(salesperson.phone) !== digits(customerPhone)) {
            jobs.push(sendSalespersonCopyWhatsApp({ to: salesperson.phone, ...payload }));
        }
        if (salesperson.email && lower(salesperson.email) !== lower(customerEmail)) {
            jobs.push(sendSalespersonCopyEmail({ to: salesperson.email, ...payload }));
        }
        const results = await Promise.allSettled(jobs);
        results.forEach((r) => {
            if (r.status === "rejected") console.error("[salesperson copy] failed:", r.reason?.message || r.reason);
        });
    } catch (e) {
        console.error("[salesperson copy] failed:", e?.message || e);
    }
}