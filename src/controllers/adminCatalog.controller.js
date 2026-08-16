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
        editableFields: ["name", "slug", "image", "brand_name", "images", "manufacturer", "model_no", "grade_variant", "specifications"],
        embed: "hs_generic_products(id, name, review_status, hs_subcategories(id, name, review_status, hs_categories(id, name, review_status)))",
    },
};

const PICKER_CONFIG = {
    category: { table: "hs_categories", parentField: null },
    subcategory: { table: "hs_subcategories", parentField: "category_id" },
    product: { table: "hs_products", parentField: "subcategory_id" },
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
export async function listCatalogEntries(req, res) {
    const { level = "all", status = "pending_review", q = "", parentId = "" } = req.query;
    const levels = level === "all" ? Object.keys(LEVEL_CONFIG) : [level];
    const parentFieldForFilter = level !== "all" ? LEVEL_PARENT_FIELD[level] : null;

    try {
        const results = await Promise.all(
            levels.map(async (lvl) => {
                const cfg = LEVEL_CONFIG[lvl];
                if (!cfg) return [];
                let query = supabase
                    .from(cfg.table)
                    .select(`id, name, image, is_ai_generated, review_status, created_at, rejection_reason${cfg.embed ? `, ${cfg.embed}` : ""}${lvl === "brand_item" ? ", brand_name, images, manufacturer, model_no, grade_variant" : ""}`)
                    .order("created_at", { ascending: false })
                    .limit(200);
                if (status !== "all") query = query.eq("review_status", status);
                if (q) query = query.ilike("name", `%${q}%`);
                if (parentId && parentFieldForFilter) query = query.eq(parentFieldForFilter, parentId);
                const { data, error } = await query;
                if (error) throw error;
                return (data || [])
                    .filter((row) => !hasRejectedAncestor(lvl, row))
                    .map((row) => ({ ...row, level: lvl }));
            })
        );
        const merged = results.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ success: true, entries: merged });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

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
    if (!data) return res.status(404).json({ success: false, message: "Not found." });

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
export async function updateCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const body = req.body || {};
    const update = {};
    for (const key of cfg.editableFields) if (body[key] !== undefined) update[key] = body[key];

    // Keep the single `image` cover column in sync whenever `images`
    // is provided, since every existing reader (tiles, hero sections,
    // CatalogHierarchySearchPage, etc.) still only knows about `image`.
    if (Array.isArray(update.images)) {
        update.image = update.images[0] || null;
    }

    // specifications is stored as jsonb — strip blank rows so we never
    // persist { key: "", value: "" } placeholders left over from the
    // row editor.
    if (Array.isArray(update.specifications)) {
        update.specifications = update.specifications.filter((s) => s?.key?.trim());
    }

    if (level === "brand_item" && update.brand_name !== undefined && !update.brand_name.trim()) {
        return res.status(400).json({ success: false, message: "Brand name can't be empty." });
    }
    if (level === "brand_item" && update.manufacturer !== undefined && !String(update.manufacturer).trim()) {
        return res.status(400).json({ success: false, message: "Manufacturer can't be empty." });
    }
    if (level === "brand_item" && update.model_no !== undefined && !String(update.model_no).trim()) {
        return res.status(400).json({ success: false, message: "Model / Part No. / SKU can't be empty." });
    }

    const parentField = LEVEL_PARENT_FIELD[level];
    if (parentField && body.parentId) update[parentField] = body.parentId;

    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No editable fields provided." });

    const { data, error } = await supabase.from(cfg.table).update(update).eq("id", id).select().single();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "That product + brand combo already exists here." });
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true, entry: data });
}

export async function approveCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const body = req.body || {};
    const update = { review_status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: req.user.id, rejection_reason: null };
    for (const key of cfg.editableFields) if (body[key] !== undefined) update[key] = body[key];
    if (Array.isArray(update.specifications)) {
        update.specifications = update.specifications.filter((s) => s?.key?.trim());
    }

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

