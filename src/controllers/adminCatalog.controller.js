import { supabase } from "../config/supabase.js";
import { notifyUser } from "../services/notifications.service.js";
import { slugify } from "../services/slugify.js";

const LEVEL_CONFIG = {
    category: { table: "hs_categories", label: "Category", editableFields: ["name", "slug", "image", "tagline", "hero_image", "overview"], embed: null },
    subcategory: {
        table: "hs_subcategories", label: "Subcategory",
        editableFields: ["name", "slug", "image", "tagline", "hero_image", "overview"],
        embed: "hs_categories(id, name, review_status)",
    },
    product: {
        table: "hs_products", label: "Product",
        editableFields: ["name", "slug", "image", "description", "generic_name", "variants", "attributes"],
        embed: "hs_subcategories(id, name, review_status, hs_categories(id, name, review_status))",
    },
    brand: {
        table: "hs_product_brands", label: "Brand Item",
        editableFields: ["name", "slug", "image", "brand_name", "description", "variants", "attributes"],
        embed: "hs_products(id, name, review_status, hs_subcategories(id, name, review_status, hs_categories(id, name, review_status)))",
    },
    generic_product: {
        table: "hs_generic_products", label: "Generic Product",
        editableFields: ["name", "slug", "image"],
        embed: "hs_subcategories(id, name, review_status, hs_categories(id, name, review_status))",
    },
    // Canonical identity of a brand item — name + brand + manufacturer +
    // model/part no./SKU + grade/variant + specifications + images ONLY.
    // Commercial terms (price/moq/unit/lead time/stock/packaging/delivery/
    // tax/etc.) live entirely on seller_product_submissions, one row per
    // seller, linked via generic_product_brand_id — this level never
    // touches those fields. manufacturer/model_no/grade_variant/
    // specifications describe the PRODUCT (shared by every seller listing
    // it), so they belong here, same as name/brand_name/images already do.
    brand_item: {
        table: "hs_generic_product_brands", label: "Brand Item",
        editableFields: [
            "name", "slug", "image", "images", "brand_name", "brand_image", "brand_not_applicable",
            "manufacturer", "model_no", "grade_variant", "specifications",
            "description", "manufacturing_details",
            "unit", "pack_size", "units_per_master_pack",   // NEW — fixed packaging identity
        ],
        embed: "hs_generic_products(id, name, review_status, hs_subcategories(id, name, review_status, hs_categories(id, name, review_status)))",
    },
};

const LEVEL_TABLE = {
    category: "hs_categories",
    subcategory: "hs_subcategories",
    generic_product: "hs_generic_products",
};
const PARENT_COL = {
    subcategory: "category_id",
    generic_product: "subcategory_id",
};

// FIX: added a "generic_product" entry so the third rung of
// CascadingHierarchyPicker, when mapping a brand_item, searches/creates
// against hs_generic_products instead of falling back to (or being
// hardcoded onto) "product" -> hs_products. Without this, "product" was
// the only picker level available for that rung's underlying table, so
// creating a new item there silently inserted into hs_products, producing
// a valid-looking id that later failed the hs_generic_products lookup in
// approveCatalogEntry with "Selected generic product wasn't found."
const PICKER_CONFIG = {
    category: { table: "hs_categories", parentField: null },
    subcategory: { table: "hs_subcategories", parentField: "category_id" },
    product: { table: "hs_products", parentField: "subcategory_id" },
    generic_product: { table: "hs_generic_products", parentField: "subcategory_id" },
};

const LEVEL_PARENT_FIELD = {
    subcategory: "category_id",
    product: "subcategory_id",
    brand: "product_id",
    generic_product: "subcategory_id",
    brand_item: "generic_product_id",
};

const CHILD_LEVEL_OF = {
    category: { level: "subcategory", field: "category_id" },
    subcategory: { level: "generic_product", field: "subcategory_id" },
    generic_product: { level: "brand_item", field: "generic_product_id" },
};

function cfgFor(level, res) {
    const cfg = LEVEL_CONFIG[level];
    if (!cfg) {
        res.status(400).json({ success: false, message: `Unknown level "${level}".` });
        return null;
    }
    return cfg;
}

function hasRejectedAncestor(level, row) {
    if (level === "subcategory") {
        return row.hs_categories?.review_status === "rejected";
    }
    if (level === "product") {
        const sc = row.hs_subcategories;
        return sc?.review_status === "rejected" || sc?.hs_categories?.review_status === "rejected";
    }
    if (level === "brand") {
        const p = row.hs_products;
        const sc = p?.hs_subcategories;
        return p?.review_status === "rejected" || sc?.review_status === "rejected" || sc?.hs_categories?.review_status === "rejected";
    }
    if (level === "generic_product") {
        const sc = row.hs_subcategories;
        return sc?.review_status === "rejected" || sc?.hs_categories?.review_status === "rejected";
    }
    if (level === "brand_item") {
        const gp = row.hs_generic_products;
        const sc = gp?.hs_subcategories;
        return gp?.review_status === "rejected" || sc?.review_status === "rejected" || sc?.hs_categories?.review_status === "rejected";
    }
    return false;
}

