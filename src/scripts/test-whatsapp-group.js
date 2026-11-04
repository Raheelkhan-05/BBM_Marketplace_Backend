// TEMPORARY test script: delete after testing.
//
// Step 1: list groups   -> node --env-file=.env scripts/test-whatsapp-group.js list
// Step 2: send message  -> node --env-file=.env scripts/test-whatsapp-group.js send <group_id>

const BASE_URL = (process.env.DEALSMS_BASE_URL || "https://dealsms.in/api").replace(/\/+$/, "");
const ACCESS_TOKEN = process.env.DEALSMS_ACCESS_TOKEN;
const INSTANCE_ID = process.env.DEALSMS_INSTANCE_ID;

if (!ACCESS_TOKEN || !INSTANCE_ID) {
    console.error("Missing DEALSMS_ACCESS_TOKEN or DEALSMS_INSTANCE_ID in .env");
    process.exit(1);
}

const [, , command, groupId] = process.argv;

async function listGroups() {
    const url = `${BASE_URL}/get_groups?instance_id=${INSTANCE_ID}&access_token=${ACCESS_TOKEN}`;
    const res = await fetch(url, { method: "GET" });
    const text = await res.text();
    console.log("HTTP status:", res.status);
    try {
        console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
        console.log(text);
    }
    console.log("\nLook for your group's name and copy its id (ends with @g.us).");
}

async function sendToGroup(id) {
    if (!id) {
        console.error("Please give the group id. Example: send 1234567890-1618740914@g.us");
        process.exit(1);
    }

    const params = new URLSearchParams({
        group_id: id,
        type: "text",
        message: `Test message from BBM Marketplace (${new Date().toLocaleString("en-IN")})`,
        instance_id: INSTANCE_ID,
        access_token: ACCESS_TOKEN,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
        const res = await fetch(`${BASE_URL}/send_group?${params}`, {
            method: "GET",
            signal: controller.signal,
        });
        const text = await res.text();
        console.log("HTTP status:", res.status);
        console.log(text);
    } catch (error) {
        console.error(
            error.name === "AbortError" ? "Timed out after 30 seconds" : error.message
        );
    } finally {
        clearTimeout(timer);
    }
}

if (command === "list") await listGroups();
else if (command === "send") await sendToGroup(groupId);
else console.log("Usage:\n  list\n  send <group_id>");