// src/services/salesChatReminder.service.js
// The 1-hour unread check for enquiry chats. Runs every minute, claims due people in ONE atomic SQL call
// (claim_sales_chat_nudges, FOR UPDATE SKIP LOCKED), so it is safe on several server instances and never double-sends.
//
// Rules (all enforced in SQL):
//  - a message from someone else has been unread for 1 hour (SALES_CHAT_REMIND_AFTER_MIN)
//  - it is newer than that person's previous reminder (a message is never reminded twice)
//  - at most one reminder per person per thread per 3 hours (SALES_CHAT_REMIND_COOLDOWN_MIN),
//    except a message that TAGGED them, which is reminded as soon as it is 1 hour old
//  - several unread messages collapse into one WhatsApp
import { supabaseAdmin as db } from "../config/supabase.js";
import { namesOf, firstName, reminderLink } from "./salesChat.service.js";
import { sendSalesChatWhatsApp } from "./whatsapp.service.js";

const AFTER_MIN = Number(process.env.SALES_CHAT_REMIND_AFTER_MIN) || 60;
const COOLDOWN_MIN = Number(process.env.SALES_CHAT_REMIND_COOLDOWN_MIN) || 180;
const EVERY_MS = 60_000;

let timer = null;
let running = false;

export async function runSalesChatReminders() {
    if (running) return;
    running = true;
    try {
        const { data, error } = await db.rpc("claim_sales_chat_nudges", {
            p_limit: 50, p_after: `${AFTER_MIN} minutes`, p_cooldown: `${COOLDOWN_MIN} minutes`,
        });
        if (error) { console.error("[sales chat reminder] claim failed:", error.message); return; }
        if (!data?.length) return;

        const people = await namesOf(data.map((r) => r.n_user_id));
        for (const r of data) {
            try {
                const me = people.get(String(r.n_user_id));
                if (!me?.phone) continue;
                await sendSalesChatWhatsApp({
                    to: me.phone, name: firstName(me.name), kind: "reminder",
                    customer: r.n_customer || "a customer", product: r.n_product || "",
                    from: r.n_last_author || "", preview: r.n_last_body || "",
                    unread: r.n_unread || 1, mentioned: (r.n_mentions || 0) > 0,
                    link: reminderLink({ id: r.n_enquiry_id, created_by_actor_id: r.n_is_creator ? r.n_user_id : null }, r.n_user_id),
                });
            } catch (e) { console.error("[sales chat reminder] send failed:", e?.message || e); }
        }
    } catch (e) {
        console.error("[sales chat reminder] run failed:", e?.message || e);
    } finally {
        running = false;
    }
}

export function startSalesChatReminderScheduler() {
    if (timer) return;
    timer = setInterval(runSalesChatReminders, EVERY_MS);
    timer.unref?.();
    setTimeout(runSalesChatReminders, 20_000);   // catch up after a deploy / restart
}