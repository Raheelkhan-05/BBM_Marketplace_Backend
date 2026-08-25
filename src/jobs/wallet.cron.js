// jobs/wallet.cron.js
import cron from "node-cron";
import { supabase } from "../config/supabase.js";

// Runs daily at 00:10 IST; the RPC itself only acts on the 1st, so daily
// is fine as a cheap idempotent safety net (catches server downtime on the 1st too).
cron.schedule("10 0 * * *", async () => {
    const { error } = await supabase.rpc("wallet_run_monthly_rollover");
    if (error) console.error("wallet_run_monthly_rollover failed:", error.message);
}, { timezone: "Asia/Kolkata" });