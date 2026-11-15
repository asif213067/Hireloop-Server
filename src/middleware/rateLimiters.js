import rateLimit from "express-rate-limit";

// Shared response for every throttled request
function tooMany(req, res) {
  res.status(429).json({ error: "Too many requests" });
}

// Global: 100 requests per 15 minutes per IP
export const globalLimiter = rateLimit({
  limit: 100,
  windowMs: 15 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
});

// Per user: 10 job creations per hour; runs after requireAuth so req.user.id exists
export const perUserJobLimiter = rateLimit({
  limit: 10,
  windowMs: 60 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  handler: tooMany,
});

// Per user: 60 job updates/deletes per hour; runs after requireAuth so req.user.id exists
export const perUserJobMutationLimiter = rateLimit({
  limit: 60,
  windowMs: 60 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  handler: tooMany,
});
