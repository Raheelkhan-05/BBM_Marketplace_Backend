// services/orderBookProduct.service.js
// Builds the product "snapshot" saved on every Order Book line, so later catalog edits never change an old order.
// Reads the seller listing row (seller_product_submissions) plus its joined brand row (sub.brand).
// Specs and document lists are stored as loose JSON, so the readers below accept strings, arrays and objects.

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const HTTP = /^https?:\/\//i;
const MAX_SPECS = 30;
const MAX_DOCS = 12;

const asJson = (v) => {
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch { return null; }
};

export function normalizeSpecs(...sources) {
    const out = [];
    const seen = new Set();
    const add = (label, value) => {
        const l = clip(label, 80), v = clip(value, 200);
        if (!l || !v) return;
        const k = l.toLowerCase();
        if (seen.has(k) || out.length >= MAX_SPECS) return;
        seen.add(k);
        out.push({ label: l, value: v });
    };
    for (const raw of sources) {
        const src = asJson(raw);
        if (Array.isArray(src)) {
            for (const s of src) {
                if (s && typeof s === "object") {
                    add(s.label ?? s.key ?? s.name ?? s.title ?? s.spec, s.value ?? s.val ?? s.text ?? s.detail);
                } else if (typeof s === "string" && s.includes(":")) {
                    const [a, ...rest] = s.split(":");
                    add(a, rest.join(":"));
                }
            }
        } else if (src && typeof src === "object") {
            for (const [k, v] of Object.entries(src)) if (v == null || typeof v !== "object") add(k, v);
        }
    }
    return out;
}

const urlOf = (o) => {
    for (const k of ["url", "file_url", "fileUrl", "link", "href", "publicUrl", "public_url", "value"]) {
        const v = o?.[k];
        if (typeof v === "string" && HTTP.test(v)) return v;
    }
    return null;
};

// groups: [[groupLabel, rawList], ...] -> [{ group, label, url|null }]
export function normalizeDocs(groups) {
    const out = [];
    const seen = new Set();
    for (const [group, raw] of groups) {
        const list = asJson(raw);
        if (!Array.isArray(list)) continue;
        for (const d of list) {
            if (out.length >= MAX_DOCS) return out;
            let label = "", url = null;
            if (typeof d === "string") {
                if (HTTP.test(d)) url = d; else label = clip(d, 120);
            } else if (d && typeof d === "object") {
                url = urlOf(d);
                label = clip(d.name ?? d.title ?? d.label ?? d.file_name ?? d.fileName ?? d.type ?? d.certificate ?? "", 120);
            }
            if (!url && !label) continue;
            const key = `${group}|${url || label}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ group, label: label || group, url });
        }
    }
    return out;
}

export function productDetails(sub) {
    const b = sub?.brand || {};
    return {
        packSize: num(sub.pack_size),
        unitsPerMasterPack: num(sub.units_per_master_pack),
        masterPackSize: num(sub.master_pack_size),
        packagingType: clip(sub.packaging_type, 80),
        hsnCode: clip(sub.hsn_code, 20),
        gstPercent: sub.gst_percent != null && Number.isFinite(Number(sub.gst_percent)) ? Number(sub.gst_percent) : null,
        manufacturer: clip(sub.manufacturer || b.manufacturer, 120),
        modelNo: clip(sub.model_no || b.model_no, 80),
        gradeVariant: clip(sub.grade_variant, 80),
        description: clip(b.description, 600),
        specs: normalizeSpecs(sub.specifications, b.specifications),
        docs: normalizeDocs([
            ["Quality certificate", sub.quality_certificates],
            ["TDS / MSDS / COA", sub.tds_msds_coa],
            ["Other certification", sub.other_certifications],
        ]),
    };
}