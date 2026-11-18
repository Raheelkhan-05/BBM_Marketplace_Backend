// MUST mirror src/utils/storeTheme.js on the frontend.
const TEMPLATES = ["letterhead", "solid", "cover", "compact"];
const ACCENTS = [
    "#0F63B5",
    "#1F3A5F",
    "#B4351B",
    "#1E6B52",
    "#0F6E7A",
    "#8A5A00",
    "#9C2C5B",
    "#23272B",

    // New colors
    "#F4511E",
    "#FFD60A",
    "#1E78D6",
    "#22A06B",
    "#0B5563",
];
const LEGACY_HIGHLIGHTS = {
    gst: "GST invoice", credit: "Credit available", delivery: "Doorstep delivery",
    bulk: "Bulk pricing", support: "Direct seller support",
};

function allowedCoverPrefix() {
    const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
    return base ? `${base}/storage/v1/object/public/seller-assets/` : null;
}

const line = (v, max) =>
    typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

const para = (v, max) =>
    typeof v === "string"
        ? v.replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f<>]/g, " ").replace(/[ \t]+/g, " ")
            .replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max)
        : "";

function list(raw, max, len, legacy) {
    const seen = new Set();
    const out = [];
    for (const x of Array.isArray(raw) ? raw : []) {
        const t = line((legacy && legacy[x]) || x, len);
        const k = t.toLowerCase();
        if (!t || seen.has(k)) continue;
        seen.add(k);
        out.push(t);
        if (out.length >= max) break;
    }
    return out;
}

export function sanitizeStoreTheme(raw) {
    const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const template = TEMPLATES.includes(r.template) ? r.template : "letterhead";
    const accent = ACCENTS.find((a) => a.toLowerCase() === String(r.accent || "").toLowerCase()) || ACCENTS[0];
    const prefix = allowedCoverPrefix();
    const coverUrl = typeof r.coverUrl === "string" && r.coverUrl.length <= 500
        && /^https:\/\/\S+$/.test(r.coverUrl) && (!prefix || r.coverUrl.startsWith(prefix))
        ? r.coverUrl : "";
    return {
        v: 2, template, accent,
        tagline: line(r.tagline, 90),
        about: para(r.about, 280),
        sells: list(r.sells, 6, 28),
        highlights: list(r.highlights, 4, 32, LEGACY_HIGHLIGHTS),
        points: list(r.points, 4, 70),
        coverUrl,
    };
}