// src/services/team.service.js
// Team context, invites, delivery and the activity log.
import crypto from "node:crypto";
import { supabaseAdmin } from "../config/supabase.js";
import { sendOrderUpdateWhatsApp } from "./whatsapp.service.js";
import { notifyUser, emitToUser } from "./realtimeBroadcast.js";
import * as mail from "./mail.service.js";

export const TEAM_MAX_MEMBERS = 25;
export const INVITE_TTL_HOURS = Number(process.env.TEAM_INVITE_TTL_HOURS) || 48;

const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------ contacts ------------------------------ */
export function normalizeContact(raw) {
    const v = String(raw ?? "").trim();
    if (!v) return null;
    if (/[a-zA-Z@]/.test(v)) {
        const email = v.toLowerCase();
        return EMAIL_RE.test(email) ? { channel: "email", value: email } : null;
    }
    let d = v.replace(/\D/g, "");
    if (d.length > 10 && d.startsWith("91")) d = d.slice(2, 12);
    return PHONE_RE.test(d) ? { channel: "phone", value: d } : null;
}

export function maskContact(channel, value) {
    if (channel === "email") return String(value).replace(/^(.{2}).*(@.*)$/, "$1•••$2");
    const d = String(value).replace(/\D/g, "").slice(-10);
    return `+91 ${d.replace(/^(\d{2})\d{6}/, "$1XXXXXX")}`;
}

/* ------------------------------ team context ------------------------------ */
// Short TTL cache: every authenticated request resolves "who is the company?".
// 15s keeps removal near-instant on a single instance. With several instances,
// replace this with Redis (or lower the TTL) so removals propagate immediately.
const CACHE_TTL_MS = 15_000;
const ctxCache = new Map();

export function invalidateTeamContext(...ids) {
    ids.flat().filter(Boolean).forEach((id) => ctxCache.delete(id));
}

export async function getTeamContext(userId) {
    const hit = ctxCache.get(userId);
    if (hit && hit.exp > Date.now()) return hit.ctx;

    const { data, error } = await supabaseAdmin
        .from("team_members")
        .select("team_id, role, teams!inner ( owner_id )")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) throw error;

    const ctx = data
        ? {
            actorId: userId, companyId: data.teams.owner_id, teamId: data.team_id,
            role: data.role, isMember: data.teams.owner_id !== userId, isAdmin: data.role === "admin",
        }
        : { actorId: userId, companyId: userId, teamId: null, role: "admin", isMember: false, isAdmin: true };

    if (ctxCache.size > 5000) ctxCache.clear();
    ctxCache.set(userId, { ctx, exp: Date.now() + CACHE_TTL_MS });
    return ctx;
}

// Maps any user id -> the COMPANY id they belong to (themselves if solo/owner).
export async function resolveCompanyIds(ids) {
    const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
    const map = new Map(uniq.map((id) => [id, id]));
    if (!uniq.length) return map;
    const { data, error } = await supabaseAdmin
        .from("team_members").select("user_id, teams!inner ( owner_id )").in("user_id", uniq);
    if (error) throw error;
    (data || []).forEach((r) => map.set(String(r.user_id), String(r.teams.owner_id)));
    return map;
}

export async function resolveCompanyId(id) {
    if (!id) return id;
    return (await resolveCompanyIds([id])).get(String(id)) ?? id;
}

