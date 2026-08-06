// backend/utils/sanitizeSpecValue.js
//
// Strips web-search citation artifacts before ANY spec value is written
// to the DB — a hard backstop, not just a prompt instruction, because
// prompts get ignored occasionally and buyers should never see this leak
// through regardless.
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /\(?https?:\/\/[^\s)]+\)?/g;
const TRAILING_CITATION_RE = /\s*\(\s*(source|via|see)?:?\s*[^)]*\)\s*$/i;

export function sanitizeSpecValue(raw) {
    if (raw == null) return raw;
    let value = String(raw);
    value = value.replace(MARKDOWN_LINK_RE, (_, text) => text); // "[15W-40](url)" -> "15W-40"
    value = value.replace(BARE_URL_RE, "");
    value = value.replace(TRAILING_CITATION_RE, "");
    value = value.replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim();
    return value.replace(/[\s,;]+$/g, "").trim();
}

export function sanitizeSpecValues(values) {
    return values.map((v) => ({ ...v, value: sanitizeSpecValue(v.value) })).filter((v) => v.value);
}