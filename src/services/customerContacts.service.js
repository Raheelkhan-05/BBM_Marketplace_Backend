// services/customerContacts.service.js
// Many contacts per seller customer (table seller_customer_contacts) + address helpers.
// A DB trigger keeps seller_customers.contact_* equal to the primary contact, so older code keeps working.
import { supabase } from "../config/supabase.js";
import { str, cleanPhone, cleanEmail } from "./salesThreads.service.js";

export const MAX_CONTACTS = 20;
const COLS = "id, customer_id, name, phone, email, is_primary, created_at";

export const contactDto = (r) => ({
    id: r.id, name: r.name || "", phone: r.phone || "", email: r.email || "", isPrimary: !!r.is_primary,
});

// One contact typed by the salesperson: the name is optional, but a mobile number or an email is required.
export function parseContact(raw) {
    const name = str(raw?.name, 80);
    const phoneRaw = str(raw?.phone, 20), emailRaw = str(raw?.email, 200);
    const phone = phoneRaw ? cleanPhone(phoneRaw) : "";
    const email = emailRaw ? cleanEmail(emailRaw) : "";
    if (phoneRaw && !phone) return { error: "Enter a valid 10-digit mobile number." };
    if (emailRaw && !email) return { error: "Enter a valid email address." };
    if (!phone && !email) return { error: "Add a mobile number or an email for the contact." };
    return { name, phone, email };
}

// Validates a list and merges entries that share a number / email. -> { list } | { error }
export function parseContactList(list, max = MAX_CONTACTS) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const c = parseContact(raw);
        if (c.error) return { error: c.error };
        const hit = out.find((o) => (c.phone && o.phone === c.phone) || (c.email && o.email === c.email));
        if (hit) {
            if (!hit.name && c.name) hit.name = c.name;
            if (!hit.phone && c.phone) hit.phone = c.phone;
            if (!hit.email && c.email) hit.email = c.email;
            continue;
        }
        out.push({ ...c });
        if (out.length > max) return { error: `You can add up to ${max} contacts.` };
    }
    return { list: out };
}

// customerIds -> Map(customerId -> contacts[]), primary first, then oldest first
export async function loadContacts(customerIds) {
    const ids = [...new Set((customerIds || []).filter(Boolean))];
    const map = new Map();
    if (!ids.length) return map;
    const { data, error } = await supabase.from("seller_customer_contacts").select(COLS)
        .in("customer_id", ids)
        .order("is_primary", { ascending: false }).order("created_at", { ascending: true }).order("id", { ascending: true });
    if (error) throw error;
    for (const r of data || []) {
        const l = map.get(r.customer_id) || [];
        l.push(r); map.set(r.customer_id, l);
    }
    return map;
}

// Adds a contact, or merges into the one that already has the same number / email (only fills what is empty).
async function upsertOne(cur, { sellerId, customerId, actorId, contact, makePrimary }) {
    const { name, phone, email } = contact;
    const hit = cur.find((c) => (phone && c.phone === phone) || (email && c.email && c.email.toLowerCase() === email));
    if (hit) {
        const patch = {};
        if (name && !hit.name) patch.name = name;
        if (phone && !hit.phone) patch.phone = phone;
        if (email && !hit.email) patch.email = email;
        if (makePrimary && !hit.is_primary) patch.is_primary = true;
        if (!Object.keys(patch).length) return { contact: hit, created: false, changed: false };
        const { data, error } = await supabase.from("seller_customer_contacts").update(patch).eq("id", hit.id).select(COLS).single();
        if (error) {
            if (error.code === "23505") return { contact: hit, created: false, changed: false };   // the other field belongs to another contact
            throw error;
        }
        if (patch.is_primary) cur.forEach((c) => { c.is_primary = false; });
        Object.assign(hit, data);
        return { contact: hit, created: false, changed: true };
    }
    if (cur.length >= MAX_CONTACTS) return { error: `A customer can have up to ${MAX_CONTACTS} contacts.` };
    const { data, error } = await supabase.from("seller_customer_contacts").insert({
        customer_id: customerId, seller_id: sellerId, name: name || null, phone: phone || null, email: email || null,
        is_primary: !!makePrimary, created_by: actorId || null,
    }).select(COLS).single();
    if (error) {
        if (error.code === "23505") return { error: "This contact is already saved." };
        throw error;
    }
    if (data.is_primary) cur.forEach((c) => { c.is_primary = false; });
    cur.push(data);
    return { contact: data, created: true, changed: true };
}