// GET /api/admin/catalog?level=all|category|subcategory|product|brand|generic_product|brand_item&status=&q=&parentId=
// NOTE: brand_item no longer has a special-cased branch here — its table
// (hs_generic_product_brands) has the same name/image/is_ai_generated
// shape as every other level, so it goes through the exact same generic
// path as category/subcategory/generic_product.
// export async function listCatalogEntries(req, res) {
//     const { level = "all", status = "pending_review", q = "", parentId = "" } = req.query;
//     const levels = level === "all" ? Object.keys(LEVEL_CONFIG) : [level];
//     const parentFieldForFilter = level !== "all" ? LEVEL_PARENT_FIELD[level] : null;

//     try {
//         const results = await Promise.all(
//             levels.map(async (lvl) => {
//                 const cfg = LEVEL_CONFIG[lvl];
//                 if (!cfg) return [];
//                 let query = supabase
//                     .from(cfg.table)
//                     .select(`id, name, image, is_ai_generated, review_status, created_at, rejection_reason${cfg.embed ? `, ${cfg.embed}` : ""}${lvl === "brand_item" ? ", brand_name, images, manufacturer, model_no, grade_variant" : ""}`)
//                     .order("created_at", { ascending: false })
//                     .limit(200);
//                 if (status !== "all") query = query.eq("review_status", status);
//                 if (q) query = query.ilike("name", `%${q}%`);
//                 if (parentId && parentFieldForFilter) query = query.eq(parentFieldForFilter, parentId);
//                 const { data, error } = await query;
//                 if (error) throw error;
//                 return (data || [])
//                     .filter((row) => !hasRejectedAncestor(lvl, row))
//                     .map((row) => ({ ...row, level: lvl }));
//             })
//         );
//         const merged = results.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
//         res.json({ success: true, entries: merged });
//     } catch (error) {
//         res.status(500).json({ success: false, message: error.message });
//     }
// }

// GET /api/admin/catalog/:level/:id
export async function getCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const { data, error } = await supabase
        .from(cfg.table)
        .select(`*${cfg.embed ? `, ${cfg.embed}` : ""}`)
        .eq("id", id)
        .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data || data.deleted_at) return res.status(404).json({ success: false, message: "Not found." });

    let ancestors = {};
    if (level === "subcategory") {
        ancestors = { category: data.hs_categories ? { id: data.hs_categories.id, name: data.hs_categories.name } : null };
    } else if (level === "product") {
        const sc = data.hs_subcategories;
        ancestors = {
            subcategory: sc ? { id: sc.id, name: sc.name } : null,
            category: sc?.hs_categories ? { id: sc.hs_categories.id, name: sc.hs_categories.name } : null,
        };
    } else if (level === "brand") {
        const p = data.hs_products;
        const sc = p?.hs_subcategories;
        ancestors = {
            product: p ? { id: p.id, name: p.name } : null,
            subcategory: sc ? { id: sc.id, name: sc.name } : null,
            category: sc?.hs_categories ? { id: sc.hs_categories.id, name: sc.hs_categories.name } : null,
        };
    } else if (level === "brand_item") {
        const gp = data.hs_generic_products;
        const sc = gp?.hs_subcategories;
        ancestors = {
            generic_product: gp ? { id: gp.id, name: gp.name } : null,
            subcategory: sc ? { id: sc.id, name: sc.name } : null,
            category: sc?.hs_categories ? { id: sc.hs_categories.id, name: sc.hs_categories.name } : null,
        };
    }

    res.json({
        success: true,
        level,
        editableFields: cfg.editableFields,
        entry: data,
        ancestors,
        parentRejected: hasRejectedAncestor(level, data),
    });
}

// PATCH /api/admin/catalog/:level/:id — save edits without changing review_status
// export async function updateCatalogEntry(req, res) {
//     const { level, id } = req.params;
//     const cfg = cfgFor(level, res);
//     if (!cfg) return;

//     const body = req.body || {};
//     const update = {};
//     for (const key of cfg.editableFields) if (body[key] !== undefined) update[key] = body[key];

//     // Keep the single `image` cover column in sync whenever `images`
//     // is provided, since every existing reader (tiles, hero sections,
//     // CatalogHierarchySearchPage, etc.) still only knows about `image`.
//     if (Array.isArray(update.images)) {
//         update.image = update.images[0] || null;
//     }

//     // specifications is stored as jsonb — strip blank rows so we never
//     // persist { key: "", value: "" } placeholders left over from the
//     // row editor.
//     if (Array.isArray(update.specifications)) {
//         update.specifications = update.specifications.filter((s) => s?.key?.trim());
//     }

