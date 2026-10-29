// services/sellerCustomerContact.service.js
// addOne() only writes contact details when it CREATES a customer. When the customer already exists
// (for example picked from "My customers" with no phone / email saved) the contact typed while punching an order or
// sending a quotation was used for that one action and then lost.
// This helper fills the missing contact on the salesperson's own customer row, so it is pre-filled next time.
// It only fills EMPTY fields (never overwrites a saved number / email) and only touches customers assigned to the caller.
import { supabase } from "../config/supabase.js";
import { isUuid } from "./rfqValidation.js";
import { pingCustomersChanged } from "./salesSync.service.js";

// Find the row by customerId (preferred) or by GST number. Returns true when something was saved. Never throws.
export async function fillCustomerContact({ sellerId, companyId, actorId, customerId, gstin, phone, email }) {
    try {
        if (!sellerId || !actorId || (!phone && !email)) return false;

        let q = supabase.from("seller_customers")
            .select("id, contact_phone, contact_email")
            .eq("seller_id", sellerId).eq("assigned_to", actorId);
        if (customerId && isUuid(customerId)) q = q.eq("id", customerId);
        else if (gstin) q = q.eq("gstin", gstin);
        else return false;

        const { data: row, error } = await q.limit(1).maybeSingle();
        if (error) throw error;
        if (!row) return false;

        const patch = {};
        if (phone && !row.contact_phone) patch.contact_phone = phone;
        if (email && !row.contact_email) patch.contact_email = email;
        if (!Object.keys(patch).length) return false;

        const { error: uErr } = await supabase.from("seller_customers").update(patch)
            .eq("id", row.id).eq("seller_id", sellerId).eq("assigned_to", actorId);
        if (uErr) throw uErr;

        Promise.resolve(pingCustomersChanged(companyId, [actorId])).catch(() => { /* best effort */ });
        return true;
    } catch (e) {
        console.error("[customer contact] save failed:", e?.message || e);
        return false;
    }
}