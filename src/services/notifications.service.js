import { supabase } from "../config/supabase.js";
import { transporter } from "../config/mailer.js";
import { getIO } from "../socket/io.js";

const FROM_ADDRESS = process.env.SMTP_FROM || process.env.SMTP_USER;

async function sendMail({ to, subject, html }) {
    if (!to) return;
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject, html });
}

// Pushes over the SAME socket.io room chat already uses (`user:${userId}`,
// joined in socket/chatSocket.js on connect) — not Supabase Realtime, which
// the frontend never actually listens to. Safe no-op if the user has no
// live socket connection right now; they'll just get it on next fetch.
function emitNotification(userId, notification) {
    try {
        getIO().to(`user:${userId}`).emit("notification:new", notification);
    } catch (err) {
        console.error("[notifications] emit failed (socket.io not initialized?):", err.message);
    }
}

export async function notifyUser({ userId, type, title, body, link, email, emailSubject, emailHtml }) {
    if (!userId) {
        console.warn("[notifyUser] skipped — no userId provided", type);
        return;
    }

    const { data, error } = await supabase
        .from("notifications")
        .insert({ user_id: userId, type, title, body, link })
        .select()
        .single();
    if (error) { console.error("[notifyUser] insert failed", error); return; }

    emitNotification(userId, data);

    if (email && emailSubject && emailHtml) {
        try { await sendMail({ to: email, subject: emailSubject, html: emailHtml }); }
        catch (e) { console.error("[notifyUser] email failed", e.message); }
    }
}

export async function notifyAdmins({ type, title, body, link, emailSubject, emailHtml }) {
    const { data: admins, error } = await supabase.from("profiles").select("id, email").eq("role", "admin");
    if (error) return console.error("[notifyAdmins] fetch admins failed", error);
    if (!admins?.length) return;

    const rows = admins.map((a) => ({ user_id: a.id, type, title, body, link }));
    const { data: inserted, error: insertError } = await supabase.from("notifications").insert(rows).select();
    if (insertError) return console.error("[notifyAdmins] insert failed", insertError);

    inserted.forEach((row) => emitNotification(row.user_id, row));

    if (emailSubject && emailHtml) {
        await Promise.all(
            admins.filter((a) => a.email)
                .map((a) => sendMail({ to: a.email, subject: emailSubject, html: emailHtml }).catch((e) => console.error("[notifyAdmins] email failed", a.email, e.message)))
        );
    }
}

export async function notifySellerSubmissionsChanged(userId) {
    if (!userId) return;
    try { getIO().to(`user:${userId}`).emit("submissions_changed", {}); }
    catch (err) { console.error("[notifications] submissions_changed emit failed:", err.message); }
}

export async function notifyAdminSubmissionsChanged() {
    try { getIO().to("admin-submissions").emit("submissions_changed", {}); }
    catch (err) { console.error("[notifications] admin submissions_changed emit failed:", err.message); }
}

// Distinct room from "admin-submissions" so an admin payments-queue page
// can listen just for payment-proof / wallet-top-up activity without
// refetching on every unrelated catalog submission change.
export async function notifyAdminPaymentsChanged() {
    try { getIO().to("admin-payments").emit("payments_changed", {}); }
    catch (err) { console.error("[notifications] admin payments_changed emit failed:", err.message); }
}

// Distinct from notifySellerSubmissionsChanged (product listings) — this
// is for the seller's own shop profile status changing (approve/reject/
// pending_changes cleared). Kept as its own event name so a listener on
// the onboarding/dashboard page can react specifically to "your shop
// status changed" without also firing on every unrelated product-listing
// update this seller happens to have.
export async function notifySellerProfileChanged(userId) {
    if (!userId) return;
    try { getIO().to(`user:${userId}`).emit("seller_profile_changed", {}); }
    catch (err) { console.error("[notifications] seller_profile_changed emit failed:", err.message); }
}