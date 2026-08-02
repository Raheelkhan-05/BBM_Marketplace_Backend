// backend/controllers/catalogImport.controller.js
import multer from "multer";
import { waitUntil } from "@vercel/functions";
import { supabase } from "../config/supabase.js";
import { runImportJob } from "../services/runImportJob.service.js";

export const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }).single("file");

export async function startCatalogImport(req, res) {
    console.log("Started Importing...");

    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: "No file uploaded." });
    if (file.mimetype !== "application/pdf") return res.status(400).json({ success: false, message: "Please upload a PDF file." });

    const { data: job, error } = await supabase
        .from("hs_import_jobs")
        .insert({ status: "processing", progress: { processed: 0, total: 0, phase: "queued" } })
        .select("id")
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    waitUntil(runImportJob(job.id, file.buffer));
    res.json({ success: true, jobId: job.id });
}

export async function getCatalogImportStatus(req, res) {
    const { jobId } = req.params;
    const { data, error } = await supabase.from("hs_import_jobs").select("*").eq("id", jobId).maybeSingle();
    if (error) return res.status(500).json({ success: false, status: "failed", message: error.message });
    if (!data) return res.status(404).json({ success: false, status: "failed", message: "Import job not found." });
    res.json({ success: true, status: data.status, progress: data.progress, landing: data.landing, summary: data.summary, message: data.message });
}