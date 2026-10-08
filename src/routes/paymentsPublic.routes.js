// src/routes/paymentsPublic.routes.js
//
// The two endpoints JioPay calls. Mounted at the app ROOT and BEFORE the CORS middleware:
//   - the browser return is a cross-site form POST that carries an Origin header, which the
//     app's CORS allow-list would otherwise reject;
//   - the webhook is server-to-server and must not depend on browser CORS rules.
// Authenticity of the webhook comes from the HMAC secureHash (and optionally JIOPAY_WEBHOOK_IPS),
// not from cookies/JWT, so there is nothing for CSRF to abuse.
//
// Give JioPay:
//   Callback (S2S):  https://bbm-marketplace-backend.onrender.com/api/payments/jiopay/webhook
//   Return URL:      https://bbm-marketplace-backend.onrender.com/pay/return
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { jiopayWebhook, payReturn } from "../controllers/payments.controller.js";

const router = Router();

const limiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
const parsers = [express.json({ limit: "100kb" }), express.urlencoded({ extended: false, limit: "100kb" })];

router.post("/api/payments/jiopay/webhook", limiter, ...parsers, jiopayWebhook);
router.all("/pay/return", limiter, ...parsers, payReturn);

export default router;