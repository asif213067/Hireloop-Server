import "dotenv/config";

// Fail fast: required env keys
const REQUIRED_KEYS = ["MONGODB_CLIENT", "MONGODB_NAME", "BETTER_AUTH_URL", "CLIENT_URL", "PORT"];

const missing = REQUIRED_KEYS.filter(
  (key) => !process.env[key] || process.env[key].trim() === ""
);

if (missing.length > 0) {
  throw new Error(`Missing required env vars: ${missing.join(", ")}`);
}

// Port must be a plain integer
if (!/^\d+$/.test(process.env.PORT)) {
  throw new Error("PORT must be an integer");
}

// Comma-separated CORS allowlist origins
const clientOrigins = process.env.CLIENT_URL.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (clientOrigins.length === 0) {
  throw new Error("CLIENT_URL must contain at least one origin");
}

// Proxy trust is opt-in (default: off)
function parseTrustProxy(raw) {
  const value = (raw || "").trim();
  if (!value) return undefined;
  if (value === "true" || value === "1") return true;
  if (/^\d+$/.test(value)) return Number(value);
  if (["loopback", "linklocal", "uniquelocal"].includes(value)) return value;
  throw new Error("Invalid TRUST_PROXY (use true, 1, a hop count, loopback, linklocal or uniquelocal)");
}

export const env = {
  mongoUri: process.env.MONGODB_CLIENT,
  dbName: process.env.MONGODB_NAME,
  // Kept exactly as configured; Better Auth signs iss/aud from this same raw string
  betterAuthUrl: process.env.BETTER_AUTH_URL,
  // Better Auth JWT plugin default JWKS path: /jwks under its /api/auth base path
  jwksUrl: `${process.env.BETTER_AUTH_URL.replace(/\/+$/, "")}/api/auth/jwks`,
  clientOrigins,
  port: Number(process.env.PORT),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};
