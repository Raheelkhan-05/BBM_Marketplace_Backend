// src/services/salesChatReminder.service.js
// WhatsApp nudges for enquiry chats. Runs every 30 seconds and claims the people who are due in ONE atomic SQL call
// per kind (FOR UPDATE SKIP LOCKED), so it is safe on several server instances and never double-sends.
//
// TWO NUDGES, per person per enquiry, per UNREAD STREAK (a streak ends when the person opens the chat):
//   1. "new"      about 1 minute after someone posts, if the person still hasn't read it. Several quick messages become
//                 ONE WhatsApp. A message that TAGS the person pings again even inside the same streak.
//                 (claim_sales_chat_new_nudges)
//   2. "reminder" when the streak is still unread 1 hour after the message. One WhatsApp with the grouped count of ALL
//                 unread messages. (claim_sales_chat_reminders)
//
// RELIABILITY
//   - Every send result is checked. SENT / FAILED / SKIPPED is logged with the enquiry and user ids.
//   - A claim is stamped in SQL BEFORE sending. If the send fails (the WhatsApp service has already retried), the claim
//     is released so the next run tries again, up to MAX_RELEASES times; then it gives up and logs it.
//   - Chat nudges are sent one at a time through the shared WhatsApp queue, so they never starve order notifications.
//
// ENV (all optional)
//   SALES_CHAT_NEW_NUDGE          "on" to enable the debounced "new message" nudge (default OFF, see note below)
//   SALES_CHAT_NEW_DELAY_SEC      60    unread this long before the "new message" nudge
//   SALES_CHAT_NEW_WINDOW_MIN     15    a message older than this is never announced as "new"
//   SALES_CHAT_REMIND_AFTER_MIN   60    unread this long before the reminder
//   SALES_CHAT_REMIND_MAX_AGE_HOURS 24  messages older than this are never reminded
//   SALES_CHAT_NUDGE_EVERY_SEC    30    how often the scheduler runs
//
// NOTE: leave SALES_CHAT_NEW_NUDGE off until the immediate "new message" WhatsApp inside afterMessage()
// (services/salesChat.service.js) is removed, otherwise people would get the "new" message twice.
import { supabaseAdmin as db } from "../config/supabase.js";
import { namesOf, firstName, reminderLink } from "./salesChat.service.js";
import { sendSalesChatWhatsApp } from "./whatsapp.service.js";

const NEW_ENABLED = String(process.env.SALES_CHAT_NEW_NUDGE || "").toLowerCase() === "on";
const NEW_DELAY_SEC = Number(process.env.SALES_CHAT_NEW_DELAY_SEC) || 60;
const NEW_WINDOW_MIN = Number(process.env.SALES_CHAT_NEW_WINDOW_MIN) || 15;
const REMIND_AFTER_MIN = Number(process.env.SALES_CHAT_REMIND_AFTER_MIN) || 60;
const REMIND_MAX_AGE_HOURS = Number(process.env.SALES_CHAT_REMIND_MAX_AGE_HOURS) || 24;
const EVERY_MS = (Number(process.env.SALES_CHAT_NUDGE_EVERY_SEC) || 30) * 1000;

const BATCH = 50;
const MAX_RELEASES = 3;

// kind -> how to claim, and which participant column the claim stamped (cleared again when a send fails)
const KINDS = {
    new: {
        rpc: "claim_sales_chat_new_nudges",
        column: "last_new_notified_at",
        args: () => ({ p_limit: BATCH, p_delay: `${NEW_DELAY_SEC} seconds`, p_window: `${NEW_WINDOW_MIN} minutes` }),
    },
    reminder: {
        rpc: "claim_sales_chat_reminders",
        column: "last_nudged_at",
        args: () => ({ p_limit: BATCH, p_after: `${REMIND_AFTER_MIN} minutes`, p_max_age: `${REMIND_MAX_AGE_HOURS} hours` }),
    },
};

let timer = null;
let running = false;
const releases = new Map();   // "kind:enquiry:user" -> how many times the claim was released after a failed send

