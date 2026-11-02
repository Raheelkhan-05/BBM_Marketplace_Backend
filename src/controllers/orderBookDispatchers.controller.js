// Dispatchers: people who get an instant WhatsApp / email when a salesperson punches an order.
// Team side only (admin + members). Scoped to the company (req.user.id), like the rest of the team order book.
import { supabase } from "../config/supabase.js";
import { isUuid } from "../services/rfqValidation.js";
import { str, cleanPhone, cleanEmail } from "../services/salesThreads.service.js";

const MAX_DISPATCHERS = 10;
const COLS = "id, name, phone, email, active, created_at";
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const oops = (res, e) => { console.error("[dispatchers]", e?.message || e); return fail(res, 500, "Something went wrong. Please try again."); };

function parse(b, { partial = false } = {}) {
    const out = {};
    if (!partial || "name" in b) {
        out.name = str(b.name, 80);
        if (out.name.length < 2) return { error: "Enter the dispatcher's name." };
    }
    if (!partial || "phone" in b) {
        const raw = str(b.phone, 20), p = raw ? cleanPhone(raw) : "";
        if (raw && !p) return { error: "Enter a valid 10-digit WhatsApp number, or leave it empty." };
        out.phone = p || null;
    }
    if (!partial || "email" in b) {
        const raw = str(b.email, 200), e = raw ? cleanEmail(raw) : "";
        if (raw && !e) return { error: "Enter a valid email address, or leave it empty." };
        out.email = e || null;
    }
    if ("active" in b) out.active = b.active === true;
    return { value: out };
}

const dupMsg = (e) => (e?.code === "23505" ? "This WhatsApp number or email is already added." : null);

export async function listDispatchers(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const { data, error } = await supabase.from("order_book_dispatchers").select(COLS)
            .eq("company_id", req.user.id).order("created_at", { ascending: true });
        if (error) throw error;
        res.json({ success: true, items: data || [], max: MAX_DISPATCHERS });
    } catch (e) { oops(res, e); }
}

export async function addDispatcher(req, res) {
    try {
        const p = parse(req.body || {});
        if (p.error) return fail(res, 400, p.error);
        if (!p.value.phone && !p.value.email) return fail(res, 400, "Add a WhatsApp number or an email (at least one).");

        const { count, error: cErr } = await supabase.from("order_book_dispatchers")
            .select("id", { count: "exact", head: true }).eq("company_id", req.user.id);
        if (cErr) throw cErr;
        if ((count || 0) >= MAX_DISPATCHERS) return fail(res, 409, `You can add up to ${MAX_DISPATCHERS} dispatchers.`);

        const { data, error } = await supabase.from("order_book_dispatchers")
            .insert({ ...p.value, company_id: req.user.id, created_by: req.actor?.id || req.user.id })
            .select(COLS).single();
        if (error) { const m = dupMsg(error); if (m) return fail(res, 409, m); throw error; }
        res.json({ success: true, item: data });
    } catch (e) { oops(res, e); }
}

export async function updateDispatcher(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return fail(res, 404, "Dispatcher not found.");
        const p = parse(req.body || {}, { partial: true });
        if (p.error) return fail(res, 400, p.error);
        if (!Object.keys(p.value).length) return fail(res, 400, "Nothing to update.");

        const { data: cur, error: gErr } = await supabase.from("order_book_dispatchers").select(COLS)
            .eq("id", id).eq("company_id", req.user.id).maybeSingle();
        if (gErr) throw gErr;
        if (!cur) return fail(res, 404, "Dispatcher not found.");
        const next = { ...cur, ...p.value };
        if (!next.phone && !next.email) return fail(res, 400, "Keep a WhatsApp number or an email.");

        const { data, error } = await supabase.from("order_book_dispatchers").update(p.value)
            .eq("id", id).eq("company_id", req.user.id).select(COLS).single();
        if (error) { const m = dupMsg(error); if (m) return fail(res, 409, m); throw error; }
        res.json({ success: true, item: data });
    } catch (e) { oops(res, e); }
}

export async function removeDispatcher(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return fail(res, 404, "Dispatcher not found.");
        const { error } = await supabase.from("order_book_dispatchers").delete().eq("id", id).eq("company_id", req.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) { oops(res, e); }
}