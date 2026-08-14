import { supabaseAdmin } from "../config/supabase.js";

const SUBSCRIBE_TIMEOUT_MS = 4000;

// One-shot, self-contained broadcast: subscribe, confirm SUBSCRIBED, send,
// then tear down — every call, no cross-call caching. A cached/reused
// channel can go silently stale (process freeze on serverless, idle
// socket drop, etc.) while still reporting "subscribed", which is exactly
// what caused sends to randomly stop landing. Doing it fresh each time
// trades a little latency for actually being reliable.
async function sendOnce(topic, event, payload) {
    const channel = supabaseAdmin.channel(topic, { config: { broadcast: { self: false, ack: true } } });

    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`subscribe timeout on "${topic}"`)), SUBSCRIBE_TIMEOUT_MS);
            channel.subscribe((status, err) => {
                if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(); }
                else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                    clearTimeout(timer);
                    reject(err || new Error(`subscribe failed on "${topic}": ${status}`));
                }
            });
        });

        const res = await channel.send({ type: "broadcast", event, payload });
        if (res !== "ok") throw new Error(`send() returned "${res}"`);
        return true;
    } finally {
        await supabaseAdmin.removeChannel(channel);
    }
}

export async function broadcast(topic, event, payload = {}) {
    try {
        await sendOnce(topic, event, payload);
    } catch (err) {
        console.error(`[realtime] broadcast "${event}" on "${topic}" failed, retrying once:`, err?.message || err);
        try {
            await sendOnce(topic, event, payload);
        } catch (err2) {
            console.error(`[realtime] broadcast "${event}" on "${topic}" failed on retry, giving up:`, err2?.message || err2);
        }
    }
}