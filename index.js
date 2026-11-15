import express from "express";
import cors from "cors";
import helmet from "helmet";
import "dotenv/config";

import { env } from "./src/env.js";
import { connectToMongoDB, ensureJobIndexes, users } from "./src/db.js";
import { requireAuth } from "./src/middleware/requireAuth.js";
import { requireRole } from "./src/middleware/requireRole.js";
import { globalLimiter } from "./src/middleware/rateLimiters.js";
import { jobsRouter } from "./src/jobs/jobs.routes.js";

const app = express();
const port = env.port;

// Fingerprint off
app.disable("x-powered-by");

// Proxy trust is opt-in; must be set before routes and limiters
if (env.trustProxy !== undefined) {
  app.set("trust proxy", env.trustProxy);
}

// Security headers
app.use(helmet());

// CORS allowlist from CLIENT_URL; no wildcard, no credentials
app.use(
  cors({
    origin: env.clientOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
  })
);

// Small JSON bodies only
app.use(express.json({ limit: "20kb" }));

// Global limit: 100 requests per 15 minutes per IP
app.use(globalLimiter);

// MongoDB setup
await connectToMongoDB();
await ensureJobIndexes();

app.get("/", (req, res) => {
  res.send("Hello Asif Khan!");
});

// Admin-only: returns full user documents (names, emails, roles)
app.get("/users", requireAuth, requireRole("admin"), async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});

// /api/jobs order: global limiter -> requireAuth -> requireRole("recruiter")
// -> per-route limiter -> 415 check -> zod validation -> handler (see jobs.routes.js)
app.use("/api/jobs", jobsRouter);

// JSON 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler: generic messages, no stacks in production
app.use((err, req, res, next) => {
  // Malformed JSON or an oversized body is a client error
  if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    return res.status(400).json({ error: "Invalid request body" });
  }
  if (res.headersSent) return next(err);
  console.error(`${err?.name || "Error"}: ${err?.message}`);
  res.status(500).json({ error: "Something went wrong" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