// Creates the team lazily the first time the admin invites someone.
export async function ensureTeam(ownerId) {
    const ctx = await getTeamContext(ownerId);
    if (ctx.teamId) return ctx.teamId;

    const { data: existing } = await supabaseAdmin.from("teams").select("id").eq("owner_id", ownerId).maybeSingle();
    let teamId = existing?.id;

    if (!teamId) {
        const { data: seller } = await supabaseAdmin
            .from("seller_profiles").select("status").eq("user_id", ownerId).maybeSingle();
        const { data: created, error } = await supabaseAdmin
            .from("teams")
            // A company that is already a seller must not trigger a "now a seller" announcement later.
            .insert({ owner_id: ownerId, seller_announced_at: seller?.status === "approved" ? new Date().toISOString() : null })
            .select("id").single();
        if (error) {
            if (error.code !== "23505") throw error;
            const { data: again } = await supabaseAdmin.from("teams").select("id").eq("owner_id", ownerId).single();
            teamId = again.id;
        } else teamId = created.id;
    }

    const { error: memErr } = await supabaseAdmin
        .from("team_members")
        .upsert({ team_id: teamId, user_id: ownerId, role: "admin" }, { onConflict: "user_id", ignoreDuplicates: true });
    if (memErr) throw memErr;

    invalidateTeamContext(ownerId);
    return teamId;
}

export async function isCompanyOnboarded(ownerId) {
    const [{ data: p }, { data: b }] = await Promise.all([
        supabaseAdmin.from("profiles").select("onboarding_step").eq("id", ownerId).maybeSingle(),
        supabaseAdmin.from("business_profiles").select("id").eq("user_id", ownerId).maybeSingle(),
    ]);
    return p?.onboarding_step === "done" && !!b;
}

export async function companyNameOf(ownerId) {
    const [{ data: b }, { data: s }] = await Promise.all([
        supabaseAdmin.from("business_profiles").select("display_name, trade_name, legal_name").eq("user_id", ownerId).maybeSingle(),
        supabaseAdmin.from("seller_profiles").select("display_name").eq("user_id", ownerId).maybeSingle(),
    ]);
    return b?.display_name?.trim() || s?.display_name?.trim() || b?.trade_name?.trim() || b?.legal_name?.trim() || "a company";
}

// Why a contact can't be invited / used to join. null = fine.
export async function contactConflict({ channel, value }, teamId) {
    const col = channel === "phone" ? "phone" : "email";
    const { data: rows, error } = await supabaseAdmin
        .from("profiles").select("id, onboarding_step")
        .eq(col, value).eq(`${col}_verified`, true).eq("role", "user").is("deleted_at", null).limit(1);
    if (error) throw error;
    const prof = rows?.[0];
    if (!prof) return null;

    const [{ data: m }, { data: b }, { data: s }] = await Promise.all([
        supabaseAdmin.from("team_members").select("team_id").eq("user_id", prof.id).maybeSingle(),
        supabaseAdmin.from("business_profiles").select("id").eq("user_id", prof.id).maybeSingle(),
        supabaseAdmin.from("seller_profiles").select("id").eq("user_id", prof.id).maybeSingle(),
    ]);
    if (m) return m.team_id === teamId ? "ALREADY_MEMBER" : "OTHER_COMPANY";
    if (prof.onboarding_step === "done" || b || s) return "OTHER_COMPANY";
    return null; // an unfinished sign-up can be reused
}

/* ------------------------------ invites ------------------------------ */
export const newInviteToken = () => crypto.randomBytes(32).toString("hex");
export const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
export const inviteExpiry = () => new Date(Date.now() + INVITE_TTL_HOURS * 3600_000).toISOString();
export const inviteLink = (token) =>
    `${String(process.env.FRONTEND_URL || "").replace(/\/$/, "")}/join-team?token=${token}`;

// Returns true only if the message was actually handed to a provider.
export async function deliverInvite({ channel, value, link, companyName, inviterName }) {
    try {
        if (channel === "phone") {
            await sendOrderUpdateWhatsApp({
                to: value, name: "there",
                headline: `${inviterName || "Your colleague"} invited you to join ${companyName}'s team on BBM.`,
                detail: `Open this link to join (valid for ${INVITE_TTL_HOURS} hours): ${link}`,
                footer: "Sign up with this same mobile number. If you weren't expecting this, ignore this message.",
            });
            return true;
        }
        if (typeof mail.sendTeamInviteEmail === "function") {
            await mail.sendTeamInviteEmail({ to: value, companyName, inviterName, link, hours: INVITE_TTL_HOURS });
            return true;
        }
        console.warn("[team] mail.service has no sendTeamInviteEmail — invite not emailed");
        return false;
    } catch (e) {
        console.error("[team] invite delivery failed:", e?.message || e);
        return false;
    }
}

