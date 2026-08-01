// backend/controllers/adminCatalog.controller.js
import { supabase } from "../config/supabase.js";
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
};

const CREATE_CONFIG = {
    subcategory: {
        table: "hs_categories", // dropdown searches/creates in the PARENT table for this level... 
    },
};

const PICKER_CONFIG = {
    category: { table: "hs_categories", parentField: null },
    subcategory: { table: "hs_subcategories", parentField: "category_id" },
    product: { table: "hs_products", parentField: "subcategory_id" },
};


function cfgFor(level, res) {
    const cfg = LEVEL_CONFIG[level];
    if (!cfg) {
        res.status(400).json({ success: false, message: `Unknown level "${level}".` });
        return null;
    }
    return cfg;
}

// True if any ancestor in this entity's chain has been rejected. Rejection
// doesn't cascade-delete children (they're kept around so the AI resolver
// won't recreate them), but a child with a rejected parent has nowhere
// valid to live and shouldn't clutter the review queue.
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
    return false;
}

// GET /api/admin/catalog?level=all|category|subcategory|product|brand&status=pending_review|approved|rejected|all&q=
export async function listCatalogEntries(req, res) {
    const { level = "all", status = "pending_review", q = "" } = req.query;
    const levels = level === "all" ? Object.keys(LEVEL_CONFIG) : [level];

    try {
        const results = await Promise.all(
            levels.map(async (lvl) => {
                const cfg = LEVEL_CONFIG[lvl];
                if (!cfg) return [];
                let query = supabase
                    .from(cfg.table)
                    .select(`id, name, image, is_ai_generated, review_status, created_at, rejection_reason${cfg.embed ? `, ${cfg.embed}` : ""}`)
                    .order("created_at", { ascending: false })
                    .limit(200);
                if (status !== "all") query = query.eq("review_status", status);
                if (q) query = query.ilike("name", `%${q}%`);
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

// PATCH /api/admin/catalog/:level/:id  — save edits without changing review_status
const LEVEL_PARENT_FIELD = { subcategory: "category_id", product: "subcategory_id", brand: "product_id" };

export async function updateCatalogEntry(req, res) {
    const { level, id } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const body = req.body || {};
    const update = {};
    for (const key of cfg.editableFields) if (body[key] !== undefined) update[key] = body[key];

    const parentField = LEVEL_PARENT_FIELD[level];
    if (parentField && body.parentId) update[parentField] = body.parentId;

    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No editable fields provided." });

    const { data, error } = await supabase.from(cfg.table).update(update).eq("id", id).select().single();
    if (error) return res.status(500).json({ success: false, message: error.message });
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
    // Row stays in the DB with review_status='rejected' — buyer queries exclude it,
    // but the AI resolver's embedding shortlists still see it, so it won't be recreated.
}

// GET /api/admin/catalog/options?pickerLevel=category|subcategory|product&parentId=&q=
export async function getMappingOptions(req, res) {
    const { pickerLevel, parentId, q = "" } = req.query;
    const picker = PICKER_CONFIG[pickerLevel];
    if (!picker) return res.status(400).json({ success: false, message: "Invalid pickerLevel." });

    let query = supabase.from(picker.table).select("id, name").neq("review_status", "rejected").order("name").limit(30);

    if (picker.parentField) {
        if (!parentId) return res.json({ success: true, options: [] }); // nothing selected upstream yet
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
export async function createCatalogEntry(req, res) {
    const { level } = req.params;
    const cfg = cfgFor(level, res);
    if (!cfg) return;

    const body = req.body || {};
    const name = (body.name || "").trim();
    if (name.length < 2) return res.status(400).json({ success: false, message: "Name must be at least 2 characters." });

    // hs_product_brands.brand_name is NOT NULL with no default — must validate explicitly
    // or the insert throws a raw Postgres constraint error.
    if (level === "brand" && !(body.brand_name || "").trim()) {
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