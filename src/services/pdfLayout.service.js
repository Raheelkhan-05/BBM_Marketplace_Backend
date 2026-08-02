// backend/services/fileImport/pdfLayout.service.js
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const LINE_TOLERANCE = 3; // pt — merges only near-identical baselines into one physical text line

export async function extractPages(fileBuffer) {
    const data = fileBuffer instanceof Uint8Array && fileBuffer.constructor === Uint8Array
        ? fileBuffer
        : new Uint8Array(fileBuffer);   // strips the Buffer subclass wrapper pdfjs rejects
    const doc = await getDocument({ data }).promise;

    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const [tokens, images] = await Promise.all([extractTextTokens(page), extractImageXObjects(page)]);
        pages.push({ pageNumber: i, tokens, images });
    }
    return pages;
}

async function extractTextTokens(page) {
    const content = await page.getTextContent();
    return content.items
        .filter((it) => it.str.trim())
        .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5] }));
}

async function extractImageXObjects(page) {
    const opList = await page.getOperatorList();
    const images = [];
    let ctmStack = [[1, 0, 0, 1, 0, 0]];
    for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];
        if (fn === OPS.save) ctmStack.push([...ctmStack[ctmStack.length - 1]]);
        if (fn === OPS.restore) ctmStack.pop();
        // PDF spec: cm concatenates as CTM_new = M_operand x CTM_old — the
        // new matrix is the LEFT operand. (Fixed from an earlier reversed
        // version that happened to look right only for unnested transforms.)
        if (fn === OPS.transform) ctmStack[ctmStack.length - 1] = multiplyCtm(args, ctmStack[ctmStack.length - 1]);
        if (fn === OPS.paintImageXObject) {
            const ctm = ctmStack[ctmStack.length - 1];
            images.push({ x: ctm[4], y: ctm[5], width: Math.abs(ctm[0]), height: Math.abs(ctm[3]) });
        }
    }
    return images;
}

function multiplyCtm([a, b, c, d, e, f], [a2, b2, c2, d2, e2, f2]) {
    return [a * a2 + b * c2, a * b2 + b * d2, c * a2 + d * c2, c * b2 + d * d2, e * a2 + f * c2 + e2, e * b2 + f * d2 + f2];
}

// ---- row clustering ----

export function clusterRows(page) {
    const lines = groupTokensIntoLines(page.tokens, LINE_TOLERANCE);
    let rowGroups = groupLinesIntoRows(lines);

    const geometryLooksUnreliable =
        (rowGroups.length === 1 && lines.length > 3) ||
        (page.images.length >= 3 && rowGroups.length > page.images.length * 2.5);

    if (geometryLooksUnreliable && page.images.length >= 2) {
        console.log(`clusterRows: page ${page.pageNumber} geometry split looked unreliable (${rowGroups.length} groups vs ${page.images.length} images) — using image-anchored fallback`);
        rowGroups = groupLinesByNearestImage(lines, page.images);
    }

    const rows = rowGroups
        .map((group, idx) => {
            const allTokens = group.flatMap((line) => line.tokens);
            if (!allTokens.length) return null;
            const sortedTokens = [...allTokens].sort((a, b) => a.y - b.y || a.x - b.x);
            const yTop = Math.max(...group.map((l) => l.yCenter));
            const yBottom = Math.min(...group.map((l) => l.yCenter));
            return {
                rowId: `p${page.pageNumber}-r${idx}`,
                rawText: group
                    .map((line) => [...line.tokens].sort((a, b) => a.x - b.x).map((t) => t.text).join(" "))
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim(),
                yCenter: (yTop + yBottom) / 2,
                yTop, yBottom,
                xMin: Math.min(...sortedTokens.map((t) => t.x)),
                xMax: Math.max(...sortedTokens.map((t) => t.x)),
                pageNumber: page.pageNumber,
            };
        })
        .filter((r) => r && r.rawText.length > 1);

    const imageMappingTrusted = rows.length > 0 && Math.abs(page.images.length - rows.length) <= Math.ceil(rows.length * 0.4);
    if (imageMappingTrusted) assignImagesToRows(rows, page.images);
    else for (const row of rows) row.image = null;

    console.log(`clusterRows: page ${page.pageNumber} -> ${lines.length} lines, ${rows.length} rows, ${page.images.length} images`);
    return { rows, imageMappingTrusted };
}

