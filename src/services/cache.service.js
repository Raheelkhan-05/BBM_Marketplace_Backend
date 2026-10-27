// services/cache.service.js
// Small cache layer: Redis when REDIS_URL is set (and `ioredis` is installed), otherwise an in-process LRU-ish Map.
// Safe by design: every Redis error silently falls back to memory, so a Redis outage never breaks a request.
//
// Invalidation uses "version stamps": keys embed a version (getVer) and writers call bumpVer, so a write makes
// every older cached value unreachable instantly, with no key scanning. TTLs only bound memory.
import { createHash } from "node:crypto";

const MAX_MEM = 3000;
const mem = new Map();        // key -> { v, exp }
const memVer = new Map();     // scope -> int
const inflight = new Map();   // key -> Promise (single-flight: concurrent misses share one DB query)

let redisP = null;
function client() {
    if (redisP) return redisP;
    redisP = (async () => {
        if (!process.env.REDIS_URL) return null;
        try {
            const { default: Redis } = await import("ioredis");
            const r = new Redis(process.env.REDIS_URL, {
                maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000,
            });
            r.on("error", (e) => console.error("[cache] redis:", e.message));
            return r;
        } catch (e) {
            console.error("[cache] ioredis unavailable, using memory cache:", e.message);
            return null;
        }
    })();
    return redisP;
}

export const hashKey = (parts) => createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

function memSet(key, v, ttl) {
    mem.delete(key);
    mem.set(key, { v, exp: Date.now() + ttl * 1000 });
    if (mem.size > MAX_MEM) {
        let n = Math.ceil(MAX_MEM * 0.1);
        for (const k of mem.keys()) { mem.delete(k); if (--n <= 0) break; }
    }
}

// Returns undefined on a miss (null is a valid cached value).
export async function cacheGet(key) {
    const r = await client();
    if (r) {
        try {
            const s = await r.get(key);
            if (s !== null) return JSON.parse(s);
        } catch { /* fall through to memory */ }
    }
    const e = mem.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) { mem.delete(key); return undefined; }
    return e.v;
}

export async function cacheSet(key, value, ttlSec = 30) {
    memSet(key, value, Math.min(ttlSec, 60));   // memory copy is kept short; Redis holds the full TTL
    const r = await client();
    if (r) { try { await r.set(key, JSON.stringify(value), "EX", ttlSec); } catch { /* ignore */ } }
}

// cached(key, ttl, fn): hit -> value; miss -> run fn once (shared by concurrent callers), store, return. Errors are never cached.
export async function cached(key, ttlSec, fn) {
    const hit = await cacheGet(key);
    if (hit !== undefined) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        const v = await fn();
        await cacheSet(key, v, ttlSec);
        return v;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

export async function getVer(scope) {
    let rv = "0";
    const r = await client();
    if (r) { try { rv = (await r.get(`v:${scope}`)) || "0"; } catch { /* ignore */ } }
    return `${rv}.${memVer.get(scope) || 0}`;
}

export async function bumpVer(...scopes) {
    const r = await client();
    for (const s of scopes.filter(Boolean)) {
        memVer.set(s, (memVer.get(s) || 0) + 1);
        if (r) { try { await r.multi().incr(`v:${s}`).expire(`v:${s}`, 86400).exec(); } catch { /* ignore */ } }
    }
}