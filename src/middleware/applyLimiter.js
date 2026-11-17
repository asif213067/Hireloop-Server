import rateLimit from "express-rate-limit";

// Applying: 20 applications per hour per signed-in seeker
export const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});
