// scripts/load-pincode-geo.js
import fs from "fs";
import readline from "readline";



import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://xbkqwpeuoruijrwxvqga.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhia3F3cGV1b3J1aWpyd3h2cWdhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDYwMjQ2MSwiZXhwIjoyMTAwMTc4NDYxfQ.xx4X7cpdP98Qzc3ljASZtXFhnSTHRFyya-LehU9OdLU";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
        "[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing — set them in .env"
    );
}

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});



async function loadPincodeGeo() {
    const fileStream = fs.createReadStream("./IN.txt");
    const rl = readline.createInterface({ input: fileStream });

    const seen = new Map(); // pincode -> {lat, lng, state, district}
    for await (const line of rl) {
        const cols = line.split("\t");
        if (cols.length < 11) continue;
        const [, pincode, , state, , district, , , , lat, lng] = cols;
        if (!pincode || !lat || !lng) continue;
        // First occurrence wins — good enough for centroid purposes;
        // multiple localities sharing a PIN are geographically close anyway.
        if (!seen.has(pincode)) {
            seen.set(pincode, { pincode, lat: Number(lat), lng: Number(lng), state, district });
        }
    }

    const rows = Array.from(seen.values());
    console.log(`Parsed ${rows.length} unique pincodes`);

    // Batch upsert — Supabase/Postgres chokes on huge single inserts
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await supabase.from("pincode_geo").upsert(batch, { onConflict: "pincode" });
        if (error) {
            console.error(`Batch ${i / BATCH} failed:`, error.message);
            process.exit(1);
        }
        console.log(`Loaded ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }

    console.log("Done.");
}

loadPincodeGeo();