// backend/services/fileImport/importLanding.service.js
export function computeLandingDecision(resolvedRows) {
    const successful = resolvedRows.filter((r) => r.resolved && r.stack?.length);
    const summary = buildSummary(resolvedRows);
    if (!successful.length) return { type: "none", summary };

    const uniqueByLevel = (level) =>
        dedupeById(successful.map((r) => r.stack.find((s) => s.level === level)).filter(Boolean));

    // Brand items: only land there if EVERY row resolved to a brand AND
    // they're all the same brand item — otherwise a mixed PDF (some rows
    // branded, some generic) has no single honest brand-level landing.
    const allRowsBranded = successful.every((r) => r.stack.some((s) => s.level === "brand"));
    const brands = uniqueByLevel("brand");
    if (allRowsBranded && brands.length === 1) {
        return { type: "brand", target: brands[0], summary };
    }

    // Step up one level at a time: single product -> product page;
    // multiple products but one subcategory -> subcategory page;
    // multiple subcategories but one category -> category page;
    // multiple categories -> explore page with all of them listed.
    const products = uniqueByLevel("product");
    if (products.length === 1) return { type: "product", target: products[0], summary };

    const subcategories = uniqueByLevel("subcategory");
    if (subcategories.length === 1) return { type: "subcategory", target: subcategories[0], summary };

    const categories = uniqueByLevel("category");
    if (categories.length === 1) return { type: "category", target: categories[0], summary };

    return { type: "explore", categories, summary };
}

function dedupeById(arr) {
    const seen = new Map();
    for (const item of arr) if (item && !seen.has(item.id)) seen.set(item.id, item);
    return [...seen.values()];
}

function buildSummary(resolvedRows) {
    const resolved = resolvedRows.filter((r) => r.resolved);
    const rejected = resolvedRows.filter((r) => !r.resolved);
    const created = resolved.filter(
        (r) => r.categoryRow?.isNew || r.subcategoryRow?.isNew || r.productRow?.isNew || r.brandRow?.isNew
    );
    return {
        total: resolvedRows.length,
        matched: resolved.length - created.length,
        created: created.length,
        rejected: rejected.length,
        rejections: rejected.slice(0, 20).map((r) => ({ rowId: r.rowId, reason: r.reason })),
    };
}