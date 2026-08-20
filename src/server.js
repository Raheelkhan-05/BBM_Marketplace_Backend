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

const io = new SocketIOServer(httpServer, {
  // Explicit CORS. If CLIENT_ORIGIN is unset this silently blocks every
  // handshake with no client-visible reason other than connect_error —
  // fail loudly at boot instead.
  cors: {
    origin: process.env.CLIENT_ORIGIN?.split(",") || [],
    credentials: true,
  },
  // Allow polling as a fallback transport — some proxies (older Nginx
  // configs, some free-tier PaaS) don't upgrade to raw WebSocket
  // cleanly. Forcing transports: ["websocket"] on the SERVER can make
  // connections fail silently behind such a proxy. Let Socket.IO
  // negotiate; lock transports down on the CLIENT instead, where it's
  // safe (see SocketContext.jsx).
  pingInterval: 20000,
  pingTimeout: 10000,
});

if (!process.env.CLIENT_ORIGIN) {
  console.error("[server] CLIENT_ORIGIN is not set — all socket connections will be CORS-rejected.");
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