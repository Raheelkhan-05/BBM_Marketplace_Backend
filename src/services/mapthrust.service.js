// src/services/mapthrust.service.js
//
// Primary SMS provider (DLT route). We generate the OTP ourselves and
// this only delivers it.
//
// Env vars:
//   MAPTHRUST_API_KEY      - the "authorization" value
//   MAPTHRUST_SENDER_ID    - e.g. CHORHA
//   MAPTHRUST_TEMPLATE_ID  - DLT template id
//   MAPTHRUST_ENTITY_ID    - DLT entity id
// Optional:
//   MAPTHRUST_BASE_URL     - defaults to https://sms-api.mapthrust.io/dev/bulkV2
//   SMS_APP_NAME           - text that replaces "your-app-name" in the template

const BASE_URL = process.env.MAPTHRUST_BASE_URL || "https://sms-api.mapthrust.io/dev/bulkV2";
const API_KEY = process.env.MAPTHRUST_API_KEY;
const SENDER_ID = process.env.MAPTHRUST_SENDER_ID;
const TEMPLATE_ID = process.env.MAPTHRUST_TEMPLATE_ID;
const ENTITY_ID = process.env.MAPTHRUST_ENTITY_ID;
const APP_NAME = process.env.SMS_APP_NAME || "your-app-name";
const TIMEOUT_MS = 6000;

// Must match the DLT-registered template text exactly, or the operator rejects it.
const buildMessage = (otp) =>
    `Hello, ${otp} is the OTP for ${APP_NAME} login using your phone number. Do not share it to anyone.`;

export async function sendOtpViaMapthrust(phone, otp) {
    if (!API_KEY || !SENDER_ID || !TEMPLATE_ID || !ENTITY_ID) {
        throw new Error("[mapthrust] env vars not set.");
    }

    const params = new URLSearchParams({
        authorization: API_KEY,
        route: "dlt_manual",
        message: buildMessage(otp),
        sender_id: SENDER_ID,
        entity_id: ENTITY_ID,
        template_id: TEMPLATE_ID,
        numbers: phone, // 10-digit Indian number
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}?${params.toString()}`, { signal: controller.signal });

        let data = null;
        try { data = await res.json(); } catch { /* non-JSON body */ }

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${data ? JSON.stringify(data) : ""}`);
        }
        // Providers of this style usually answer { return: true, ... } on success.
        // If the body says otherwise, treat it as a failure.
        if (data && data.return === false) throw new Error(JSON.stringify(data));
        if (data && typeof data.status === "string" && /fail|error/i.test(data.status)) {
            throw new Error(JSON.stringify(data));
        }
        return true;
    } finally {
        clearTimeout(timer);
    }
}