// DELETE /api/admin/catalog/:level/:id
export async function deleteCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const childInfo = CHILD_LEVEL_OF[level];
    if (childInfo) {
        const childCfg = LEVEL_CONFIG[childInfo.level];
        const { count, error: countErr } = await supabase
            .from(childCfg.table)
            .select("id", { count: "exact", head: true })
            .eq(childInfo.field, id);
        if (countErr) return res.status(500).json({ success: false, message: countErr.message });
        if (count > 0) {
            return res.status(409).json({
                success: false,
                message: `Can't delete — ${count} item${count === 1 ? "" : "s"} still live under this. Delete those first.`,
            });
        }
    }

    // brand_item has one more dependent to check that isn't a catalog
    // "level" in LEVEL_CONFIG: real seller listings pointing at it via
    // generic_product_brand_id. Deleting it out from under an active
    // seller listing would either FK-violate or silently orphan them.
    if (level === "brand_item") {
        const { count, error: countErr } = await supabase
            .from("seller_product_submissions")
            .select("id", { count: "exact", head: true })
            .eq("generic_product_brand_id", id);
        if (countErr) return res.status(500).json({ success: false, message: countErr.message });
        if (count > 0) {
            return res.status(409).json({
                success: false,
                message: `Can't delete — ${count} seller listing${count === 1 ? " is" : "s are"} still linked to this item.`,
            });
        }
    }

    const { error } = await supabase.from(cfg.table).delete().eq("id", id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}

// GET /api/admin/catalog/options?pickerLevel=category|subcategory|product&parentId=&q=
export async function getMappingOptions(req, res) {
    const { pickerLevel, parentId, q = "" } = req.query;
    const picker = PICKER_CONFIG[pickerLevel];
    if (!picker) return res.status(400).json({ success: false, message: "Invalid pickerLevel." });

    let query = supabase.from(picker.table).select("id, name").neq("review_status", "rejected").order("name").limit(30);

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
export async function createCatalogEntry(req, res) {
    const { level } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const body = req.body || {};
    const name = (body.name || "").trim();
    if (name.length < 2) return res.status(400).json({ success: false, message: "Name must be at least 2 characters." });

    if ((level === "brand" || level === "brand_item") && !(body.brand_name || "").trim()) {
        return res.status(400).json({ success: false, message: "Brand name is required." });
    }
    if (level === "brand_item" && !(body.manufacturer || "").trim()) {
        return res.status(400).json({ success: false, message: "Manufacturer is required." });
    }
    if (level === "brand_item" && !(body.model_no || "").trim()) {
        return res.status(400).json({ success: false, message: "Model / Part No. / SKU is required." });
    }

    const parentField = LEVEL_PARENT_FIELD[level];
    if (parentField && !body.parentId) {
        return res.status(400).json({ success: false, message: "Select a parent before creating." });
    }

    const insert = {
        name,
        is_ai_generated: false,
        review_status: "approved",
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.user.id,
    };
    for (const key of cfg.editableFields) {
        if (key === "name" || key === "slug") continue;
        if (body[key] !== undefined && body[key] !== "") insert[key] = body[key];
    }
    if (Array.isArray(insert.images) && insert.images.length) {
        insert.image = insert.images[0];
    }
    if (Array.isArray(insert.specifications)) {
        insert.specifications = insert.specifications.filter((s) => s?.key?.trim());
    }

    if (level === "brand" || level === "brand_item") insert.brand_name = body.brand_name.trim();
    if (level === "brand_item") {
        insert.manufacturer = body.manufacturer.trim();
        insert.model_no = body.model_no.trim();
        if (body.grade_variant !== undefined) insert.grade_variant = body.grade_variant?.trim() || null;
    }

    insert.slug = slugify((body.slug || "").trim() || name);
    if (parentField) insert[parentField] = body.parentId;

    const { data, error } = await supabase
        .from(cfg.table)
        .insert(insert)
        .select(`*${cfg.embed ? `, ${cfg.embed}` : ""}`)
        .single();

    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "A record with that name/brand already exists here." });
        if (error.code === "23502") return res.status(400).json({ success: false, message: `Missing required field: ${error.column || "unknown"}.` });
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true, level, entry: data });
}