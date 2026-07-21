// src/config/mailer.js

import nodemailer from "nodemailer";

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

export const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT) || 587,
  secure: Number(SMTP_PORT) === 465, // true for 465, false for 587 (STARTTLS)
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// Fail fast in dev if credentials are wrong, rather than discovering it
// the first time a user tries to sign up.
export async function verifyMailer() {
  try {
    await transporter.verify();
    console.log("[mailer] SMTP connection OK");
  } catch (err) {
    console.error("[mailer] SMTP connection failed:", err.message);
  }
}