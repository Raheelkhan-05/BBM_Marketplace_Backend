// src/server.js
import "dotenv/config";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "./app.js";
import { verifyMailer } from "./config/mailer.js";
import { verifyAuthToken } from "./middleware/auth.middleware.js";
import { registerChatSocket } from "./socket/chatSocket.js";
import { setIO, attachRedisAdapter } from "./socket/io.js";

const PORT = process.env.PORT || 4000;
const app = createApp();
const httpServer = http.createServer(app);

// Was reading CLIENT_ORIGIN (singular) while .env defines CLIENT_ORIGINS
// (plural) — the mismatch meant this was always undefined, so the
// allowed-origins list silently fell back to [], rejecting every
// handshake regardless of where it came from. Also trim each entry:
// a stray space after a comma in the .env value (e.g. "a, b") produces
// an origin string that will never match what the browser actually sends.
const allowedOrigins = (process.env.CLIENT_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  pingInterval: 20000,
  pingTimeout: 10000,
});

if (!allowedOrigins.length) {
  console.error("[server] CLIENT_ORIGINS is not set — all socket connections will be CORS-rejected.");
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const user = verifyAuthToken(token);
    socket.userId = user.id;
    next();
  } catch (err) {
    console.warn("[socket] handshake rejected:", err.message);
    next(new Error("Unauthorized"));
  }
});

async function start() {
  await attachRedisAdapter(io);
  setIO(io);
  registerChatSocket(io);

  httpServer.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] socket.io path: /socket.io`);
    verifyMailer();
  });
}

start();