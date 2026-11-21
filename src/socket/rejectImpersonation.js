// src/socket/rejectImpersonation.js
// Admin "act as user" tokens (those carrying an `ims` claim) never get a live socket:
// no online presence, no delivered/read receipts, no typing events sent in the real user's name.
//
// The claim is only inspected here, not trusted. A forged or stripped claim fails the real
// signature check in the auth middleware that runs right after this one.
export function rejectImpersonationSockets(io) {
    io.use((socket, next) => {
        try {
            const token = socket.handshake?.auth?.token;
            const payloadPart = typeof token === "string" ? token.split(".")[1] : null;
            if (payloadPart) {
                const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
                if (typeof claims?.ims === "string") {
                    return next(new Error("Live updates are off in admin sessions."));
                }
            }
        } catch {
            /* not a decodable token: the normal auth middleware below will reject it */
        }
        next();
    });
}