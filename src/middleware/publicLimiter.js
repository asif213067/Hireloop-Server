import rateLimit from "express-rate-limit";

// Public browsing: 60 requests per minute per IP
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});
