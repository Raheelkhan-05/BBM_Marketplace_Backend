import { supabase } from "../config/supabase.js";

const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // e.g. 1308291795690122
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const TEMPLATE_NAME = process.env.WHATSAPP_OTP_TEMPLATE || "whatsapp_otp_verification";
const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

// India numbers stored as 10 digits in our DB — WhatsApp needs the country code.
function toWhatsappFormat(phone) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return `91${digits}`;
    return digits; // already has country code
}

export async function sendOtp(phone, purpose = "seller_whatsapp") {
    // Rate-limit: block resend within cooldown window
    const { data: recent } = await supabase
        .from("otp_verifications")
        .select("created_at")
        .eq("phone", phone)
        .eq("purpose", purpose)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (recent && Date.now() - new Date(recent.created_at).getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
        throw new Error(`Please wait before requesting another code.`);
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

    const { error: dbError } = await supabase
        .from("otp_verifications")
        .insert({ phone, code, purpose, expires_at: expiresAt });
    if (dbError) throw new Error(dbError.message);

    const res = await fetch(`https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_ID}/messages`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            to: toWhatsappFormat(phone),
            type: "template",
            template: {
                name: TEMPLATE_NAME,
                language: { code: "en" },
                components: [
                    {
                        type: "body",
                        parameters: [
                            { type: "text", text: "User" },
                            { type: "text", text: "Brand Brigade Marketing" },
                            { type: "text", text: "Your WhatsApp verification code for BBM Marketplace is " + code + ". This code is valid for " + OTP_TTL_MINUTES + " minutes. Do not share this code with anyone." },
                        ],
                    },
                ],
            },
        }),
    });

    const data = await res.json();
    if (!res.ok) {
        console.error("[sendOtp] WhatsApp API error", data);
        throw new Error(data?.error?.message || "Couldn't send WhatsApp message.");
    }
    return data;
}

export async function verifyOtpCode(phone, code, purpose = "seller_whatsapp") {
    const { data: row, error } = await supabase
        .from("otp_verifications")
        .select("*")
        .eq("phone", phone)
        .eq("purpose", purpose)
        .is("verified_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error || !row) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) return false;
    if (row.attempts >= MAX_ATTEMPTS) return false;

    if (row.code !== code) {
        await supabase.from("otp_verifications").update({ attempts: row.attempts + 1 }).eq("id", row.id);
        return false;
    }

    await supabase.from("otp_verifications").update({ verified_at: new Date().toISOString() }).eq("id", row.id);
    return true;
}