function groupLinesByNearestImage(lines, images) {
    const sortedImages = [...images].sort((a, b) => b.y - a.y);
    const buckets = sortedImages.map(() => []);

    for (const line of lines) {
        let closestIdx = 0;
        let closestDist = Infinity;
        sortedImages.forEach((img, i) => {
            const dist = Math.abs(img.y - line.yCenter);
            if (dist < closestDist) { closestDist = dist; closestIdx = i; }
        });
        buckets[closestIdx].push(line);
    }

    return buckets.filter((b) => b.length > 0);
}

function groupTokensIntoLines(tokens, tolerance) {
    const sorted = [...tokens].sort((a, b) => b.y - a.y);
    const lines = [];
    for (const t of sorted) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.lastY - t.y) <= tolerance) {
            last.tokens.push(t);
            last.lastY = t.y;
        } else {
            lines.push({ tokens: [t], lastY: t.y });
        }
    }
    for (const l of lines) l.yCenter = l.tokens.reduce((s, t) => s + t.y, 0) / l.tokens.length;
    return lines.sort((a, b) => b.yCenter - a.yCenter);
}

function groupLinesIntoRows(lines) {
    if (lines.length <= 1) return lines.map((l) => [l]);

    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
        gaps.push(lines[i - 1].yCenter - lines[i].yCenter);
    }

    const threshold = computeRowBoundaryThreshold(gaps);

    const groups = [];
    let current = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
        if (gaps[i - 1] > threshold) {
            groups.push(current);
            current = [lines[i]];
        } else {
            current.push(lines[i]);
        }
    }
    groups.push(current);
    return groups;
}

const MIN_JUMP_RATIO = 1.8;
const MIN_ABSOLUTE_GAP_DIFF = 2;

function computeRowBoundaryThreshold(gaps) {
    const sorted = [...gaps].sort((a, b) => a - b);
    if (sorted.length < 4) {
        return sorted.length && sorted[sorted.length - 1] > 14 ? sorted[sorted.length - 1] * 0.99 : Infinity;
    }

    let bestJumpRatio = 1;
    let bestThreshold = Infinity;
    for (let i = 1; i < sorted.length; i++) {
        const prevGap = sorted[i - 1];
        const gap = sorted[i];
        if (gap - prevGap < MIN_ABSOLUTE_GAP_DIFF) continue;
        const ratio = prevGap > 0 ? gap / prevGap : Infinity;
        if (ratio > bestJumpRatio) {
            bestJumpRatio = ratio;
            bestThreshold = (prevGap + gap) / 2;
        }
    }

    if (bestJumpRatio < MIN_JUMP_RATIO) return Infinity;
    return bestThreshold;
}

function assignImagesToRows(rows, images) {
    const X_MARGIN = 40;
    const Y_MARGIN = 6;

    const candidates = [];
    rows.forEach((row, ri) => {
        images.forEach((img, ii) => {
            const withinYSpan = img.y >= row.yBottom - Y_MARGIN && img.y <= row.yTop + Y_MARGIN;
            if (!withinYSpan) return;
            const inColumn = img.x + img.width >= row.xMin - X_MARGIN && img.x <= row.xMax + X_MARGIN;
            if (!inColumn) return;
            const rowMid = (row.yTop + row.yBottom) / 2;
            candidates.push({ ri, ii, score: Math.abs(img.y - rowMid) });
        });
    });
    candidates.sort((a, b) => a.score - b.score);

    const usedRows = new Set(), usedImages = new Set();
    for (const c of candidates) {
        if (usedRows.has(c.ri) || usedImages.has(c.ii)) continue;
        rows[c.ri].image = images[c.ii];
        usedRows.add(c.ri);
        usedImages.add(c.ii);
    }
    for (const row of rows) if (row.image === undefined) row.image = null;
}