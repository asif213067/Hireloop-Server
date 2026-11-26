import { Router } from "express";

import { isObjectId, toObjectId, users } from "../db.js";
import { publicLimiter } from "../middleware/publicLimiter.js";

const publicProfilesRouter = Router();

// Public profile endpoint: IP rate-limited, safe public fields only
publicProfilesRouter.use(publicLimiter);

async function getPublicSeekerProfile(req, res) {
  if (!isObjectId(req.params.id)) {
    return res.status(404).json({ error: "Not found" });
  }

  const userDoc = await users.findOne(
    { _id: toObjectId(req.params.id) },
    {
      projection: {
        name: 1,
        image: 1,
        role: 1,
        city: 1,
        country: 1,
        profile: 1,
        resume: 1,
      },
    }
  );

  // Only seekers (or accounts without an assigned non-seeker role) have public candidate profiles
  if (!userDoc || (userDoc.role && userDoc.role !== "seeker")) {
    return res.status(404).json({ error: "Not found" });
  }

  const prof = userDoc.profile || {};
  const resumeUrl =
    typeof userDoc.resume?.url === "string" && userDoc.resume.url.trim() !== ""
      ? userDoc.resume.url.trim()
      : null;

  res.json({
    profile: {
      id: userDoc._id.toString(),
      name: userDoc.name || "Candidate",
      image: userDoc.image || null,
      city: userDoc.city || "",
      country: userDoc.country || "",
      headline: prof.headline || "",
      bio: prof.bio || "",
      skills: Array.isArray(prof.skills) ? prof.skills : [],
      experience: Array.isArray(prof.experience) ? prof.experience : [],
      education: Array.isArray(prof.education) ? prof.education : [],
      projects: Array.isArray(prof.projects) ? prof.projects : [],
      links: {
        portfolioUrl: prof.links?.portfolioUrl || "",
        linkedinUrl: prof.links?.linkedinUrl || "",
        githubUrl: prof.links?.githubUrl || "",
        otherUrl: prof.links?.otherUrl || "",
      },
      resume: resumeUrl
        ? {
            url: resumeUrl,
            fileName: userDoc.resume?.fileName || "Resume.pdf",
          }
        : null,
    },
  });
}

publicProfilesRouter.get("/:id", getPublicSeekerProfile);

export { publicProfilesRouter };
