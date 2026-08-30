import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth.routes.js";
import sellerRoutes from "./routes/seller.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import notificationRoutes from "./routes/notifications.routes.js";
import shopRoutes from "./routes/shop.routes.js";
import hierarchySearchRoutes from "./routes/hierarchysearch.routes.js";
import catalogLandingRoutes from "./routes/catalogLanding.routes.js";
import catalogImportRoutes from "./routes/catalogImport.routes.js";
import whatsappRoutes from "./routes/whatsapp.routes.js";
import sellerCatalogListingsRouter from "./routes/sellerCatalogListings.routes.js";
import adminSellerSubmissionsRouter from "./routes/adminSellerSubmissions.routes.js";
import catalogSearchRoutes from "./routes/catalogSearch.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import sellerOrdersRoutes from "./routes/sellerOrders.routes.js";
import buyerAddressRoutes from "./routes/buyerAddresses.routes.js";
import catalogRoutes from "./routes/catalog.routes.js";
import geoRoutes from "./routes/geo.routes.js";
import listingPolicyOptionsRoutes from "./routes/listingPolicyOptions.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import creditRoutes from "./routes/credit.routes.js";
import cartRoutes from "./routes/cart.routes.js";
import sellerWalletRoutes from "./routes/wallet.routes.js";
import contactsRoutes from "./routes/contacts.routes.js";

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

  app.use(express.json({ limit: "6mb" }));

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRoutes);
  app.use("/api/seller/catalog", sellerCatalogListingsRouter);
  app.use("/api/seller/orders", sellerOrdersRoutes);
  app.use("/api/seller/wallet", sellerWalletRoutes);
  app.use("/api/admin/seller-submissions", adminSellerSubmissionsRouter);
  app.use("/api/seller", sellerRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/shop", shopRoutes);
  app.use("/api/search", hierarchySearchRoutes);
  app.use("/api/catalog-search", catalogSearchRoutes);
  // app.use("/api/catalog", catalogLandingRoutes);
  app.use("/api/catalogs", catalogImportRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/whatsapp", whatsappRoutes);
  app.use("/api/orders", ordersRoutes);
  app.use("/api/buyer/addresses", buyerAddressRoutes);
  app.use("/api/catalog", catalogRoutes);
  app.use("/api/geo", geoRoutes);
  app.use("/api/contacts", contactsRoutes);
  app.use("/api/listing-policy-options", listingPolicyOptionsRoutes);
  app.use("/api/credit", creditRoutes);
  app.use("/api/cart", cartRoutes);


  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Something went wrong.",
    });
  });

  return app;
}