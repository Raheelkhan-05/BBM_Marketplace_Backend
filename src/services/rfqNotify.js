// services/rfqNotify.js
import { supabase } from "../config/supabase.js";
import { notifyUser } from "./notifications.service.js";

const safe = (p) => Promise.resolve(p).catch((e) => console.error("[rfq notify]", e?.message || e));

// ASSUMPTION: admins live in `profiles` with role = 'admin'. Adjust the table/column if yours differ.
async function adminIds() {
    try {
        const { data, error } = await supabase.from("profiles").select("id").eq("role", "admin");
        if (error) throw error;
        return (data || []).map((r) => r.id);
    } catch (e) {
        console.error("[rfq notify] couldn't load admins:", e?.message || e);
        return [];
    }
}

export async function notifyAdminsNewRfq({ count, name, resubmitted = false }) {
    const ids = await adminIds();
    const title = resubmitted ? "RFQ resubmitted for review" : count > 1 ? `${count} new RFQ enquiries to review` : "New RFQ enquiry to review";
    const message = count > 1 ? `${count} enquiries are waiting for your review.` : `"${name}" is waiting for your review.`;
    ids.forEach((id) => safe(notifyUser(id, { type: "rfq_review_needed", title, message, link: "/admin/rfq" })));
}

export function notifyBuyerRfqApproved(buyerId, name) {
    return safe(notifyUser(buyerId, {
        type: "rfq_approved",
        title: "Your enquiry is live",
        message: `"${name}" has been approved and is now visible to suppliers.`,
        link: "/rfq?tab=mine",
    }));
}

export function notifyBuyerRfqRejected(buyerId, name, reason) {
    return safe(notifyUser(buyerId, {
        type: "rfq_rejected",
        title: "Your enquiry needs changes",
        message: `"${name}" wasn't approved: ${reason}`,
        link: "/rfq?tab=mine",
    }));
}