const currentOf = async (sellerId, customerId) => {
    const { data, error } = await supabase.from("seller_customer_contacts").select(COLS)
        .eq("customer_id", customerId).eq("seller_id", sellerId);
    if (error) throw error;
    return data || [];
};

export async function saveContact({ sellerId, customerId, actorId, contact, makePrimary = false }) {
    const cur = await currentOf(sellerId, customerId);
    return upsertOne(cur, { sellerId, customerId, actorId, contact, makePrimary });
}

// Saves a list with a single read of the customer's contacts.
export async function saveContacts(sellerId, customerId, actorId, contacts) {
    const list = Array.isArray(contacts) ? contacts : [];
    if (!list.length) return { saved: [], changed: false, error: "" };
    const cur = await currentOf(sellerId, customerId);
    const saved = []; let changed = false, error = "";
    for (const contact of list) {
        const r = await upsertOne(cur, { sellerId, customerId, actorId, contact });
        if (r.error) { error = r.error; continue; }
        saved.push(r.contact); changed = changed || r.changed;
    }
    return { saved, changed, error };
}

// body may carry name / phone / email / isPrimary. Fields that are not sent stay as they are.
export async function updateContact({ sellerId, customerId, contactId, body }) {
    const { data: row, error } = await supabase.from("seller_customer_contacts").select(COLS)
        .eq("id", contactId).eq("customer_id", customerId).eq("seller_id", sellerId).maybeSingle();
    if (error) throw error;
    if (!row) return { status: 404, error: "Contact not found." };
    let name = row.name || "", phone = row.phone || "", email = row.email || "";
    if ("name" in body) name = str(body.name, 80);
    if ("phone" in body) {
        const raw = str(body.phone, 20); phone = raw ? cleanPhone(raw) : "";
        if (raw && !phone) return { status: 400, error: "Enter a valid 10-digit mobile number." };
    }
    if ("email" in body) {
        const raw = str(body.email, 200); email = raw ? cleanEmail(raw) : "";
        if (raw && !email) return { status: 400, error: "Enter a valid email address." };
    }
    if (!phone && !email) return { status: 400, error: "A contact needs a mobile number or an email." };
    const patch = { name: name || null, phone: phone || null, email: email || null };
    if (body.isPrimary === true) patch.is_primary = true;
    const { data, error: uErr } = await supabase.from("seller_customer_contacts").update(patch).eq("id", row.id).select(COLS).single();
    if (uErr) {
        if (uErr.code === "23505") return { status: 409, error: "Another contact already has this number or email." };
        throw uErr;
    }
    return { contact: data };
}

export async function deleteContact({ sellerId, customerId, contactId }) {
    const { data, error } = await supabase.from("seller_customer_contacts").delete()
        .eq("id", contactId).eq("customer_id", customerId).eq("seller_id", sellerId).select("id").maybeSingle();
    if (error) throw error;
    return data ? { ok: true } : { status: 404, error: "Contact not found." };
}

// ---- address ----
export function cleanAddress(raw) {
    const pin = String(raw?.pincode || "").replace(/\s/g, "");
    return {
        address: str(raw?.address, 400) || null,
        city: str(raw?.city, 80) || null,
        state: str(raw?.state, 60) || null,
        pincode: /^\d{6}$/.test(pin) ? pin : null,
    };
}

const norm = (s) => String(s || "").normalize("NFKC").replace(/[–—-]/g, " ").replace(/[,\s]+/g, " ").trim().toLowerCase();

// One display line. GST addresses often already contain the city / state / pincode, so only missing parts are appended.
// Falls back to the old "City, State" text when no full address is saved yet.
export function addressText(r) {
    const address = String(r?.address || "").trim();
    const parts = [r?.city, r?.state, r?.pincode].map((x) => String(x || "").trim()).filter(Boolean);
    if (!address) return parts.length ? parts.join(", ") : String(r?.location || "").trim();
    const na = norm(address);
    const missing = parts.filter((p) => !na.includes(norm(p)));
    return missing.length ? `${address}, ${missing.join(", ")}` : address;
}