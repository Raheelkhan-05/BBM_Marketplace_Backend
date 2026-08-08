// Same shape as your seller upload endpoint — mirror its multer config
// (memoryStorage, single "file" field) if yours differs.

import { supabase } from "../config/supabase.js";
import { randomUUID } from "crypto";

const BUCKET = "catalog-assets";

export async function uploadCatalogImage(req, res) {
    try {
        const file = req.file;
        const folder = req.body?.folder || "misc";
        if (!file) return res.status(400).json({ success: false, message: "No file uploaded." });

        const ext = (file.originalname?.split(".").pop() || "jpg").toLowerCase();
        const path = `${folder}/${randomUUID()}.${ext}`;

        const { error: uploadErr } = await supabase.storage
            .from(BUCKET)
            .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
        if (uploadErr) return res.status(500).json({ success: false, message: uploadErr.message });

        const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
        res.json({ success: true, url: data.publicUrl });
    } catch (err) {
        console.error("uploadCatalogImage error:", err);
        res.status(500).json({ success: false, message: "Upload failed unexpectedly." });
    }
}