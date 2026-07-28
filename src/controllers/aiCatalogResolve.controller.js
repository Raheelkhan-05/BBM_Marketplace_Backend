// backend/controllers/aiCatalogResolve.controller.js
//
// POST /api/search/ai-resolve  { query, level, parentId }
//
// Last-resort fallback: called only when the buyer explicitly taps
// "Search with AI" after scoped DB search and cross-level smart search
// both come up empty.
//
// All actual logic (embedding cascade, moderation, mapping, find-or-create,
// image generation) lives in catalogResolver.service.js and is shared with
// the image-search endpoint — this controller is just the thin HTTP layer.

import { resolveOrCreateCatalogEntry } from "../services/catalogResolver.service.js";

const MIN_QUERY_LEN = 3;

export async function resolveWithAI(req, res) {
    const { query = "", level, parentId } = req.body || {};
    const term = query.trim();

    if (term.length < MIN_QUERY_LEN) {
        return res.status(400).json({ success: false, message: "Search term is too short." });
    }

    try {
        const result = await resolveOrCreateCatalogEntry({ term, level, parentId });
        return res.json(result);
    } catch (err) {
        console.error("resolveWithAI error:", err);
        return res.status(500).json({ success: false, message: "AI catalog resolution failed. Please try again." });
    }
}