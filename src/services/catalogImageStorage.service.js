// backend/services/catalogImageStorage.service.js
//
// Final home for AI-generated catalog images: Supabase Storage.
// Requires a public bucket named "catalog-images" (see 002_ai_catalog_columns.sql).

import { supabase } from "../config/supabase.js";

const BUCKET = "catalog-images";

// buffer: AVIF bytes, storagePath e.g. `products/<productId>.avif`
// Returns the public URL.
export async function uploadCatalogImage(buffer, storagePath) {
    const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
        contentType: "image/avif",
        upsert: true,
    });
    if (error) throw error;

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    return data.publicUrl;
}