// Tells the team's MEMBERS (once) that the company is now a seller.
// It is posted to the company's notification list; the client shows this type to members only,
// so the admin never sees an extra message.
export async function announceSellerLive(ctx) {
    if (!ctx?.teamId) return;
    const { data: claimed } = await supabaseAdmin
        .from("teams").update({ seller_announced_at: new Date().toISOString() })
        .eq("id", ctx.teamId).is("seller_announced_at", null).select("id").maybeSingle();
    if (!claimed) return;

    const [{ count }, name] = await Promise.all([
        supabaseAdmin.from("team_members").select("id", { count: "exact", head: true }).eq("team_id", ctx.teamId).eq("role", "member"),
        companyNameOf(ctx.companyId),
    ]);
    if (count > 0) {
        await notifyUser(ctx.companyId, {
            type: "team_seller_enabled",
            title: "Your team can now sell",
            body: `${name} is now set up as a seller. Everyone on the team can list products, answer enquiries and manage orders.`,
            link: "/grow",
        }).catch(() => { });
    }
    await logActivity({
        teamId: ctx.teamId, actorId: ctx.actorId, actorRole: ctx.role, category: "team",
        action: "team.seller_enabled", label: "Set up the company as a seller for the whole team",
    });
}

/* ------------------------------ activity log ------------------------------ */
const nameCache = new Map();
async function nameOf(userId) {
    if (!userId) return null;
    const hit = nameCache.get(userId);
    if (hit && hit.exp > Date.now()) return hit.name;
    const { data } = await supabaseAdmin.from("profiles").select("name, email, phone").eq("id", userId).maybeSingle();
    const name = data?.name?.trim() || data?.email || data?.phone || null;
    if (nameCache.size > 2000) nameCache.clear();
    nameCache.set(userId, { name, exp: Date.now() + 60_000 });
    return name;
}

// At most one ping per team per 800 ms, however many actions happen. A burst of 500 writes = 1 ping.
const ownerCache = new Map();
const pingTimers = new Map();

async function ownerOfTeam(teamId) {
    const hit = ownerCache.get(teamId);
    if (hit) return hit;
    const { data } = await supabaseAdmin.from("teams").select("owner_id").eq("id", teamId).maybeSingle();
    if (data?.owner_id) {
        if (ownerCache.size > 5000) ownerCache.clear();
        ownerCache.set(teamId, data.owner_id);
    }
    return data?.owner_id || null;
}

function scheduleActivityPing(teamId) {
    if (pingTimers.has(teamId)) return;
    pingTimers.set(teamId, setTimeout(async () => {
        pingTimers.delete(teamId);
        try {
            const owner = await ownerOfTeam(teamId);
            if (owner) emitToUser(owner, "team:activity", { teamId }); // no content on purpose
        } catch (e) { console.error("[team-activity] ping failed:", e?.message || e); }
    }, 800));
}

