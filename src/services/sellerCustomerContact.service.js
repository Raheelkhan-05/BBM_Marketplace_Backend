// services/sellerCustomerContact.service.js
// Saves contacts (and a missing address) on the salesperson's OWN customer row.
// A new contact is added next to the existing ones, or merged when the same number / email is already saved.
// Never overwrites anything. Never throws.
import { supabase } from "../config/supabase.js";
import { isUuid } from "./rfqValidation.js";
import { pingCustomersChanged } from "./salesSync.service.js";
import { saveContacts, cleanAddress } from "./customerContacts.service.js";

// contacts: [{ name?, phone?, email? }] (already validated)   address: { address, city, state, pincode }
export async function saveContactsForCustomer({ sellerId, companyId, actorId, customerId, gstin, contacts = [], address }) {
    try {
        if (!sellerId || !actorId) return false;
        const addr = cleanAddress(address);
        if (!contacts.length && !addr.address) return false;

        let q = supabase.from("seller_customers").select("id, address").eq("seller_id", sellerId).eq("assigned_to", actorId);
        if (customerId && isUuid(customerId)) q = q.eq("id", customerId);
        else if (gstin) q = q.eq("gstin", gstin);
        else return false;
        const { data: row, error } = await q.limit(1).maybeSingle();
        if (error) throw error;
        if (!row) return false;

        let changed = false;
        if (contacts.length) {
            const r = await saveContacts(sellerId, row.id, actorId, contacts);
            changed = r.changed;
        }
        if (addr.address && !row.address) {
            const patch = Object.fromEntries(Object.entries(addr).filter(([, v]) => v));
            const { error: uErr } = await supabase.from("seller_customers").update(patch)
                .eq("id", row.id).eq("seller_id", sellerId).is("address", null);
            if (uErr) throw uErr;
            changed = true;
        }
        if (changed) Promise.resolve(pingCustomersChanged(companyId, [actorId])).catch(() => { /* best effort */ });
        return changed;
    } catch (e) {
        console.error("[customer contact] save failed:", e?.message || e);
        return false;
    }
}

// Old single-contact entry point (still used by the quotation flow).
export const fillCustomerContact = ({ phone, email, name, ...rest }) =>
    saveContactsForCustomer({ ...rest, contacts: phone || email ? [{ name: name || "", phone: phone || "", email: email || "" }] : [] });