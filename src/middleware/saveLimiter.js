import rateLimit from "express-rate-limit";

// Saving: 60 save/unsave requests per hour per signed-in seeker
export const saveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  keyGenerator: (req) => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});
