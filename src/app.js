// src/app.js

import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth.routes.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
      credentials: true,
    })
  );
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRoutes);

  // Central error handler — keeps stack traces out of API responses.
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong." });
  });

  return app;
}