// src/config/mailer.js
import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY);

// Fail fast in dev/startup logs if the key is missing, rather than
// discovering it the first time a user tries to sign up. Resend has no
// separate "verify connection" call like SMTP does, so this just checks
// the key is present.
export async function verifyMailer() {
  if (!process.env.RESEND_API_KEY) {
    console.error("[mailer] RESEND_API_KEY is not set.");
    return;
  }
  console.log("[mailer] Resend configured");
}