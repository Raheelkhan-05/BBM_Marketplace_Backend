// src/middleware/rateLimiter.js
//
// In-memory limiter is fine for a single Express instance. If you scale
// to multiple instances, swap the store for `rate-limit-redis` so limits
// are shared across processes — the API stays identical.

import rateLimit from "express-rate-limit";

export const authWriteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20, // generous — this guards /register and /business, not OTP (Supabase already rate-limits OTP itself)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again shortly." },
});

// src/middleware/rateLimiter.js — add alongside authWriteLimiter
export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again shortly." },
});