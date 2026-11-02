// Tells every active dispatcher of the company about a newly punched order.
// Email if they have an email, WhatsApp if they have a number, both if both. Never throws.
import { supabase } from "../config/supabase.js";
import { sendDispatcherOrderWhatsApp } from "./whatsapp.service.js";
import { sendDispatcherOrderEmail } from "./mail.service.js";

const APP_URL = (process.env.APP_URL || "https://bbm.business").replace(/\/+$/, "");
const qty = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 4 });

function itemsOf(row) {
    return (Array.isArray(row.items) ? row.items : []).map((i) => ({
        productName: i.productName,
        brandName: i.brandName || "",
        qtyText: `${qty(i.quantity)} ${i.unit}`,
        packText: i.totalUnits && i.baseUnit ? `Total: ${qty(i.totalUnits)} ${i.baseUnit}` : "",
        lineTotal: i.lineTotal,
    }));
}

export async function notifyDispatchersOrderPlaced(row, { salespersonName } = {}) {
    try {
        const { data: list, error } = await supabase.from("order_book_dispatchers")
            .select("id, name, phone, email").eq("company_id", row.company_id).eq("active", true);
        if (error) throw error;
        if (!list?.length) return;

        let companyName = "";
        if (row.seller_id) {
            const { data } = await supabase.from("seller_profiles").select("display_name").eq("id", row.seller_id).maybeSingle();
            companyName = data?.display_name || "";
        }

        const payload = {
            companyName,
            orderNo: row.order_no,
            poNumber: row.po_number || "",
            placedOn: new Date(row.created_at || Date.now()).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
            }),
            salespersonName: salespersonName || row.salesperson_name || "",
            customer: {
                name: row.customer_name, gstin: row.customer_gstin, phone: row.customer_phone, email: row.customer_email,
                address: [row.customer_address, row.customer_city, row.customer_state, row.customer_pincode].filter(Boolean).join(", "),
            },
            items: itemsOf(row),
            total: row.total_amount,
            notes: row.notes || "",
            link: `${APP_URL}/sell/order-book/${row.id}`,
        };

        const jobs = [];
        for (const d of list) {
            const base = { ...payload, dispatcherName: d.name };
            if (d.phone) jobs.push(sendDispatcherOrderWhatsApp({ to: d.phone, ...base }));
            if (d.email) jobs.push(sendDispatcherOrderEmail({ to: d.email, ...base }));
        }
        const results = await Promise.allSettled(jobs);
        results.forEach((r) => {
            if (r.status === "rejected") console.error("[dispatcher notify] failed:", r.reason?.message || r.reason);
            else if (r.value?.success === false && !r.value?.skipped) console.error("[dispatcher notify] send failed");
        });
    } catch (e) {
        console.error("[dispatcher notify] failed:", e?.message || e);
    }
}