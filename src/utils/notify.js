import { supabase } from "../config/supabase.js";
import { resend } from "../config/mailer.js";

const FROM_ADDRESS = process.env.SMTP_FROM;

async function sendMail({ to, subject, html }) {
  if (!to) return; // no email on file — skip silently, in-app notification still landed
  const { error } = await resend.emails.send({ from: FROM_ADDRESS, to, subject, html });
  if (error) throw Object.assign(new Error(error.message || "Email send failed"), { cause: error });
}

export async function notifyUser({ userId, type, title, body, link, email, emailSubject, emailHtml }) {
  const { error } = await supabase.from("notifications").insert({ user_id: userId, type, title, body, link });
  if (error) console.error("[notifyUser] insert failed", error);

  if (email && emailSubject && emailHtml) {
    try {
      await sendMail({ to: email, subject: emailSubject, html: emailHtml });
    } catch (e) {
      console.error("[notifyUser] email failed", e.message);
    }
  }
}

export async function notifyAdmins({ type, title, body, link, emailSubject, emailHtml }) {
  const { data: admins, error } = await supabase.from("profiles").select("id, email").eq("role", "admin");
  if (error) return console.error("[notifyAdmins] fetch admins failed", error);
  if (!admins?.length) return;

  const rows = admins.map((a) => ({ user_id: a.id, type, title, body, link }));
  const { error: insertError } = await supabase.from("notifications").insert(rows);
  if (insertError) console.error("[notifyAdmins] insert failed", insertError);

  if (emailSubject && emailHtml) {
    await Promise.all(
      admins
        .filter((a) => a.email)
        .map((a) => sendMail({ to: a.email, subject: emailSubject, html: emailHtml }).catch((e) => console.error("[notifyAdmins] email failed", a.email, e.message)))
    );
  }
}