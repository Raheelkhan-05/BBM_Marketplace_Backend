// backend/services/cloudinaryConvert.service.js
//
// You store final assets in Supabase Storage, not Cloudinary — so Cloudinary
// is used purely as a one-shot conversion step: upload the AI PNG, request
// an AVIF-format delivery, pull those bytes back down, then delete the
// Cloudinary copy so nothing lingers there.

import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// base64Png: raw base64 string (no data: prefix)
// publicId: a unique-ish id, e.g. `product-${productId}`
// Returns a Buffer of AVIF bytes.
export async function convertPngToAvif(base64Png, publicId) {
    const uploadRes = await cloudinary.uploader.upload(
        `data:image/png;base64,${base64Png}`,
        {
            public_id: publicId,
            folder: "bbm-ai-catalog-tmp",
            format: "avif",
            overwrite: true,
            quality: "auto:good",
        }
    );

    const resp = await fetch(uploadRes.secure_url);
    if (!resp.ok) throw new Error(`Failed to fetch converted AVIF (${resp.status}).`);
    const buffer = Buffer.from(await resp.arrayBuffer());

    // Best-effort cleanup — don't fail the request over this.
    cloudinary.uploader.destroy(uploadRes.public_id, { resource_type: "image" }).catch(() => { });

    return buffer;
}