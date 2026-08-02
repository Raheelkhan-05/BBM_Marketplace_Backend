// backend/services/fileImport/importResolver.service.js
import { resolveCategory, resolveSubcategory, resolveProduct, resolveBrandItem } from "./catalogResolver.service.js";

// jobCache is a plain Map, scoped to one import job, so repeated rows in
// the same PDF (e.g. 40 rows that are all "10W-40 Engine Oil" variants)
// don't each trigger their own DB round trip — the DB's own exact-name +
// unique-constraint safety nets still guarantee correctness either way.
async function resolveWithCache(jobCache, level, nameHint, resolverFn) {
    const cacheKey = nameHint ? `${level}:${nameHint.trim().toLowerCase()}` : null;
    if (cacheKey && jobCache.has(cacheKey)) return jobCache.get(cacheKey);
    const result = await resolverFn();
    if (cacheKey && result) jobCache.set(cacheKey, result);
    return result;
}

export async function resolveImportRow({ classification, shortlists, embeddingByKey, log, jobCache }) {
    const categoryRow = await resolveWithCache(jobCache, "category", classification.new_category_name,
        () => resolveCategory(classification, shortlists, embeddingByKey, log));
    if (!categoryRow) return { resolved: false, reason: "Could not categorize." };

    const subcategoryRow = await resolveWithCache(jobCache, "subcategory", classification.new_subcategory_name,
        () => resolveSubcategory(classification, categoryRow.id, shortlists, embeddingByKey, log));

    const productRow = subcategoryRow
        ? await resolveWithCache(jobCache, "product", classification.generic_name,
            () => resolveProduct(classification, subcategoryRow.id, shortlists, embeddingByKey, log))
        : null;

    const brandRow = productRow
        ? await resolveBrandItem(classification, productRow.id, shortlists, embeddingByKey, log)
        : null;

    return {
        resolved: true,
        categoryRow, subcategoryRow, productRow, brandRow,
        stack: [categoryRow, subcategoryRow, productRow, brandRow].filter(Boolean)
            .map((r, i) => ({ level: ["category", "subcategory", "product", "brand"][i], id: r.id, name: r.name })),
    };
}