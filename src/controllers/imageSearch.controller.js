// backend/controllers/imageSearch.controller.js
//
// POST /api/search/image  { imageBase64, mimeType }
//
// 1. GPT-5.6-Luna vision identifies the product + does an image-safety
//    check (rejects weapons/unsafe/no-product photos before anything else
//    runs).
// 2. The identified term is run through the same resolver as text search:
//    embedding cascade (product -> subcategory -> category) against what
//    already exists, falling back to moderated AI classification + create
//    only if nothing matches confidently.
//
// The response carries a ready-to-display breadcrumb stack — the frontend
// jumps straight into it rather than re-running a text search.

import { classifyImageSearch } from "../services/imageSearchClassifier.service.js";
import { resolveOrCreateCatalogEntry } from "../services/catalogResolver.service.js";

export async function identifyProductFromImage(req, res) {
    const { imageBase64, mimeType } = req.body || {};

    if (!imageBase64 || !mimeType) {
        return res.status(400).json({ success: false, message: "imageBase64 and mimeType are required." });
    }
    if (!mimeType.startsWith("image/")) {
        return res.status(400).json({ success: false, message: "File must be an image." });
    }

    try {
        const visionResult = await classifyImageSearch(imageBase64, mimeType);

        if (!visionResult.valid || !visionResult.search_term) {
            return res.json({
                success: true,
                resolved: false,
                reason: visionResult.rejection_reason || "We couldn't identify a product in that photo. Try a clearer image.",
            });
        }

        const result = await resolveOrCreateCatalogEntry({ term: visionResult.search_term });
        return res.json({ ...result, searchTerm: visionResult.search_term });
    } catch (err) {
        console.error("identifyProductFromImage error:", err);
        return res.status(500).json({ success: false, message: "Image search failed. Please try again." });
    }
}