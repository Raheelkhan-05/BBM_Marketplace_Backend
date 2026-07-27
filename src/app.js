import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth.routes.js";
import sellerRoutes from "./routes/seller.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import notificationRoutes from "./routes/notifications.routes.js";
import shopRoutes from "./routes/shop.routes.js"
import hierarchySearchRoutes from "./routes/hierarchysearch.routes.js";

export function createApp() {
  const app = express();

  app.use(helmet());

  const allowedOrigins = (
    process.env.CLIENT_ORIGINS ||
    "http://localhost:5173"
  )
    .split(",")
    .map(origin => origin.trim());

  app.use(
    cors({
      origin(origin, callback) {
        // Allow non-browser requests (Postman, curl, server-to-server)
        if (!origin) {
          return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        return callback(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
    })
  );

  app.use(express.json());

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRoutes);
  app.use("/api/seller", sellerRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/shop", shopRoutes);
  app.use("/api/search", hierarchySearchRoutes);

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Something went wrong.",
    });
  });

  return app;
}