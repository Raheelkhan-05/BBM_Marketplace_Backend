// src/services/mail.service.js

import { resend } from "../config/mailer.js";

const FROM = process.env.SMTP_FROM || '"BBM" <communication@bbmpvtltd.com>';
const BRAND_TEAL = "#047084";
const BRAND_ORANGE = "#d2462b";

const DEFAULT_FOOTER = `You're receiving this because an account was created or updated on BBM
            using this email address. If this wasn't you, you can ignore this email.`;

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function shell(title, bodyHtml, footer = DEFAULT_FOOTER) {
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
            ${footer}
          </p>
        </td>
      </tr>
    </table>
  </div>`;
}

// Resend returns { data, error } rather than throwing on a send failure
// (e.g. unverified domain, invalid recipient). Surface that error the
// same way a thrown SMTP error used to be surfaced, so callers that
// catch on these functions keep working unchanged.
function throwIfResendError({ data, error }) {
  if (error) {
    throw Object.assign(new Error(error.message || "Email send failed"), { cause: error });
  }
  return data;
}

export async function sendWelcomeEmail(toEmail, name) {
  if (!toEmail) return; // email is optional at signup
  const html = shell(
    `Welcome to BBM, ${name || "there"} 👋`,
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
       Your account is ready. You can start sourcing materials right away —
       and open a storefront to sell any time, using the same login.
     </p>
     <a href="https://bbm.business/home" style="display:inline-block;margin-top:6px;background:${BRAND_ORANGE};color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 22px;border-radius:10px;">
       Go to marketplace
     </a>`
  );
  const result = await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: "Welcome to BBM — your account is ready",
    html,
  });
  return throwIfResendError(result);
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
  const result = await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: "Your business details are being verified",
    html,
  });
  return throwIfResendError(result);
}

export async function sendBusinessVerifiedEmail(toEmail, businessName) {
  if (!toEmail) return;
  const html = shell(
    "You're verified to sell on BBM ✅",
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
       <strong>${businessName}</strong> is verified. You can list products
       and open your storefront whenever you're ready.
     </p>
     <a href="https://bbm.business/grow/dashboard" style="display:inline-block;margin-top:6px;background:${BRAND_TEAL};color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 22px;border-radius:10px;">
       Open your shop
     </a>`
  );
  const result = await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: "You're verified to sell on BBM",
    html,
  });
  return throwIfResendError(result);
}

// Team mode: invitation to join a company's team. Called by services/team.service.js (deliverInvite).
export async function sendTeamInviteEmail({ to, companyName, inviterName, link, hours, role = "member" }) {
  if (!to) return;
  const isSales = role === "salesperson";
  const company = esc(companyName || "a company");
  const inviter = esc(inviterName || "A colleague");
  const roleText = isSales ? "a salesperson" : "a team member";
  const about = isSales
    ? `You'll get your own sales workspace for <strong>${company}</strong>, where you see and add only your own customers. Marketplace, orders and chats are not part of this role.`
    : `You'll work inside the company's account with the same access as the company, and the team admin can see the actions team members take.`;

  const html = shell(
    isSales ? `Join ${company} as a salesperson on BBM` : `Join ${company}'s team on BBM`,
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
       ${inviter} invited you to join <strong>${company}</strong> as ${roleText}.
       ${about}
     </p>
     <a href="${esc(link)}" style="display:inline-block;margin-top:6px;background:${BRAND_TEAL};color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 22px;border-radius:10px;">
       ${isSales ? "Join as salesperson" : "Join the team"}
     </a>
     <p style="margin:16px 0 0;font-size:12.5px;line-height:1.6;color:#64748b;">
       This link expires in ${esc(hours)} hours. Sign up with <strong>this email address</strong>; a different one won't work.
     </p>
     <p style="margin:10px 0 0;font-size:12.5px;line-height:1.6;color:#64748b;">
       Used BBM before, or were part of another company's team? That's fine. Use the same email address and you'll be set up under this company.
     </p>
     <p style="margin:10px 0 0;font-size:11.5px;line-height:1.5;color:#94a3b8;word-break:break-all;">${esc(link)}</p>`,
    "You're receiving this because someone invited this email address to join their team on BBM. If you weren't expecting it, you can ignore this email and nothing will change."
  );
  const clean = (v, d) => String(v || d).replace(/[\r\n]+/g, " ");
  const result = await resend.emails.send({
    from: FROM,
    to,
    subject: `${clean(inviterName, "A colleague")} invited you to join ${clean(companyName, "a company")} on BBM${isSales ? " as a salesperson" : ""}`,
    html,
  });
  return throwIfResendError(result);
}

// Used by src/services/otp.service.js's issueOtp() — that caller already
// awaits this and catches on failure, so throwing on a Resend error (via
// throwIfResendError) keeps that error-handling path working unchanged.
export async function sendOtpEmail(email, otp) {
  const result = await resend.emails.send({
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
  return throwIfResendError(result);
}

export async function sendGstinReportUpdateEmail({ to, name, gstin, message }) {
  if (!to) return;
  const html = shell(
    "Update on your GSTIN report",
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
       Hi ${esc(name || "there")}, our team has looked into your report about GSTIN
       <strong>${esc(gstin)}</strong>.
     </p>
     <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#0f172a;white-space:pre-line;">${esc(message)}</p>`,
    "You're receiving this because you reported a GSTIN issue on BBM. If this wasn't you, you can ignore this email."
  );
  const result = await resend.emails.send({ from: FROM, to, subject: "Update on your GSTIN report", html });
  return throwIfResendError(result);
}


const inrMail = (n, max = 2) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: max });
const qtyMail = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 4 });

