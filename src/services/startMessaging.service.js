// src/services/startMessaging.service.js
//
// Secondary SMS provider. We generate the OTP ourselves.
//
// Env vars:
//   STARTMESSAGING_API_KEY
//   STARTMESSAGING_TEMPLATE_ID  - e.g. 6990f1b1-6a28-4cb4-a8ed-35a450a6b59d
//                                 (uses {{appName}}, {{otp}}, {{expiry}})
// Optional:
//   STARTMESSAGING_BASE_URL     - defaults to https://api.startmessaging.com
//   SMS_APP_NAME

const BASE_URL = process.env.STARTMESSAGING_BASE_URL || "https://api.startmessaging.com";
const API_KEY = process.env.STARTMESSAGING_API_KEY;
const TEMPLATE_ID = process.env.STARTMESSAGING_TEMPLATE_ID;
const APP_NAME = process.env.SMS_APP_NAME || "your-app-name";
const TIMEOUT_MS = 6000;

export async function sendOtpViaStartMessaging(phone, otp, expiryMinutes = 5) {
    if (!API_KEY || !TEMPLATE_ID) {
        throw new Error("[startmessaging] env vars not set.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}/otp/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
            body: JSON.stringify({
                phoneNumber: `+91${phone}`, // E.164
                templateId: TEMPLATE_ID,
                variables: { otp, appName: APP_NAME, expiry: String(expiryMinutes) },
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            let body = "";
            try { body = await res.text(); } catch { /* ignore */ }
            throw new Error(`HTTP ${res.status} ${body}`);
        }
        return true;
    } finally {
        clearTimeout(timer);
    }
}