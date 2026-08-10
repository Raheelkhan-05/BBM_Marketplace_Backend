import crypto from "crypto";

const SECRET = process.env.NOTIFICATION_CHANNEL_SECRET;

if (!SECRET) {
    console.error("[channelToken] NOTIFICATION_CHANNEL_SECRET is not set.");
}

// Deterministic but unguessable per-user channel name. Same userId always
// produces the same token (so both the notifying server and that user's
// own client land on the same channel), but it can't be derived from the
// userId alone without the server secret.
export function channelTokenFor(userId) {
    return crypto.createHmac("sha256", SECRET).update(userId).digest("hex");
}