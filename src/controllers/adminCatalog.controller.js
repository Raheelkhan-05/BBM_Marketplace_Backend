import { supabase } from "../config/supabase.js";
import { slugify } from "../services/slugify.js";
import { ALLOWED_UNITS } from "./sellerCatalogListings.controller.js";

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
    // NEW leaf level under generic_product. Backed by the SAME table real
    // sellers submit into (seller_product_submissions) — admin-added rows
    // are flagged is_admin_added=true and auto-approved, so this page and
    // the seller self-publish flow share one source of truth with no
    // duplicate schema. Note the table has no "name" or "is_ai_generated"
    // column — it uses "product_name" — so this level is branched
    // separately wherever that matters (see comments below).
    brand_item: {
        table: "hs_generic_product_brands", label: "Brand Item",
        editableFields: ["name", "slug", "image", "brand_name"],
        embed: "hs_generic_products(id, name, review_status, hs_subcategories(id, name, review_status, hs_categories(id, name, review_status)))",
    },
};

const CREATE_CONFIG = {
    subcategory: { table: "hs_categories" },
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
export async function listCatalogEntries(req, res) {
    const { level = "all", status = "pending_review", q = "", parentId = "" } = req.query;
    const levels = level === "all" ? Object.keys(LEVEL_CONFIG) : [level];
    const parentFieldForFilter = level !== "all" ? LEVEL_PARENT_FIELD[level] : null;

    try {
        const results = await Promise.all(
            levels.map(async (lvl) => {
                // brand_item's underlying table has a different shape
                // (product_name not name, no is_ai_generated) — branch it
                // and normalize the response so the frontend list UI,
                // which expects .name/.image/.is_ai_generated, works
                // unchanged across every level.
                if (lvl === "brand_item") {
                    let query = supabase
                        .from("seller_product_submissions")
                        .select(`id, product_name, brand_name, image, price, moq, unit, lead_time, review_status, created_at, rejection_reason, is_admin_added,
                            hs_generic_products(id, name, review_status, hs_subcategories(id, name, review_status, hs_categories(id, name, review_status)))`)
                        .order("created_at", { ascending: false })
                        .limit(200);
                    if (status !== "all") query = query.eq("review_status", status);
                    if (q) query = query.ilike("product_name", `%${q}%`);
                    if (parentId) query = query.eq("generic_product_id", parentId);
                    const { data, error } = await query;
                    if (error) throw error;
                    return (data || [])
                        .filter((row) => !hasRejectedAncestor("brand_item", row))
                        .map((row) => ({
                            id: row.id,
                            name: row.product_name,
                            brand_name: row.brand_name,
                            image: row.image,
                            price: row.price,
                            moq: row.moq,
                            unit: row.unit,
                            lead_time: row.lead_time,
                            review_status: row.review_status,
                            created_at: row.created_at,
                            rejection_reason: row.rejection_reason,
                            is_ai_generated: false,
                            is_admin_added: row.is_admin_added,
                            level: "brand_item",
                        }));
                }

                const cfg = LEVEL_CONFIG[lvl];
                if (!cfg) return [];
                let query = supabase
                    .from(cfg.table)
                    .select(`id, name, image, is_ai_generated, review_status, created_at, rejection_reason${cfg.embed ? `, ${cfg.embed}` : ""}`)
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
        data.name = data.product_name; // normalize for any generic consumer
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

    if (level === "brand_item") {
        // Frontend uses "name" consistently across every level's modal —
        // map it onto this table's real column, product_name.
        if (body.name !== undefined && body.product_name === undefined) body.product_name = body.name;
        if (body.price !== undefined) body.price = Number(body.price);
        if (body.moq !== undefined) body.moq = Number(body.moq);
        if (body.unit !== undefined && !ALLOWED_UNITS.includes(body.unit)) {
            return res.status(400).json({ success: false, message: "Invalid unit." });
        }
    }

    const update = {};
    for (const key of cfg.editableFields) if (body[key] !== undefined) update[key] = body[key];

    const parentField = LEVEL_PARENT_FIELD[level];
    if (parentField && body.parentId) update[parentField] = body.parentId;

    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No editable fields provided." });

    const { data, error } = await supabase.from(cfg.table).update(update).eq("id", id).select().single();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "That product + brand combo already exists here." });
        return res.status(500).json({ success: false, message: error.message });
    }
    if (level === "brand_item") data.name = data.product_name;
    res.json({ success: true, entry: data });
}

export async function approveCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const body = req.body || {};
    const update = { review_status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: req.user.id, rejection_reason: null };
    for (const key of cfg.editableFields) if (body[key] !== undefined) update[key] = body[key];

    const parentField = LEVEL_PARENT_FIELD[level];
    if (parentField && body.parentId) update[parentField] = body.parentId;

    const { data, error } = await supabase.from(cfg.table).update(update).eq("id", id).select().single();
    if (error) return res.status(500).json({ success: false, message: error.message });
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

// Shared helper: walk generic_product -> subcategory -> category, since
// seller_product_submissions requires subcategory_id + category_id
// (NOT NULL FKs) even though the frontend only ever picks the generic
// product.
async function resolveGenericProductChain(genericProductId) {
    const { data, error } = await supabase
        .from("hs_generic_products")
        .select("id, review_status, subcategory:hs_subcategories(id, category:hs_categories(id))")
        .eq("id", genericProductId)
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Selected generic product wasn't found.");
    if (!data.subcategory?.id || !data.subcategory?.category?.id) {
        throw new Error("This generic product is missing category information.");
    }
    return { subcategoryId: data.subcategory.id, categoryId: data.subcategory.category.id };
}

// POST /api/admin/catalog/:level   { ...fields, parentId }
export async function createCatalogEntry(req, res) {
    const { level } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const body = req.body || {};

    // brand_item has its own shape entirely (product_name/brand_name/
    // price/moq/unit/lead_time/image, plus required subcategory_id/
    // category_id it doesn't get directly from the UI) — branch it fully
    // rather than force it through the generic name/slug path below.
    if (level === "brand_item") {
        const productName = (body.name || body.product_name || "").trim();
        const missing = [];
        if (productName.length < 2) missing.push("Product name");
        if (!(body.brand_name || "").trim()) missing.push("Brand name");
        if (!body.image) missing.push("Image");
        if (!body.parentId) missing.push("Generic product");
        if (missing.length) return res.status(400).json({ success: false, message: `Please provide: ${missing.join(", ")}.` });

        let chain;
        try {
            chain = await resolveGenericProductChain(body.parentId);
        } catch (e) {
            return res.status(400).json({ success: false, message: e.message });
        }

        const insert = {
            seller_id: null,
            generic_product_id: body.parentId,
            subcategory_id: chain.subcategoryId,
            category_id: chain.categoryId,
            product_name: productName,
            brand_name: body.brand_name.trim(),
            price: Number(body.price),
            moq: Number(body.moq),
            unit: body.unit,
            lead_time: body.lead_time.trim(),
            image: body.image,
            is_admin_added: true,
            review_status: "approved",
            reviewed_at: new Date().toISOString(),
            reviewed_by: req.user.id,
        };

        const { data, error } = await supabase
            .from("seller_product_submissions")
            .insert(insert)
            .select(`*, ${cfg.embed}`)
            .single();
        if (error) {
            if (error.code === "23505") return res.status(409).json({ success: false, message: "This product + brand already exists under this generic product." });
            return res.status(500).json({ success: false, message: error.message });
        }
        data.name = data.product_name;
        return res.json({ success: true, level, entry: data });
    }

    const name = (body.name || "").trim();
    if (name.length < 2) return res.status(400).json({ success: false, message: "Name must be at least 2 characters." });

    if (level === "brand_item" && !(body.brand_name || "").trim()) {
        return res.status(400).json({ success: false, message: "Brand name is required." });
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
    if (level === "brand") insert.brand_name = body.brand_name.trim();
    if (level === "brand_item") insert.brand_name = body.brand_name.trim();

    insert.slug = slugify((body.slug || "").trim() || name);
    if (parentField) insert[parentField] = body.parentId;

    const { data, error } = await supabase
        .from(cfg.table)
        .insert(insert)
        .select(`*${cfg.embed ? `, ${cfg.embed}` : ""}`)
        .single();

    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "A record with that name/slug already exists here." });
        if (error.code === "23502") return res.status(400).json({ success: false, message: `Missing required field: ${error.column || "unknown"}.` });
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true, level, entry: data });
}