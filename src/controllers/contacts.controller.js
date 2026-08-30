import { supabaseAdmin } from "../config/supabase.js";

export async function syncContacts(req, res) {
    const userId = req.user?.id; // adjust if your requireAuth middleware names it differently
    const { contacts } = req.body; // expected: [[number, name], [number, name], ...]

    if (!userId) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    if (!Array.isArray(contacts) || contacts.length === 0) {
        return res.json({ success: true, synced: 0 });
    }

    const changed = contacts
        .filter(([number, name]) => number && name)
        .map(([number, name]) => ({ number, name }));

    // 1. Ensure every number exists in `contacts` (upsert avoids duplicates)
    const { data: upserted, error: contactsErr } = await supabaseAdmin
        .from("contacts")
        .upsert(
            changed.map((c) => ({ normalized_number: c.number })),
            { onConflict: "normalized_number", ignoreDuplicates: false }
        )
        .select("id, normalized_number");

    if (contactsErr) {
        return res.status(500).json({ success: false, message: contactsErr.message });
    }

    const idByNumber = new Map(upserted.map((r) => [r.normalized_number, r.id]));

    // 2. Save this user's name for each number
    const { error: savesErr } = await supabaseAdmin.from("contact_saves").upsert(
        changed.map((c) => ({
            contact_id: idByNumber.get(c.number),
            saved_by_user_id: userId,
            saved_name: c.name,
            raw_number: c.number,
            last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })),
        { onConflict: "contact_id,saved_by_user_id" }
    );

    if (savesErr) {
        return res.status(500).json({ success: false, message: savesErr.message });
    }

    return res.json({ success: true, synced: changed.length });
}

export async function pendingSyncContacts(req, res) {
    const { deviceId, contacts } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "Missing deviceId" });
    }
    if (!Array.isArray(contacts) || contacts.length === 0) {
        return res.json({ success: true, synced: 0 });
    }

    const changed = contacts
        .filter(([number, name]) => number && name)
        .map(([number, name]) => ({ number, name }));

    // 1. Ensure every number exists in `contacts` (same as before — global dedup)
    const { data: upserted, error: contactsErr } = await supabaseAdmin
        .from("contacts")
        .upsert(
            changed.map((c) => ({ normalized_number: c.number })),
            { onConflict: "normalized_number", ignoreDuplicates: false }
        )
        .select("id, normalized_number");

    if (contactsErr) {
        return res.status(500).json({ success: false, message: contactsErr.message });
    }

    const idByNumber = new Map(upserted.map((r) => [r.normalized_number, r.id]));

    // 2. Save into pending_contact_saves, keyed by device_id (no user yet)
    const { error: pendingErr } = await supabaseAdmin.from("pending_contact_saves").upsert(
        changed.map((c) => ({
            contact_id: idByNumber.get(c.number),
            device_id: deviceId,
            saved_name: c.name,
            raw_number: c.number,
            updated_at: new Date().toISOString(),
        })),
        { onConflict: "contact_id,device_id" }
    );

    if (pendingErr) {
        return res.status(500).json({ success: false, message: pendingErr.message });
    }

    return res.json({ success: true, synced: changed.length });
}

export async function claimPendingContacts(req, res) {
    const userId = req.user?.id;
    const { deviceId } = req.body;

    if (!userId) return res.status(401).json({ success: false, message: "Not authenticated" });
    if (!deviceId) return res.status(400).json({ success: false, message: "Missing deviceId" });

    const { data: pending, error: fetchErr } = await supabaseAdmin
        .from("pending_contact_saves")
        .select("contact_id, saved_name, raw_number")
        .eq("device_id", deviceId);

    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!pending || pending.length === 0) return res.json({ success: true, claimed: 0 });

    const { error: savesErr } = await supabaseAdmin.from("contact_saves").upsert(
        pending.map((p) => ({
            contact_id: p.contact_id,
            saved_by_user_id: userId,
            saved_name: p.saved_name,
            raw_number: p.raw_number,
            last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })),
        { onConflict: "contact_id,saved_by_user_id" }
    );

    if (savesErr) return res.status(500).json({ success: false, message: savesErr.message });

    // Mark as claimed (never delete — keeps history per your earlier decision)
    await supabaseAdmin
        .from("pending_contact_saves")
        .update({ claimed_by_user_id: userId, updated_at: new Date().toISOString() })
        .eq("device_id", deviceId);

    return res.json({ success: true, claimed: pending.length });
}