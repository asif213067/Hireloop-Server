import { createRemoteJWKSet, jwtVerify } from "jose";

import { env } from "../env.js";
import { isObjectId, toObjectId, users } from "../db.js";

// Public keys are served by Better Auth's JWT plugin at /api/auth/jwks
const jwks = createRemoteJWKSet(new URL(env.jwksUrl));

// Verifies the Bearer JWT and loads the user; role always comes from the DB
export async function requireAuth(req, res, next) {
  // Missing or malformed Authorization header
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: env.betterAuthUrl,
      audience: env.betterAuthUrl,
      // Better Auth's default key config signs with EdDSA (Ed25519)
      algorithms: ["EdDSA"],
      clockTolerance: 5,
    }));
  } catch (err) {
    // Log only the error name/code; never the token or Authorization header
    console.warn(`JWT verification failed: ${err?.name || "Error"}${err?.code ? ` (${err.code})` : ""}`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  // sub holds the user id as a 24-char hex string
  if (typeof payload.sub !== "string" || !isObjectId(payload.sub)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const user = await users.findOne(
    { _id: toObjectId(payload.sub) },
    { projection: { name: 1, email: 1, role: 1 } }
  );
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Only exact known roles keep their power; anything else is a seeker
  const role = ["seeker", "recruiter", "admin"].includes(user.role) ? user.role : "seeker";
  req.user = { id: user._id.toString(), role, name: user.name, email: user.email };
  next();
}
