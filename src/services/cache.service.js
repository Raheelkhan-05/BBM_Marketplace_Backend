// services/cache.service.js
// Small cache layer: Redis when REDIS_URL is set (and `ioredis` is installed), otherwise an in-process LRU-ish Map.
// Safe by design: every Redis error silently falls back to memory, so a Redis outage never breaks a request.
//
// Invalidation uses "version stamps": keys embed a version (getVer) and writers call bumpVer, so a write makes
// every older cached value unreachable instantly, with no key scanning. TTLs only bound memory.
//
// Everything that existed before keeps working exactly as it did. Additions are marked "ADDED":
//   - memory byte budget (big values such as a seller's whole listing list can't exhaust RAM)
//   - cacheSet / cached accept { memory: false } to keep a big value in Redis only
//   - sellerListScope + bumpOnWrite (router middleware that retires a seller's cached list after any write)
import { createHash } from "node:crypto";

const MAX_MEM = 3000;
const MAX_MEM_BYTES = 64 * 1024 * 1024;   // ADDED: cap on string values held in memory
let memBytes = 0;                          // ADDED
const mem = new Map();        // key -> { v, exp, size }
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

// ADDED: drops one entry and keeps the byte count right
function memDrop(key) {
    const e = mem.get(key);
    if (!e) return;
    memBytes -= e.size || 0;
    mem.delete(key);
}

function memSet(key, v, ttl) {
    memDrop(key);
    const size = typeof v === "string" ? v.length * 2 : 0;   // ADDED: only strings are measured
    mem.set(key, { v, exp: Date.now() + ttl * 1000, size });
    memBytes += size;
    if (mem.size > MAX_MEM) {
        let n = Math.ceil(MAX_MEM * 0.1);
        for (const k of mem.keys()) { memDrop(k); if (--n <= 0) break; }
    }
    while (memBytes > MAX_MEM_BYTES && mem.size > 1) memDrop(mem.keys().next().value);   // ADDED
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
    if (e.exp < Date.now()) { memDrop(key); return undefined; }
    return e.v;
}

// ADDED: opts.memory === false keeps a big value in Redis only (memory is still used when Redis is unavailable).
export async function cacheSet(key, value, ttlSec = 30, { memory = true } = {}) {
    if (memory) memSet(key, value, Math.min(ttlSec, 60));   // memory copy is kept short; Redis holds the full TTL
    const r = await client();
    let stored = false;
    if (r) { try { await r.set(key, JSON.stringify(value), "EX", ttlSec); stored = true; } catch { /* ignore */ } }
    if (!memory && !stored) memSet(key, value, Math.min(ttlSec, 60));
}

// cached(key, ttl, fn): hit -> value; miss -> run fn once (shared by concurrent callers), store, return. Errors are never cached.
export async function cached(key, ttlSec, fn, opts) {
    const hit = await cacheGet(key);
    if (hit !== undefined) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        const v = await fn();
        await cacheSet(key, v, ttlSec, opts);
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

/* ---------------- ADDED: seller listing list ---------------- */

// The version scope of one seller's cached "My products" list.
export const sellerListScope = (sellerId) => `sellerlist:${sellerId}`;

// Router middleware: after any successful write (POST / PATCH / PUT / DELETE) the scope is bumped,
// so the next read rebuilds from the database. Usage (first line after `const router = Router()`):
//   router.use(bumpOnWrite((req) => req.sellerId && sellerListScope(req.sellerId)));
export function bumpOnWrite(scopeOf) {
    return (req, res, next) => {
        if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
        res.on("finish", () => {
            if (res.statusCode >= 400) return;
            const scope = scopeOf(req);
            if (scope) void bumpVer(scope);
        });
        next();
    };
}