export async function logActivity({
    teamId, actorId, actorRole = null, category = "general", action, label,
    entityType = null, entityId = null, meta = {}, ip = null, collapseMs = 0,
}) {
    if (!teamId) return;
    try {
        const actorName = await nameOf(actorId);
        const eid = entityId ? String(entityId) : null;

        // Same person, same thing, within the window: update the latest row instead of adding another.
        if (collapseMs > 0 && eid) {
            const since = new Date(Date.now() - collapseMs).toISOString();
            const { data: last } = await supabaseAdmin.from("team_activity").select("id, meta")
                .eq("team_id", teamId).eq("actor_id", actorId).eq("action", action).eq("entity_id", eid)
                .gte("created_at", since).order("created_at", { ascending: false }).limit(1).maybeSingle();
            if (last) {
                const count = (Number(last.meta?.count) || 1) + 1;
                const { error } = await supabaseAdmin.from("team_activity")
                    .update({ label, meta: { ...meta, count }, created_at: new Date().toISOString() }).eq("id", last.id);
                if (error) console.error("[team-activity] merge failed:", error.message);
                else scheduleActivityPing(teamId);
                return;
            }
        }

        const { error } = await supabaseAdmin.from("team_activity").insert({
            team_id: teamId, actor_id: actorId, actor_name: actorName, actor_role: actorRole,
            category, action, label, entity_type: entityType, entity_id: eid, meta, ip,
        });
        if (error) console.error("[team-activity] insert failed:", error.message);
        else scheduleActivityPing(teamId);
    } catch (e) {
        console.error("[team-activity] failed:", e?.message || e);
    }
}