// Un-claims a failed nudge so the next run retries it (a few times only).
async function release(kind, row, tag) {
    const key = `${kind}:${row.n_enquiry_id}:${row.n_user_id}`;
    const n = (releases.get(key) || 0) + 1;
    if (n >= MAX_RELEASES) {
        releases.delete(key);
        console.error(`[sales chat] GAVE UP ${tag} after ${MAX_RELEASES} failed rounds`);
        return;
    }
    releases.set(key, n);
    if (releases.size > 2000) releases.clear();   // never grow without bound

    const { error } = await db.from("sales_thread_participants")
        .update({ [KINDS[kind].column]: null })
        .eq("enquiry_id", row.n_enquiry_id).eq("user_id", row.n_user_id);
    if (error) console.error(`[sales chat] release failed ${tag}:`, error.message);
}

async function claimAndDeliver(kind) {
    const cfg = KINDS[kind];
    const { data, error } = await db.rpc(cfg.rpc, cfg.args());
    if (error) { console.error(`[sales chat] ${kind} claim failed:`, error.message); return; }
    if (!data?.length) return;

    const people = await namesOf([...data.map((r) => r.n_user_id), ...data.map((r) => r.n_last_author_id)]);
    let sent = 0, failed = 0, skipped = 0;

    for (const r of data) {
        const tag = `kind=${kind} enquiry=${r.n_enquiry_id} user=${r.n_user_id} unread=${r.n_unread}`;
        try {
            const me = people.get(String(r.n_user_id));
            if (!me?.phone) {
                skipped++;
                console.warn(`[sales chat] SKIPPED ${tag}: no mobile number on file`);
                continue;
            }

            const result = await sendSalesChatWhatsApp({
                to: me.phone, name: firstName(me.name), kind,
                customer: r.n_customer || "a customer", product: r.n_product || "",
                from: people.get(String(r.n_last_author_id))?.name || "", preview: r.n_last_body || "",
                unread: r.n_unread || 1, mentioned: (r.n_mentions || 0) > 0,
                link: reminderLink({ id: r.n_enquiry_id, created_by_actor_id: r.n_is_creator ? r.n_user_id : null }, r.n_user_id),
            });

            if (result?.success) {
                sent++;
                releases.delete(`${kind}:${r.n_enquiry_id}:${r.n_user_id}`);
            } else if (result?.skipped) {
                // invalid number or gateway not configured: retrying would not help
                skipped++;
                console.warn(`[sales chat] SKIPPED ${tag}: ${result.error || "not sendable"}`);
            } else {
                failed++;
                console.error(`[sales chat] FAILED ${tag}: ${result?.error || "unknown error"}`);
                await release(kind, r, tag);
            }
        } catch (e) {
            failed++;
            console.error(`[sales chat] FAILED ${tag}:`, e?.message || e);
            await release(kind, r, tag);
        }
    }

    const line = `[sales chat] ${kind} run: ${sent} sent, ${failed} failed, ${skipped} skipped (of ${data.length})`;
    if (failed) console.error(line); else console.log(line);
}

export async function runSalesChatReminders() {
    if (running) return;
    running = true;
    try {
        if (NEW_ENABLED) await claimAndDeliver("new");
        await claimAndDeliver("reminder");
    } catch (e) {
        console.error("[sales chat] run failed:", e?.message || e);
    } finally {
        running = false;
    }
}

export function startSalesChatReminderScheduler() {
    if (timer) return;
    console.log(
        `[sales chat] scheduler started: new-message nudge ${NEW_ENABLED ? `ON (after ${NEW_DELAY_SEC}s)` : "OFF"}, ` +
        `unread reminder after ${REMIND_AFTER_MIN} min, every ${EVERY_MS / 1000}s`
    );
    timer = setInterval(runSalesChatReminders, EVERY_MS);
    timer.unref?.();
    setTimeout(runSalesChatReminders, 20_000);   // catch up after a deploy / restart
}