import * as ads from "../services/ads.service.js";
import { collectFiles, validateAndUpload } from "../services/bannerImages.service.js";

const fail = (res, e, label) => {
    if (e instanceof ads.AdError) {
        return res.status(e.status).json({ success: false, code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
    }
    console.error(`[ads] ${label} failed:`, e);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
};
const wrap = (label, fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e, label); } };

/* public */
export const getLive = wrap("live", async (req, res) => {
    const keys = req.query.keys ? String(req.query.keys).split(",").slice(0, 20) : null;
    res.set("Cache-Control", "public, max-age=15");
    res.json({ success: true, ads: await ads.liveNow(keys) });
});

/* seller */
export const getPlacements = wrap("placements", async (req, res) => {
    const [placements, settings] = await Promise.all([ads.listPlacements(), ads.getSettings()]);
    res.json({
        success: true, gstPercent: Number(settings.gst_percent),
        placements: placements.map((p) => ({
            id: p.id, key: p.key, kind: p.kind, name: p.name, description: p.description, aspectKeys: p.aspect_keys,
            lanes: p.lanes, minHours: p.min_hours, maxHours: p.max_hours, maxDaysAhead: p.max_days_ahead,
            fromRate: Math.round(Number(p.base_rate_per_hour) * Number(p.min_multiplier) * 100) / 100,
        })),
    });
});

export const getAvailability = wrap("availability", async (req, res) => {
    res.json({ success: true, ...(await ads.availability({ key: req.params.key, month: req.query.month, day: req.query.day })) });
});

export const getQuote = wrap("quote", async (req, res) => {
    res.json({ success: true, quote: await ads.quote({ sellerId: req.sellerId, key: req.params.key, start: req.query.start, hours: req.query.hours }) });
});

export const uploadCreative = wrap("uploadCreative", async (req, res) => {
    const files = collectFiles(req);
    if (!Object.keys(files).length) return res.status(400).json({ success: false, message: "Choose an image first." });
    const up = await validateAndUpload(files, `ads/${req.sellerId}`);
    if (!up.ok) return res.status(up.status).json({ success: false, message: up.message });
    res.json({ success: true, images: Object.fromEntries(up.uploaded.map((u) => [u.shape, u.url])) });
});

export const postBooking = wrap("book", async (req, res) => {
    const b = req.body || {};
    const out = await ads.book({
        sellerId: req.sellerId, userId: req.user.id, key: b.placementKey, start: b.start, hours: b.hours,
        expectedTotal: b.expectedTotal, creativeInput: b.creative, idempotencyKey: b.idempotencyKey,
    });
    res.json({ success: true, booking: out });
});

export const getMyBookings = wrap("myBookings", async (req, res) => {
    res.json({ success: true, bookings: await ads.listMyBookings(req.sellerId) });
});

/* admin */
export const adminPlacements = wrap("adminPlacements", async (req, res) => {
    res.json({ success: true, placements: await ads.listPlacements({ includeInactive: true }), settings: await ads.getSettings() });
});
export const adminPatchPlacement = wrap("adminPatchPlacement", async (req, res) => {
    res.json({ success: true, placement: await ads.adminUpdatePlacement(req.params.id, req.body || {}, req.user.id) });
});
export const adminPatchSettings = wrap("adminPatchSettings", async (req, res) => {
    res.json({ success: true, settings: await ads.adminUpdateSettings(req.body || {}, req.user.id) });
});
export const adminOverrides = wrap("adminOverrides", async (req, res) => {
    res.json({ success: true, overrides: await ads.adminListOverrides(req.query.placementId) });
});
export const adminPostOverride = wrap("adminPostOverride", async (req, res) => {
    res.json({ success: true, override: await ads.adminCreateOverride(req.body || {}, req.user.id) });
});
export const adminDeleteOverride = wrap("adminDeleteOverride", async (req, res) => {
    await ads.adminRevokeOverride(req.params.id, req.user.id); res.json({ success: true });
});
export const adminPricing = wrap("adminPricing", async (req, res) => {
    res.json({ success: true, hours: await ads.adminPricing({ placementId: req.query.placementId, day: req.query.day }) });
});
export const adminBookings = wrap("adminBookings", async (req, res) => {
    const q = req.query;
    res.json({
        success: true, ...(await ads.adminListBookings({
            status: q.status, placementId: q.placementId, sellerId: q.sellerId, liveOnly: q.live === "1",
            limit: Number(q.limit) || 100, offset: Number(q.offset) || 0
        }))
    });
});
export const adminRemove = wrap("adminRemove", async (req, res) => {
    const out = await ads.adminRemoveBooking({ id: req.params.id, adminId: req.user.id, reason: req.body?.reason, refundMode: req.body?.refundMode });
    res.json({ success: true, result: out });
});