//     const parentField = LEVEL_PARENT_FIELD[level];
//     if (parentField && body.parentId) update[parentField] = body.parentId;

//     if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No editable fields provided." });

//     const { data, error } = await supabase.from(cfg.table).update(update).eq("id", id).select().single();
//     if (error) {
//         if (error.code === "23505") return res.status(409).json({ success: false, message: "That product + brand combo already exists here." });
//         return res.status(500).json({ success: false, message: error.message });
//     }
//     res.json({ success: true, entry: data });
// }


export async function approveCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const body = req.body || {};

    // NEW: brand_item can no longer be approved without a category chain —
    // sellers no longer supply one, so this is the one place it gets set.
    if (level === "brand_item") {
        const genericProductId = body.parentId || null;
        if (!genericProductId) {
            return res.status(400).json({ success: false, message: "Map this item to a Category / Subcategory / Generic Product before approving." });
        }
        const { data: gp, error: gpErr } = await supabase
            .from("hs_generic_products").select("id, review_status").eq("id", genericProductId).maybeSingle();
        if (gpErr) return res.status(500).json({ success: false, message: gpErr.message });
        if (!gp) return res.status(400).json({ success: false, message: "Selected generic product wasn't found." });

        // NEW — packaging must be set (either already on the row, or in this
        // approval's body) before this brand item can go live for sellers.
        const { data: current } = await supabase.from("hs_generic_product_brands").select("unit, pack_size, units_per_master_pack").eq("id", id).maybeSingle();
        const finalUnit = body.unit ?? current?.unit;
        const finalPack = body.pack_size ?? current?.pack_size;
        const finalMaster = body.units_per_master_pack ?? current?.units_per_master_pack;
        if (!finalUnit || !(Number(finalPack) > 0) || !(Number(finalMaster) > 0)) {
            return res.status(400).json({ success: false, message: "Set Unit, Pack Size, and Units per Master Pack before approving." });
        }
    }

    const update = { review_status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: req.user.id, rejection_reason: null };
    for (const key of cfg.editableFields) if (body[key] !== undefined) update[key] = body[key];
    if (Array.isArray(update.specifications)) update.specifications = update.specifications.filter((s) => s?.key?.trim());

    const parentField = LEVEL_PARENT_FIELD[level];
    if (parentField && body.parentId) update[parentField] = body.parentId;

    const { data, error } = await supabase.from(cfg.table).update(update).eq("id", id).select().single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    // brand_item approval is the point at which seller listings linked to
    // it actually become visible to buyers — notify every seller with a
    // submission pointing at this brand item.
    if (level === "brand_item") {
        const { data: submissions, error: subErr } = await supabase
            .from("seller_product_submissions")
            .select("seller_id")
            .eq("generic_product_brand_id", id);

        if (subErr) {
            console.error("Failed to fetch seller submissions for notify:", subErr.message);
        } else if (submissions?.length) {
            const uniqueSellerIds = [...new Set(submissions.map((s) => s.seller_id))];
            uniqueSellerIds.forEach((sellerId) => {
                notifyUser(sellerId, {
                    type: "brand_item_approved",
                    title: "Your product is live!",
                    message: `"${data.name}" has been approved and is now visible to buyers.`,
                    link: `/seller/listings`,
                });
            });
        }
    }

    res.json({ success: true, entry: data });
}

// POST /api/admin/catalog/:level/:id/reject  { reason }
export async function rejectCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const { reason } = req.body || {};
    if (!reason?.trim()) return res.status(400).json({ success: false, message: "A rejection reason is required." });

    const update = {
        review_status: "rejected",
        rejection_reason: reason.trim(),
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.user.id,
    };
    const { data, error } = await supabase.from(cfg.table).update(update).eq("id", id).select().single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, entry: data });
}

// Walks down the hierarchy from `level`/`id` and collects every
// descendant id, grouped by table, so we can stamp deleted_at on
// the whole subtree in one shot.
async function collectDescendantIds(level, id) {
    const ids = { category: [], subcategory: [], generic_product: [], brand_item: [] };
    ids[level] = [id];

    if (level === "category") {
        const { data, error } = await supabase.from("hs_subcategories").select("id").eq("category_id", id);
        if (error) throw error;
        ids.subcategory = (data || []).map((r) => r.id);
    }

    if (level === "category" || level === "subcategory") {
        const subIds = level === "category" ? ids.subcategory : [id];
        if (subIds.length) {
            const { data, error } = await supabase.from("hs_generic_products").select("id").in("subcategory_id", subIds);
            if (error) throw error;
            ids.generic_product = (data || []).map((r) => r.id);
        }
    }

    if (level === "category" || level === "subcategory" || level === "generic_product") {
        const gpIds = level === "generic_product" ? [id] : ids.generic_product;
        if (gpIds.length) {
            const { data, error } = await supabase.from("hs_generic_product_brands").select("id").in("generic_product_id", gpIds);
            if (error) throw error;
            ids.brand_item = (data || []).map((r) => r.id);
        }
    }

    return ids;
}

