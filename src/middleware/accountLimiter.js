import rateLimit from "express-rate-limit";

// Role changes: 10 per hour per signed-in user
export const accountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});
