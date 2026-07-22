// src/services/mail.service.js

import { transporter } from "../config/mailer.js";

const FROM = process.env.SMTP_FROM || '"BBM" <communication@bbmpvtltd.com>';
const BRAND_TEAL = "#047084";
const BRAND_ORANGE = "#d2462b";

function shell(title, bodyHtml) {
  return `
  <div style="background:#f4f7f8;padding:32px 0;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #eef1f2;">
      <tr>
        <td style="background:linear-gradient(135deg, ${BRAND_TEAL}, #7fb3bd);padding:20px 28px;">
          <span style="color:#ffffff;font-size:16px;font-weight:800;letter-spacing:0.3px;">BBM</span>
        </td>
      </tr>
      <tr>
        <td style="padding:28px 28px 8px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${title}</h1>
          ${bodyHtml}
        </td>
      </tr>
      <tr>
        <td style="padding:20px 28px 28px;">
          <p style="margin:0;font-size:11.5px;color:#94a3b8;">
            You're receiving this because an account was created or updated on BBM
            using this email address. If this wasn't you, you can ignore this email.
          </p>
        </td>
      </tr>
    </table>
  </div>`;
}

export async function sendWelcomeEmail(toEmail, name) {
  if (!toEmail) return; // email is optional at signup
  const html = shell(
    `Welcome to BBM, ${name || "there"} 👋`,
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
       Your account is ready. You can start sourcing materials right away —
       and open a storefront to sell any time, using the same login.
     </p>
     <a href="https://your-domain.com/home" style="display:inline-block;margin-top:6px;background:${BRAND_ORANGE};color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 22px;border-radius:10px;">
       Go to marketplace
     </a>`
  );
  return transporter.sendMail({
    from: FROM,
    to: toEmail,
    subject: "Welcome to BBM — your account is ready",
    html,
  });
}

export async function sendBusinessPendingEmail(toEmail, businessName) {
  if (!toEmail) return;
  const html = shell(
    "We're verifying your business details",
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
       Thanks for adding <strong>${businessName}</strong>. We're checking your
       GSTIN against compliance records — this usually takes a few minutes,
       occasionally longer. We'll email you the moment it's done.
     </p>`
  );
  return transporter.sendMail({
    from: FROM,
    to: toEmail,
    subject: "Your business details are being verified",
    html,
  });
}

export async function sendBusinessVerifiedEmail(toEmail, businessName) {
  if (!toEmail) return;
  const html = shell(
    "You're verified to sell on BBM ✅",
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
       <strong>${businessName}</strong> is verified. You can list products
       and open your storefront whenever you're ready.
     </p>
     <a href="https://your-domain.com/seller/onboarding" style="display:inline-block;margin-top:6px;background:${BRAND_TEAL};color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 22px;border-radius:10px;">
       Open your shop
     </a>`
  );
  return transporter.sendMail({
    from: FROM,
    to: toEmail,
    subject: "You're verified to sell on BBM",
    html,
  });
}

// Add alongside sendWelcomeEmail / sendBusinessPendingEmail / sendBusinessVerifiedEmail,
// reusing whatever transport those already use.
export async function sendOtpEmail(email, otp) {
  return transporter.sendMail({
    from: FROM,
    to: email,
    subject: "Your verification code",
    html: shell(
      "Your verification code",
      `<p style="margin:0;font-size:14px;line-height:1.6;color:#475569;">
         Your code is <strong style="font-size:18px;letter-spacing:2px;">${otp}</strong>.
         It expires in 5 minutes.
       </p>`
    ),
  });
}