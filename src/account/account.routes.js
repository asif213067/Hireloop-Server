import { Router } from "express";
import { z } from "zod";

import { jobs, toObjectId, users } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { accountLimiter } from "../middleware/accountLimiter.js";

const accountRouter = Router();

// Any signed-in user may change their own account type
accountRouter.use(requireAuth);

// Role change body: only the new role is accepted
const roleSchema = z.object({ role: z.enum(["seeker", "recruiter"]) }).strict();

// PUT bodies must be application/json
function requireJsonContentType(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("application/json")) {
    return res.status(415).json({ error: "Unsupported media type" });
  }
  next();
}

// Switch the signed-in user's account type between seeker and recruiter
async function changeRole(req, res) {
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const role = parsed.data.role;

  // Admins never switch account type
  if (req.user.role === "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Same role: nothing to change
  if (role === req.user.role) {
    return res.status(200).json({ role });
  }

  // Recruiters must delete their job posts before leaving the role
  if (req.user.role === "recruiter") {
    const count = await jobs.countDocuments({
      recruiterId: toObjectId(req.user.id),
    });
    if (count > 0) {
      return res.status(409).json({ error: "Has job posts" });
    }
  }

  await users.updateOne(
    { _id: toObjectId(req.user.id) },
    { $set: { role, updatedAt: new Date() } },
  );
  res.status(200).json({ role });
}

accountRouter.put("/role", accountLimiter, requireJsonContentType, changeRole);

export { accountRouter };
