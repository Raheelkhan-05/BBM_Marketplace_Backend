// routes/sellerUpload.routes.js
import { createClient } from "@supabase/supabase-js";
import multer from "multer";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-only, never sent to frontend
);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// POST /api/seller/upload  (auth middleware sets req.userId)
router.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  const { folder = "misc", bucket = "seller-assets" } = req.body; // e.g. folder="logo" | "banner" | "photos" | "brochure" | "certs"
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: "No file provided." });

  const ext = file.originalname.split(".").pop();
  const path = `${req.userId}/${folder}/${Date.now()}.${ext}`;

  const { error } = await supabaseAdmin.storage.from(bucket).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });
  if (error) return res.status(500).json({ success: false, message: error.message });

  const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
  res.json({ success: true, url: data.publicUrl });
});

export default router;