// DELETE /api/admin/catalog/:level/:id
// Soft-delete: stamps deleted_at on this entry AND every descendant
// (category -> subcategory -> generic_product -> brand_item). Nothing
// is actually removed from the DB, and list/detail queries filter out
// deleted_at IS NOT NULL rows, so it just disappears from the UI.
// DELETE /api/admin/catalog/:level/:id
// FIXED: brand_item rows were never getting deleted_at stamped — the
// code correctly collected ids.brand_item via collectDescendantIds, and
// correctly rejected/deactivated their seller_product_submissions, but
// never touched hs_generic_product_brands itself. That left every
// descendant brand item fully "live" (deleted_at still null) even after
// deleting its category/subcategory/generic_product ancestor — anything
// downstream that only filters on deleted_at IS NULL (e.g. the Home Page
// category strip, catalog_browse, etc.) would still surface it as if
// nothing happened. Added the missing update below.
export async function deleteCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = TABLES[level];
    if (!cfg) return res.status(400).json({ success: false, message: `Invalid level "${level}".` });

    try {
        const ids = await collectDescendantIds(level, id);
        const now = new Date().toISOString();

        const ops = [];
        if (ids.category.length) ops.push(supabase.from("hs_categories").update({ deleted_at: now }).in("id", ids.category));
        if (ids.subcategory.length) ops.push(supabase.from("hs_subcategories").update({ deleted_at: now }).in("id", ids.subcategory));
        if (ids.generic_product.length) ops.push(supabase.from("hs_generic_products").update({ deleted_at: now }).in("id", ids.generic_product));
        // NEW — this was missing entirely. Every brand item under the
        // deleted subtree needs its own deleted_at stamped, not just its
        // seller submissions rejected.
        if (ids.brand_item.length) ops.push(supabase.from("hs_generic_product_brands").update({ deleted_at: now }).in("id", ids.brand_item));

        if (ids.brand_item.length) {
            await supabase
                .from("seller_product_submissions")
                .update({
                    review_status: "rejected",
                    rejection_reason: "Underlying product was removed from the catalog.",
                    is_active: false,
                    reviewed_at: new Date().toISOString(),
                    reviewed_by: null,
                })
                .in("generic_product_brand_id", ids.brand_item)
                .neq("review_status", "rejected");
        }

        const results = await Promise.all(ops);
        const failed = results.find((r) => r.error);
        if (failed) throw failed.error;

        const deletedCount = ids.category.length + ids.subcategory.length + ids.generic_product.length + ids.brand_item.length;
        res.json({ success: true, deletedCount });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// GET /api/admin/catalog/options?pickerLevel=category|subcategory|product|generic_product&parentId=&q=
export async function getMappingOptions(req, res) {
    const { pickerLevel, parentId, q = "" } = req.query;
    const picker = PICKER_CONFIG[pickerLevel];
    if (!picker) return res.status(400).json({ success: false, message: "Invalid pickerLevel." });

    let query = supabase.from(picker.table).select("id, name")
        .neq("review_status", "rejected")
        .is("deleted_at", null)
        .order("name").limit(30);

    if (picker.parentField) {
        if (!parentId) return res.json({ success: true, options: [] });
        query = query.eq(picker.parentField, parentId);
    }
    if (q) query = query.ilike("name", `%${q}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, options: data });
}

// POST /api/admin/catalog/options   { pickerLevel, name, parentId }
export async function createMappingOption(req, res) {
    const { pickerLevel, name, parentId } = req.body || {};
    const picker = PICKER_CONFIG[pickerLevel];
    if (!picker) return res.status(400).json({ success: false, message: "Invalid pickerLevel." });

    const trimmed = (name || "").trim();
    if (trimmed.length < 2) return res.status(400).json({ success: false, message: "Name must be at least 2 characters." });

    if (picker.parentField && !parentId) {
        return res.status(400).json({ success: false, message: `Select a ${pickerLevel === "subcategory" ? "category" : "subcategory"} first.` });
    }

    const slug = slugify(trimmed);
    const insert = { name: trimmed, slug, is_ai_generated: false, review_status: "approved" };
    if (picker.parentField) insert[picker.parentField] = parentId;

    const { data, error } = await supabase.from(picker.table).insert(insert).select("id, name").single();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "A record with that name already exists here." });
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true, option: data });
}

// POST /api/admin/catalog/:level   { ...fields, parentId }
// brand_item goes through the exact same generic path as every other
// level. Admin supplies name + brand_name + manufacturer + model_no +
// grade_variant (optional) + specifications (optional) + images here;
// commercial terms are a seller-listing concern, not part of the catalog
// identity.
// export async function createCatalogEntry(req, res) {
//     const { level } = req.params;
//     const cfg = cfgFor(level, res);
//     if (!cfg) return;

//     const body = req.body || {};
//     const name = (body.name || "").trim();
//     if (name.length < 2) return res.status(400).json({ success: false, message: "Name must be at least 2 characters." });

//     if ((level === "brand" || level === "brand_item") && !(body.brand_name || "").trim()) {
//         return res.status(400).json({ success: false, message: "Brand name is required." });
//     }
//     if (level === "brand_item" && !(body.manufacturer || "").trim()) {
//         return res.status(400).json({ success: false, message: "Manufacturer is required." });
//     }
//     if (level === "brand_item" && !(body.model_no || "").trim()) {
//         return res.status(400).json({ success: false, message: "Model / Part No. / SKU is required." });
//     }

//     const parentField = LEVEL_PARENT_FIELD[level];
//     if (parentField && !body.parentId) {
//         return res.status(400).json({ success: false, message: "Select a parent before creating." });
//     }

//     const insert = {
//         name,
//         is_ai_generated: false,
//         review_status: "approved",
//         reviewed_at: new Date().toISOString(),
//         reviewed_by: req.user.id,
//     };
//     for (const key of cfg.editableFields) {
//         if (key === "name" || key === "slug") continue;
//         if (body[key] !== undefined && body[key] !== "") insert[key] = body[key];
//     }
//     if (Array.isArray(insert.images) && insert.images.length) {
//         insert.image = insert.images[0];
//     }
//     if (Array.isArray(insert.specifications)) {
//         insert.specifications = insert.specifications.filter((s) => s?.key?.trim());
//     }

//     if (level === "brand" || level === "brand_item") insert.brand_name = body.brand_name.trim();
//     if (level === "brand_item") {
//         insert.manufacturer = body.manufacturer.trim();
//         insert.model_no = body.model_no.trim();
//         if (body.grade_variant !== undefined) insert.grade_variant = body.grade_variant?.trim() || null;
//     }

//     insert.slug = slugify((body.slug || "").trim() || name);
//     if (parentField) insert[parentField] = body.parentId;

//     const { data, error } = await supabase
//         .from(cfg.table)
//         .insert(insert)
//         .select(`*${cfg.embed ? `, ${cfg.embed}` : ""}`)
//         .single();

//     if (error) {
//         if (error.code === "23505") return res.status(409).json({ success: false, message: "A record with that name/brand already exists here." });
//         if (error.code === "23502") return res.status(400).json({ success: false, message: `Missing required field: ${error.column || "unknown"}.` });
//         return res.status(500).json({ success: false, message: error.message });
//     }
//     res.json({ success: true, level, entry: data });
// }

// GET /api/admin/catalog?level=&parentId=&q=
export async function adminListCatalog(req, res) {
    const { level, parentId, q = "" } = req.query;
    const table = LEVEL_TABLE[level];
    if (!table) return res.status(400).json({ success: false, message: "Invalid level." });


    let query = supabase.from(table).select("id, name, review_status").is("deleted_at", null).order("name").limit(30);
    // Show both approved AND pending here — admin should see a seller's
    // already-proposed node so they reuse it, not just approved ones.
    query = query.in("review_status", ["approved", "pending_review"]);
    if (level !== "category") {
        const col = PARENT_COL[level];
        if (!parentId) return res.status(400).json({ success: false, message: "parentId is required." });
        query = query.eq(col, parentId);
    }
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, entries: data || [] });
}

// POST /api/admin/catalog  { level, name, parentId }
export async function adminCreateCatalogEntry(req, res) {
    const { level, name, parentId } = req.body || {};
    const table = LEVEL_TABLE[level];
    if (!table) return res.status(400).json({ success: false, message: "Invalid level." });
    if (!name?.trim()) return res.status(400).json({ success: false, message: "Name is required." });
    if (level !== "category" && !parentId) return res.status(400).json({ success: false, message: "Parent is required." });
    const trimmed = name.trim();

    // Same dedupe pattern as the seller-side create endpoints — check
    // for an existing match (approved or pending) under the same parent
    // before inserting, so admin can't create a near-duplicate either.
    let dupQuery = supabase.from(table).select("id, name, review_status").ilike("name", trimmed);
    if (level !== "category") dupQuery = dupQuery.eq(PARENT_COL[level], parentId);
    const { data: dup } = await dupQuery.maybeSingle();
    if (dup) {
        return res.json({
            success: true, duplicate: true, entry: dup,
            message: `"${dup.name}" already exists — selected it for you.`,
        });
    }

    const insertRow = { name: trimmed, slug: slugify(trimmed), review_status: "approved", is_ai_generated: false, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() };
    if (level !== "category") insertRow[PARENT_COL[level]] = parentId;

    const { data, error } = await supabase.from(table).insert(insertRow).select("id, name, review_status").single();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "That entry already exists." });
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true, duplicate: false, entry: data, message: `"${data.name}" created and live immediately.` });
}

const TABLES = {
    category: { table: "hs_categories", parentCol: null },
    subcategory: { table: "hs_subcategories", parentCol: "category_id" },
    generic_product: { table: "hs_generic_products", parentCol: "subcategory_id" },
    brand_item: { table: "hs_generic_product_brands", parentCol: "generic_product_id" },
};

// GET /api/admin/catalog?level=category|subcategory|generic_product|brand_item&parentId=&q=
export async function listCatalogEntries(req, res) {
    const { level, parentId, q = "" } = req.query;
    const cfg = TABLES[level];
    if (!cfg) return res.status(400).json({ success: false, message: `Invalid level "${level}".` });
    if (cfg.parentCol && !parentId) return res.status(400).json({ success: false, message: "Missing parentId." });

    const selectCols = level === "brand_item"
        ? "id, name, image, images, brand_name, review_status, is_ai_generated, unit, pack_size, units_per_master_pack"
        : "id, name, image, review_status, is_ai_generated";

    let query = supabase.from(cfg.table).select(selectCols).is("deleted_at", null).order("name").limit(200);
    if (cfg.parentCol) query = query.eq(cfg.parentCol, parentId);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, entries: data || [] });
}

// POST /api/admin/catalog/:level  { name, parentId }
export async function createCatalogEntry(req, res) {
    const { level } = req.params;
    const { name, parentId } = req.body || {};
    const cfg = TABLES[level];
    if (!cfg) return res.status(400).json({ success: false, message: `Invalid level "${level}".` });
    const trimmed = (name || "").trim();
    if (trimmed.length < 2) return res.status(400).json({ success: false, message: "Name is too short." });
    if (cfg.parentCol && !parentId) return res.status(400).json({ success: false, message: "Missing parentId." });

    // Reuse an existing entry with the same name under the same parent
    // instead of creating a duplicate.
    let existingQuery = supabase.from(cfg.table).select("id, name, review_status").ilike("name", trimmed);
    if (cfg.parentCol) existingQuery = existingQuery.eq(cfg.parentCol, parentId);
    const { data: existing } = await existingQuery.maybeSingle();
    if (existing) {
        return res.json({ success: true, entry: existing, duplicate: true, message: `"${existing.name}" already exists — selected it.` });
    }

    const row = { name: trimmed, slug: slugify(`${trimmed}-${Date.now()}`), review_status: "approved" };
    if (cfg.parentCol) row[cfg.parentCol] = parentId;

    const { data: created, error } = await supabase.from(cfg.table).insert(row).select("id, name, review_status").single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, entry: created, message: `Created "${created.name}".` });
}

// PATCH /api/admin/catalog/:level/:id   { parentId }
// Used to re-parent hs_generic_product_brands (level = "brand_item") onto
// a generic product — this is what "Fix mapping" ultimately writes.
// PATCH /api/admin/catalog/:level/:id
// Handles two distinct callers:
//   1. CreateSimpleCatalogModal's edit flow — sends name/image (any level)
//      or the full brand_item identity payload (brand_name, manufacturer,
//      model_no, grade_variant, specifications, images, unit, pack_size,
//      units_per_master_pack).
//   2. FixMappingPicker's "Fix mapping" flow — sends only { parentId } for
//      level: "brand_item", to re-parent onto a different generic product.
const EDITABLE_FIELDS = {
    category: ["name", "image"],
    subcategory: ["name", "image"],
    generic_product: ["name", "image"],
    brand_item: [
        "name", "image", "images", "brand_name",
        "manufacturer", "model_no", "grade_variant", "specifications",
        "unit", "pack_size", "units_per_master_pack",
    ],
};

export async function updateCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = TABLES[level];
    if (!cfg) return res.status(400).json({ success: false, message: `Invalid level "${level}".` });

    const body = req.body || {};
    const update = {};
    for (const key of (EDITABLE_FIELDS[level] || [])) {
        if (body[key] !== undefined) update[key] = body[key];
    }

    // Keep the single `image` cover column in sync when `images` is sent.
    if (Array.isArray(update.images)) update.image = update.images[0] || null;

    // Strip blank specification rows before persisting.
    if (Array.isArray(update.specifications)) {
        update.specifications = update.specifications.filter((s) => s?.key?.trim());
    }

    // brand_item re-parenting — this is what "Fix mapping" writes.
    if (level === "brand_item" && body.parentId) update.generic_product_id = body.parentId;

    if (!Object.keys(update).length) {
        return res.status(400).json({ success: false, message: "No editable fields provided." });
    }

    const { data, error } = await supabase.from(cfg.table).update(update).eq("id", id).select().maybeSingle();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "A record with that name already exists here." });
        return res.status(500).json({ success: false, message: error.message });
    }
    if (!data) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, entry: data });
}

// GET /api/admin/catalog/search?q=...
// Searches name (and brand_name, for brand_item) across every level at
// once — category, subcategory, generic_product, brand_item — instead of
// being scoped to whatever level the admin currently has open. Each hit
// carries its full ancestor chain so the frontend can jump straight to
// it in context (same "path" shape AdminCatalogReviewPage already uses
// for its breadcrumbs), rather than the admin having to drill down
// manually level by level to find where a match actually lives.
// Excludes soft-deleted rows at every level, same as listCatalogEntries.
export async function searchCatalogEverywhere(req, res) {
    const { q = "" } = req.query;
    const trimmed = q.trim();
    if (trimmed.length < 2) {
        return res.json({ success: true, results: [] });
    }

    try {
        const [categories, subcategories, genericProducts, brandItems] = await Promise.all([
            supabase
                .from("hs_categories")
                .select("id, name, image, review_status")
                .is("deleted_at", null)
                .ilike("name", `%${trimmed}%`)
                .limit(15),

            supabase
                .from("hs_subcategories")
                .select("id, name, image, review_status, category_id, hs_categories(id, name)")
                .is("deleted_at", null)
                .ilike("name", `%${trimmed}%`)
                .limit(15),

            supabase
                .from("hs_generic_products")
                .select("id, name, image, review_status, subcategory_id, hs_subcategories(id, name, category_id, hs_categories(id, name))")
                .is("deleted_at", null)
                .ilike("name", `%${trimmed}%`)
                .limit(15),

            supabase
                .from("hs_generic_product_brands")
                .select("id, name, brand_name, image, review_status, generic_product_id, hs_generic_products(id, name, subcategory_id, hs_subcategories(id, name, category_id, hs_categories(id, name)))")
                .is("deleted_at", null)
                .or(`name.ilike.%${trimmed}%,brand_name.ilike.%${trimmed}%`)
                .limit(15),
        ]);

        for (const r of [categories, subcategories, genericProducts, brandItems]) {
            if (r.error) throw r.error;
        }

        const results = [
            ...categories.data.map((row) => ({
                level: "category",
                id: row.id,
                name: row.name,
                image: row.image,
                review_status: row.review_status,
                path: [],
            })),

            ...subcategories.data.map((row) => ({
                level: "subcategory",
                id: row.id,
                name: row.name,
                image: row.image,
                review_status: row.review_status,
                path: row.hs_categories
                    ? [{ level: "category", id: row.hs_categories.id, name: row.hs_categories.name }]
                    : [],
            })),

            ...genericProducts.data.map((row) => {
                const sc = row.hs_subcategories;
                const c = sc?.hs_categories;
                const path = [];
                if (c) path.push({ level: "category", id: c.id, name: c.name });
                if (sc) path.push({ level: "subcategory", id: sc.id, name: sc.name });
                return {
                    level: "generic_product",
                    id: row.id,
                    name: row.name,
                    image: row.image,
                    review_status: row.review_status,
                    path,
                };
            }),

            ...brandItems.data.map((row) => {
                const gp = row.hs_generic_products;
                const sc = gp?.hs_subcategories;
                const c = sc?.hs_categories;
                const path = [];
                if (c) path.push({ level: "category", id: c.id, name: c.name });
                if (sc) path.push({ level: "subcategory", id: sc.id, name: sc.name });
                if (gp) path.push({ level: "generic_product", id: gp.id, name: gp.name });
                return {
                    level: "brand_item",
                    id: row.id,
                    name: row.brand_name ? `${row.name} — ${row.brand_name}` : row.name,
                    image: row.image,
                    review_status: row.review_status,
                    path,
                };
            }),
        ];

        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}


// GET /api/admin/catalog/unmapped?level=subcategory|generic_product|brand_item&q=
// Lists rows at a level that have NO parent set at all — category_id is
// null for a subcategory, subcategory_id is null for a generic_product,
// generic_product_id is null for a brand_item. These can never show up
// under any parentId-scoped listCatalogEntries() call (there's no
// parentId that matches "no parent"), so they were invisible to the
// normal drill-down UI even though they're live, undeleted rows —
// mainly brand items sellers create directly (see createBrandItem in
// sellerCatalogListings.controller.js, which leaves generic_product_id
// null on purpose; mapping happens later as a separate admin task).
const UNMAPPED_CONFIG = {
    subcategory: { table: "hs_subcategories", parentCol: "category_id" },
    generic_product: { table: "hs_generic_products", parentCol: "subcategory_id" },
    brand_item: { table: "hs_generic_product_brands", parentCol: "generic_product_id" },
};

export async function listUnmappedCatalogEntries(req, res) {
    const { level, q = "" } = req.query;
    const cfg = UNMAPPED_CONFIG[level];
    if (!cfg) return res.status(400).json({ success: false, message: `Invalid level "${level}" for unmapped lookup.` });

    const selectCols = level === "brand_item"
        ? "id, name, image, images, brand_name, review_status, is_ai_generated, created_at"
        : "id, name, image, review_status, is_ai_generated, created_at";

    let query = supabase
        .from(cfg.table)
        .select(selectCols)
        .is(cfg.parentCol, null)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(200);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, entries: data || [] });
}

// GET /api/admin/catalog/unmapped/counts — small badge counts for the
// three levels, so the frontend can show "Unmapped (12)" without the
// admin having to open each tab to find out if there's anything there.
export async function getUnmappedCatalogCounts(req, res) {
    try {
        const [sub, gp, brand] = await Promise.all([
            supabase.from("hs_subcategories").select("id", { count: "exact", head: true }).is("category_id", null).is("deleted_at", null),
            supabase.from("hs_generic_products").select("id", { count: "exact", head: true }).is("subcategory_id", null).is("deleted_at", null),
            supabase.from("hs_generic_product_brands").select("id", { count: "exact", head: true }).is("generic_product_id", null).is("deleted_at", null),
        ]);
        for (const r of [sub, gp, brand]) if (r.error) throw r.error;
        res.json({
            success: true,
            counts: { subcategory: sub.count || 0, generic_product: gp.count || 0, brand_item: brand.count || 0 },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// GET /api/admin/brands?q=
// Groups hs_generic_product_brands by brand_name, returning one row per
// brand with a representative image/brand_image and how many items use it.
// Rows with brand_not_applicable = true or brand_name null are excluded —
// there's nothing to manage for those.
export async function listBrands(req, res) {
    const { q = "" } = req.query;

    let query = supabase
        .from("hs_generic_product_brands")
        .select("brand_name, brand_image")
        .is("deleted_at", null)
        .not("brand_name", "is", null)
        .eq("brand_not_applicable", false);

    if (q.trim()) query = query.ilike("brand_name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    // Group in memory — brand_name isn't its own table, so there's no
    // GROUP BY to push down to postgres here.
    const byName = new Map();
    for (const row of data || []) {
        const key = row.brand_name.trim();
        if (!byName.has(key)) byName.set(key, { brand_name: key, brand_image: row.brand_image || null, item_count: 0 });
        const entry = byName.get(key);
        entry.item_count += 1;
        if (!entry.brand_image && row.brand_image) entry.brand_image = row.brand_image;
    }

    const brands = [...byName.values()].sort((a, b) => a.brand_name.localeCompare(b.brand_name));
    res.json({ success: true, brands });
}

// PATCH /api/admin/brands/:brandName   { newName, brandImage }
// Bulk-updates every hs_generic_product_brands row currently carrying
// brandName (case-insensitive match) — renaming it and/or swapping the
// logo everywhere at once, instead of per-item.
export async function updateBrand(req, res) {
    const { brandName } = req.params;
    const { newName, brandImage } = req.body || {};

    const decodedName = decodeURIComponent(brandName).trim();
    if (!decodedName) return res.status(400).json({ success: false, message: "Missing brand name." });

    const update = {};
    if (newName !== undefined) {
        const trimmed = newName.trim();
        if (trimmed.length < 2) return res.status(400).json({ success: false, message: "Brand name must be at least 2 characters." });
        update.brand_name = trimmed;
    }
    if (brandImage !== undefined) update.brand_image = brandImage || null;

    if (!Object.keys(update).length) {
        return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    // If renaming, check the target name doesn't already exist as a
    // *different* brand — otherwise this silently merges two brands
    // together, which the admin should confirm explicitly rather than
    // have happen by accident.
    if (update.brand_name && update.brand_name.toLowerCase() !== decodedName.toLowerCase()) {
        const { data: clash } = await supabase
            .from("hs_generic_product_brands")
            .select("id")
            .ilike("brand_name", update.brand_name)
            .is("deleted_at", null)
            .limit(1)
            .maybeSingle();
        if (clash && !req.body.confirmMerge) {
            return res.status(409).json({
                success: false,
                mergeConflict: true,
                message: `"${update.brand_name}" already exists as a brand. Renaming will merge these two brands — confirm to proceed.`,
            });
        }
    }

    const { data, error, count } = await supabase
        .from("hs_generic_product_brands")
        .update(update)
        .ilike("brand_name", decodedName)
        .is("deleted_at", null)
        .select("id", { count: "exact" });

    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({
        success: true,
        updatedCount: count ?? data?.length ?? 0,
        brand: { brand_name: update.brand_name || decodedName, brand_image: update.brand_image !== undefined ? update.brand_image : undefined },
    });
}