// [regex on "METHOD /full/route/pattern", category, label]
const RULES = [
    [/^POST \/api\/orders$/, "orders", "Placed an order"],
    [/^POST \/api\/orders\/:id\/cancel$/, "orders", "Cancelled an order"],
    [/^POST \/api\/orders\/:id\/dispute$/, "orders", "Raised a dispute on an order"],
    [/^POST \/api\/seller\/orders\/:id\/dispute\/respond$/, "orders", "Responded to a dispute"],
    [/^(POST|PATCH|PUT) \/api\/seller\/orders\/:id\//, "orders", "Updated a sales order"],
    [/^POST \/api\/seller\/onboarding\/submit$/, "shop", "Submitted seller onboarding"],
    [/^POST \/api\/seller\/onboarding\/save$/, "shop", "Saved seller onboarding details"],
    [/^POST \/api\/seller\/bank-details$/, "shop", "Updated bank details"],
    [/^PATCH \/api\/seller\/profile$/, "shop", "Updated shop details"],
    [/^PATCH \/api\/seller\/theme$/, "shop", "Changed the shop theme"],
    [/^POST \/api\/seller\/catalog\/(submissions|listings)/, "catalog", "Listed a product"],
    [/^(PATCH|PUT) \/api\/seller\/catalog/, "catalog", "Edited a listing"],
    [/^DELETE \/api\/seller\/catalog/, "catalog", "Removed a listing"],
    [/^(POST|PUT|PATCH) \/api\/seller\/custom-pricing/, "pricing", "Set custom buyer prices"],
    [/^DELETE \/api\/seller\/custom-pricing/, "pricing", "Removed a custom buyer price"],
    [/credit.*grant/i, "credit", "Gave credit to a buyer"],
    [/credit.*decid/i, "credit", "Decided a credit request"],
    [/credit.*toggle/i, "credit", "Turned credit on or off for a buyer"],
    [/credit.*limit.*(decline)/i, "credit", "Declined a credit limit increase"],
    [/credit.*(increase)/i, "credit", "Requested a higher credit limit"],
    [/credit.*limit/i, "credit", "Changed a credit limit"],
    [/credit.*request/i, "credit", "Requested credit from a seller"],
    [/^POST .*\/chat.*\/messages$/i, "chat", "Sent a chat message"],
];

const SKIP = /\/(read|delivered|typing|upload|seen)$|^\/api\/(auth|team)(\/|$)|^\/api\/chat\/conversations\/direct$/;

export function describeRequest(req) {
    const rp = req.route?.path;
    const pattern = `${req.baseUrl || ""}${!rp || rp === "/" ? "" : rp}`;
    if (SKIP.test(pattern)) return null;
    const key = `${req.method} ${pattern}`;
    const hit = RULES.find(([re]) => re.test(key));
    const p = req.params || {};
    return {
        category: hit ? hit[1] : "general",
        label: hit ? hit[2] : `${req.method} ${pattern}`,
        action: key,
        entityType: hit ? hit[1] : null,
        entityId: p.id || p.submissionId || p.buyerId || p.conversationId || null,
        meta: { path: String(req.originalUrl || "").split("?")[0], status: req.res?.statusCode },
    };
}

/* ------------------------------ chat enrichment ------------------------------ */
const CHAT_MERGE_MS = 10 * 60_000;
const convCache = new Map();

async function partyName(userId) {
    const company = await companyNameOf(userId);
    return company !== "a company" ? company : await nameOf(userId);
}

async function isApprovedSeller(userId) {
    const { data } = await supabaseAdmin.from("seller_profiles").select("status").eq("user_id", userId).maybeSingle();
    return data?.status === "approved";
}

// Who the company was talking to (or the group's title), and which app side the chat belongs to.
async function conversationInfo(conversationId, companyId) {
    const key = `${conversationId}:${companyId}`;
    const hit = convCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    try {
        const [{ data: conv, error }, { data: parts }] = await Promise.all([
            supabaseAdmin.from("chat_conversations").select("id, is_group, title").eq("id", conversationId).maybeSingle(),
            supabaseAdmin.from("chat_participants").select("user_id").eq("conversation_id", conversationId),
        ]);
        if (error || !conv) { console.warn("[team-activity] conversation not found:", conversationId, error?.message || ""); return null; }

        const ids = (parts || []).map((p) => p.user_id);
        if (!ids.includes(companyId)) { console.warn("[team-activity] company is not a participant of", conversationId); return null; }
        const others = ids.filter((id) => id !== companyId);

        const otherName = conv.is_group
            ? (conv.title?.trim() || "a group chat")
            : (others[0] ? await partyName(others[0]) : null);

        // The same chat can be opened from both apps. A company that sells to someone who doesn't sell
        // is on the Sell side (/grow); everything else opens on the Buy side (/save).
        const [me, them] = await Promise.all([
            isApprovedSeller(companyId),
            !conv.is_group && others[0] ? isApprovedSeller(others[0]) : false,
        ]);
        const v = { asSeller: me && !them, otherName };

        if (convCache.size > 2000) convCache.clear();
        convCache.set(key, { v, exp: Date.now() + 5 * 60_000 });
        return v;
    } catch (e) {
        console.error("[team-activity] conversation lookup failed:", e?.message || e);
        return null;
    }
}

// Turns "Sent a chat message / Ref 843e5de6" into who it went to, a preview and a deep link.
async function enrichChat(d, req, ctx) {
    if (!d.entityId) return d;
    const info = await conversationInfo(d.entityId, ctx.companyId);
    const b = req.body || {};
    const text = [b.text, b.message, b.body, b.content].find((x) => typeof x === "string" && x.trim());
    return {
        ...d,
        label: info?.otherName ? `Messaged ${info.otherName}` : d.label,
        entityType: "conversation",
        collapseMs: CHAT_MERGE_MS,
        meta: {
            ...d.meta,
            conversationId: String(d.entityId),
            counterpart: info?.otherName || null,
            preview: text ? text.trim().replace(/\s+/g, " ").slice(0, 120) : null,
            link: info ? `${info.asSeller ? "/grow" : "/save"}/chat/${d.entityId}` : null,
        },
    };
}


/* ------------------------ order + credit enrichment ------------------------ */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_NO_COLS = ["order_number", "order_no", "order_code", "display_id", "short_id", "reference"];

// The shop name for a seller, else the company name. null if neither is known.
const shopCache = new Map();
async function shopNameOf(userId) {
    const hit = shopCache.get(userId);
    if (hit && hit.exp > Date.now()) return hit.v;
    const { data } = await supabaseAdmin.from("seller_profiles").select("display_name").eq("user_id", userId).maybeSingle();
    let v = data?.display_name?.trim() || null;
    if (!v) { const c = await companyNameOf(userId); v = c !== "a company" ? c : null; }
    if (shopCache.size > 2000) shopCache.clear();
    shopCache.set(userId, { v, exp: Date.now() + 5 * 60_000 });
    return v;
}

// Order number + the other company. Only answers for orders the company itself is part of.
const orderCache = new Map();
async function orderInfo(orderId, companyId) {
    if (!UUID_RE.test(String(orderId))) return null;
    const key = `${orderId}:${companyId}`;
    const hit = orderCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    let v = null;
    try {
        const { data: row, error } = await supabaseAdmin.from("orders").select("*").eq("id", orderId).maybeSingle();
        if (error || !row) {
            console.warn("[team-activity] order not found:", orderId, error?.message || "");
        } else {
            const cols = Object.entries(row).filter(([k, x]) => /^(buyer|seller)(_?user)?(_?id)?$/i.test(k) && typeof x === "string" && UUID_RE.test(x));
            const mine = cols.find(([, x]) => x === companyId);
            const other = cols.find(([, x]) => x !== companyId);
            if (!mine) console.warn("[team-activity] company is not part of order", orderId, "columns:", Object.keys(row).join(","));
            else {
                const no = ORDER_NO_COLS.map((c) => row[c]).find((x) => x != null && String(x).trim());
                const otherName = other ? (/seller/i.test(other[0]) ? await shopNameOf(other[1]) : await partyName(other[1])) : null;
                v = { no: String(no ?? String(orderId).slice(0, 8).toUpperCase()), otherName };
            }
        }
    } catch (e) { console.error("[team-activity] order lookup failed:", e?.message || e); }
    if (orderCache.size > 2000) orderCache.clear();
    orderCache.set(key, { v, exp: Date.now() + (v ? 5 * 60_000 : 60_000) });
    return v;
}

const ORDER_VERB = {
    "Placed an order": "Placed order",
    "Cancelled an order": "Cancelled order",
    "Raised a dispute on an order": "Raised a dispute on order",
    "Responded to a dispute": "Responded to a dispute on order",
};
const SELLER_STEP = { confirm: "Confirmed", reject: "Rejected", ship: "Shipped", shipped: "Shipped", dispatch: "Dispatched", deliver: "Delivered", delivered: "Delivered", cancel: "Cancelled" };

function orderVerb(label, path) {
    if (label === "Updated a sales order") {
        const seg = String(path || "").split("/").pop().toLowerCase();
        return `${SELLER_STEP[seg] || "Updated"} order`;
    }
    return ORDER_VERB[label] || null;
}

function orderEntry(verb, action, orderId, info) {
    const sellerSide = /\/api\/seller\//.test(action);
    return {
        label: `${verb} #${info.no}` + (info.otherName ? ` ${sellerSide ? "for" : "with"} ${info.otherName}` : ""),
        link: sellerSide ? `/seller/orders/${orderId}` : `/orders/${orderId}`,
        meta: { orderId: String(orderId), orderNo: info.no, counterpart: info.otherName || null },
    };
}

// New order ids come back in the response of POST /api/orders.
function orderIdsFrom(b) {
    const out = [];
    const add = (x) => { if (typeof x === "string" && UUID_RE.test(x) && !out.includes(x)) out.push(x); };
    if (!b || typeof b !== "object") return out;
    add(b.orderId); add(b.order?.id); add(b.data?.id); add(b.id);
    (Array.isArray(b.orders) ? b.orders : []).forEach((o) => add(o?.id));
    (Array.isArray(b.orderIds) ? b.orderIds : []).forEach(add);
    return out;
}

async function enrichOrder(d, ctx, resBody) {
    let orderId = d.entityId;
    if (d.action === "POST /api/orders") {
        const ids = orderIdsFrom(resBody);
        if (!ids.length) return d;
        if (ids.length > 1) return { ...d, label: `Placed ${ids.length} orders`, entityType: "order", meta: { ...d.meta, link: "/orders" } };
        orderId = ids[0];
    }
    if (!orderId) return d;
    const verb = orderVerb(d.label, d.meta?.path);
    if (!verb) return d;
    const info = await orderInfo(orderId, ctx.companyId);
    if (!info) return d;
    const e = orderEntry(verb, d.action, orderId, info);
    return { ...d, label: e.label, entityType: "order", entityId: String(orderId), meta: { ...d.meta, ...e.meta, link: e.link } };
}

// credit label -> which side the OTHER company is on, and the new wording
const CREDIT = {
    "Requested credit from a seller": ["seller", (n) => `Requested credit from ${n}`],
    "Requested a higher credit limit": ["seller", (n) => `Requested a higher credit limit from ${n}`],
    "Gave credit to a buyer": ["buyer", (n) => `Gave credit to ${n}`],
    "Decided a credit request": ["buyer", (n) => `Decided ${n}'s credit request`],
    "Turned credit on or off for a buyer": ["buyer", (n) => `Turned credit on or off for ${n}`],
    "Declined a credit limit increase": ["buyer", (n) => `Declined ${n}'s credit limit increase`],
    "Changed a credit limit": ["buyer", (n) => `Changed the credit limit for ${n}`],
};

// Looks through params, body and response for e.g. sellerId / seller_id / seller.
function findParty(node, role, skip, depth = 0) {
    if (!node || typeof node !== "object" || depth > 3) return null;
    const re = new RegExp(role === "seller" ? "^(seller|vendor)(_?user)?(_?id)?$" : "^(buyer|customer)(_?user)?(_?id)?$", "i");
    for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string" && UUID_RE.test(v) && v !== skip && re.test(k)) return v;
    }
    for (const v of Object.values(node)) {
        if (v && typeof v === "object") { const f = findParty(v, role, skip, depth + 1); if (f) return f; }
    }
    return null;
}

