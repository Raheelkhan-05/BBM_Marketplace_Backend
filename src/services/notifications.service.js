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