export async function sendSalesQuotationEmail({
  to, customerName, sellerName, salespersonName, enquiryProduct,
  items, subtotal, gstAmount, total, validUntil, note, replyTo,
}) {
  if (!to) return;
  const rows = (items || []).map((i) => `
    <div style="margin:0 0 12px;padding:12px 14px;border:1px solid #e5eaee;border-radius:12px;">
      <div style="font-size:14px;font-weight:700;color:#0f172a;">${esc(i.productName)}${i.brandName ? ` <span style="font-weight:400;color:#64748b;">· ${esc(i.brandName)}</span>` : ""}</div>
      ${i.description ? `<div style="margin-top:4px;font-size:12.5px;line-height:1.5;color:#64748b;">${esc(i.description)}</div>` : ""}
      <div style="margin-top:8px;font-size:13px;color:#334155;">
        ${esc(qtyMail(i.quantity))} ${esc(i.unit)} × ${esc(inrMail(i.unitPriceIncl, 4))} = <strong>${esc(inrMail(i.totalIncl))}</strong>
        <span style="color:#94a3b8;">(incl. GST)</span>
      </div>
      <a href="${esc(i.url)}" style="display:inline-block;margin-top:8px;font-size:12.5px;font-weight:700;color:${BRAND_TEAL};text-decoration:none;">View product</a>
    </div>`).join("");

  const html = shell(
    `Quotation for ${esc(enquiryProduct)}`,
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
       Hi ${esc(customerName || "there")}, ${esc(sellerName)} has shared a quotation for your enquiry
       (${esc(enquiryProduct)})${salespersonName ? `, prepared by ${esc(salespersonName)}` : ""}.
     </p>
     ${rows}
     <table role="presentation" width="100%" style="margin-top:6px;font-size:13px;color:#334155;">
       <tr><td style="padding:3px 0;">Total before GST</td><td align="right">${esc(inrMail(subtotal))}</td></tr>
       <tr><td style="padding:3px 0;">GST</td><td align="right">${esc(inrMail(gstAmount))}</td></tr>
       <tr><td style="padding:6px 0 0;font-size:15px;font-weight:800;color:#0f172a;">Total (incl. GST)</td>
           <td align="right" style="padding:6px 0 0;font-size:15px;font-weight:800;color:#0f172a;">${esc(inrMail(total))}</td></tr>
     </table>
     <p style="margin:14px 0 0;font-size:12.5px;color:#64748b;">This quotation is valid until <strong>${esc(validUntil)}</strong>.</p>
     ${note ? `<p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#334155;white-space:pre-line;">${esc(note)}</p>` : ""}
     <p style="margin:12px 0 0;font-size:12.5px;color:#64748b;">Reply to this email if you have any questions.</p>`,
    "You're receiving this because a supplier prepared a quotation for your enquiry on BBM. If this wasn't meant for you, you can ignore this email."
  );
  const clean = (v) => String(v || "").replace(/[\r\n]+/g, " ");
  const result = await resend.emails.send({
    from: FROM,
    to,
    ...(replyTo ? { replyTo } : {}),   // older resend SDKs call this field reply_to
    subject: `Quotation for ${clean(enquiryProduct)} from ${clean(sellerName)}`,
    html,
  });
  return throwIfResendError(result);
}