async function enrichCredit(d, req, ctx, resBody) {
    const rule = CREDIT[d.label];
    if (!rule) return d;
    const [role, words] = rule;
    const src = { params: req.params || {}, body: req.body || {}, res: resBody || {} };
    const id = findParty(src, role, ctx.companyId);
    if (!id) {
        console.warn("[team-activity] credit: no", role, "found. params:", Object.keys(src.params).join(","),
            "| body:", Object.keys(src.body).join(","), "| response:", Object.keys(src.res).join(","));
        return { ...d, meta: { ...d.meta, link: "/credit" } };
    }
    const name = role === "seller" ? await shopNameOf(id) : await partyName(id);
    return {
        ...d,
        label: name ? words(name) : d.label,
        meta: { ...d.meta, counterpart: name || null, counterpartId: id, link: "/credit" },
    };
}

export async function enrichActivity(d, req, ctx, resBody) {
    try {
        if (d.category === "chat") return await enrichChat(d, req, ctx);
        if (d.category === "orders") return await enrichOrder(d, ctx, resBody);
        if (d.category === "credit") return await enrichCredit(d, req, ctx, resBody);
    } catch (e) { console.error("[team-activity] enrich failed:", e?.message || e); }
    return d;
}

// Repairs older rows when the log is opened (only those that kept an id).
export async function enrichStoredRows(rows, companyId) {
    return Promise.all(rows.map(async (r) => {
        if (r.meta?.link || !r.entity_id) return r;
        if (r.category === "chat") {
            const info = await conversationInfo(r.entity_id, companyId);
            if (!info) return r;
            return {
                ...r,
                label: info.otherName ? `Messaged ${info.otherName}` : r.label,
                meta: { ...r.meta, conversationId: String(r.entity_id), counterpart: info.otherName || null, link: `${info.asSeller ? "/grow" : "/save"}/chat/${r.entity_id}` },
            };
        }
        if (r.category === "orders") {
            const verb = orderVerb(r.label, r.meta?.path);
            if (!verb) return r;
            const info = await orderInfo(r.entity_id, companyId);
            if (!info) return r;
            const e = orderEntry(verb, r.action, r.entity_id, info);
            return { ...r, label: e.label, entity_type: "order", meta: { ...r.meta, ...e.meta, link: e.link } };
        }
        return r;
    }));
}