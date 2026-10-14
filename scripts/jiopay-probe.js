// scripts/jiopay-probe.js
//
// Finds out WHY calls to JioPay are being refused. Sends a harmless empty request to initiateSale
// twice (with and without the relay key) and explains the result. No transaction is created.
//
// Run from the backend folder (Node 20.6+):
//   node --env-file=.env scripts/jiopay-probe.js
// Production on Render: run the same command in the Render shell (env vars are already set there).
import { jiopayConfig as cfg } from "../src/config/jiopay.js";

const url = `${cfg.baseUrl}/pg/api/v2/initiateSale`;
const snippet = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 200) || "(empty)";

async function call(label, extraHeaders) {
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", ...extraHeaders },
            body: "{}",
            signal: AbortSignal.timeout(15000),
        });
        const text = await res.text();
        let isJson = false;
        try { JSON.parse(text); isJson = true; } catch { /* not JSON */ }
        return { label, status: res.status, server: res.headers.get("server") || "-", isJson, body: snippet(text) };
    } catch (e) {
        return { label, error: `${e?.name}: ${e?.message}` };
    }
}

const show = (r) => console.log(
    r.error
        ? `- ${r.label}: NETWORK ERROR ${r.error}`
        : `- ${r.label}: HTTP ${r.status} | json=${r.isJson} | server=${r.server} | body=${r.body}`
);

console.log(`Environment : ${cfg.isProd ? "PRODUCTION" : "UAT"}`);
console.log(`URL         : ${url}`);
console.log(`Relay key   : ${cfg.relayKey ? "set" : "NOT set (direct mode)"}\n`);

const withKey = await call("with relay key   ", cfg.relayKey ? { "x-relay-key": cfg.relayKey } : {});
const withoutKey = await call("without relay key", {});
show(withKey);
show(withoutKey);
console.log("");

if (withKey.error) {
    console.log("RESULT: could not reach the host at all. Check that the relay is running, DNS for the relay name, and the firewall.");
} else if (withKey.isJson) {
    console.log("RESULT: OK. The request reached JioPay and JioPay answered (an 'Amount is missing' style error is expected for an empty body).");
    if (cfg.relayKey && withoutKey.isJson) console.log("NOTE: the relay also answered WITHOUT the key, so it is not enforcing the key.");
} else if (withKey.status === 403 || withKey.status === 401) {
    console.log("RESULT: blocked even with the key. Read the body above:");
    console.log("  * short plain text like 'Forbidden' from server=Caddy  -> the relay's own key check failed.");
    console.log("    The key in the relay's Caddyfile differs from JIOPAY_RELAY_KEY (trailing space/quotes?), the relay env var is empty for Caddy, or Caddy was not reloaded.");
    console.log("  * an HTML page from JioPay / a CDN                      -> the relay's public IP is not whitelisted at JioPay for this environment (production needs its own approval).");
} else if (withKey.status === 404) {
    console.log("RESULT: path not found. Production has NO /tsp prefix; the relay must forward /pg/... unchanged to https://jiopay.co.in.");
} else {
    console.log(`RESULT: unexpected non-JSON answer (HTTP ${withKey.status}). See the body above.`);
}
process.exit(0);