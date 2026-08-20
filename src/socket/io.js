// socket/io.js
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

let ioInstance = null;

export function setIO(io) { ioInstance = io; }
export function getIO() {
    if (!ioInstance) throw new Error("Socket.IO not initialized yet");
    return ioInstance;
}

// Only actually needed once you run >1 server process/replica — but wire
// it up now so scaling later doesn't silently reintroduce "emits vanish"
// bugs. No REDIS_URL set -> falls back to the default in-memory adapter,
// safe for a single instance.
export async function attachRedisAdapter(io) {
    if (!process.env.REDIS_URL) {
        console.log("[socket] REDIS_URL not set, using in-memory adapter (single instance only)");
        return;
    }
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log("[socket] Redis adapter attached");
}