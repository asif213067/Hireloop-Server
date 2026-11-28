import { Router } from "express";
import { z } from "zod";

import { jobs, toObjectId, users } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { accountLimiter } from "../middleware/accountLimiter.js";
import { profileMutationLimiter } from "../middleware/rateLimiters.js";

const accountRouter = Router();

// Any signed-in user may manage their own account
accountRouter.use(requireAuth);

// Role change body: only the new role is accepted
const roleSchema = z.object({ role: z.enum(["seeker", "recruiter"]) }).strict();

// Optional http/https URL or empty string
const optionalUrlSchema = z
  .string()
  .trim()
  .max(300)
  .refine(
    (val) => {
      if (val === "") return true;
      try {
        const parsed = new URL(val);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Must be a valid http(s) URL" }
  );

const personalProfileSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be 2 to 80 characters").max(80),
    phone: z.string().trim().max(30).default(""),
    city: z.string().trim().max(80).default(""),
    country: z.string().trim().max(80).default(""),
  })
  .strict();

const experienceEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(60),
    jobTitle: z.string().trim().min(1).max(100),
    company: z.string().trim().min(1).max(100),
    employmentType: z.string().trim().max(40).default("Full-time"),
    location: z.string().trim().max(100).default(""),
    startDate: z.string().trim().max(20).default(""),
    endDate: z.string().trim().max(20).default(""),
    currentlyWorking: z.boolean().default(false),
    description: z.string().trim().max(800).default(""),
  })
  .strict();

const educationEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(60),
    institution: z.string().trim().min(1).max(120),
    degree: z.string().trim().min(1).max(80),
    fieldOfStudy: z.string().trim().max(100).default(""),
    startDate: z.string().trim().max(20).default(""),
    endDate: z.string().trim().max(20).default(""),
    description: z.string().trim().max(600).default(""),
  })
  .strict();

const projectEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(800).default(""),
    technologies: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    url: optionalUrlSchema.default(""),
  })
  .strict();

const languageEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(60),
    proficiency: z.enum(["Native", "Intermediate", "Professional"]),
  })
  .strict();

const professionalProfileSchema = z
  .object({
    headline: z.string().trim().max(120).default(""),
    bio: z.string().trim().max(2000).default(""),
    skills: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
    experience: z.array(experienceEntrySchema).max(30).default([]),
    education: z.array(educationEntrySchema).max(20).default([]),
    projects: z.array(projectEntrySchema).max(20).default([]),
    languages: z.array(languageEntrySchema).max(30).default([]),
    links: z
      .object({
        portfolioUrl: optionalUrlSchema.default(""),
        linkedinUrl: optionalUrlSchema.default(""),
        githubUrl: optionalUrlSchema.default(""),
        otherUrl: optionalUrlSchema.default(""),
      })
      .strict()
      .default({
        portfolioUrl: "",
        linkedinUrl: "",
        githubUrl: "",
        otherUrl: "",
      }),
  })
  .strict();

const companyProfileSchema = z
  .object({
    name: z.string().trim().min(2, "Company name is required").max(120),
    logo: optionalUrlSchema.default(""),
    industry: z.string().trim().min(1, "Industry is required").max(80),
    size: z.string().trim().min(1, "Company size is required").max(40),
    location: z.string().trim().min(2, "Company location is required").max(120),
    website: optionalUrlSchema.default(""),
    description: z.string().trim().max(2000).default(""),
  })
  .strict();

export function hasCompleteCompanyProfile(userDoc) {
  const company = userDoc?.company;
  if (!company) return false;
  return Boolean(
    typeof company.name === "string" &&
      company.name.trim().length >= 2 &&
      typeof company.industry === "string" &&
      company.industry.trim().length >= 1 &&
      typeof company.size === "string" &&
      company.size.trim().length >= 1 &&
      typeof company.location === "string" &&
      company.location.trim().length >= 2
  );
}

// JSON bodies must be application/json
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

// Fetch authenticated user's profile (personal + professional fields only)
async function getProfile(req, res) {
  const userDoc = await users.findOne(
    { _id: toObjectId(req.user.id) },
    {
      projection: {
        name: 1,
        email: 1,
        image: 1,
        phone: 1,
        city: 1,
        country: 1,
        profile: 1,
        company: 1,
      },
    }
  );

  if (!userDoc) {
    return res.status(404).json({ error: "User not found" });
  }

  const prof = userDoc.profile || {};
  const comp = userDoc.company || {};
  res.json({
    profile: {
      name: userDoc.name || "",
      email: userDoc.email || "",
      image: userDoc.image || null,
      phone: userDoc.phone || "",
      city: userDoc.city || "",
      country: userDoc.country || "",
      headline: prof.headline || "",
      bio: prof.bio || "",
      skills: Array.isArray(prof.skills) ? prof.skills : [],
      experience: Array.isArray(prof.experience) ? prof.experience : [],
      education: Array.isArray(prof.education) ? prof.education : [],
      projects: Array.isArray(prof.projects) ? prof.projects : [],
      languages: Array.isArray(prof.languages) ? prof.languages : [],
      links: {
        portfolioUrl: prof.links?.portfolioUrl || "",
        linkedinUrl: prof.links?.linkedinUrl || "",
        githubUrl: prof.links?.githubUrl || "",
        otherUrl: prof.links?.otherUrl || "",
      },
      company: {
        name: comp.name || "",
        logo: comp.logo || "",
        industry: comp.industry || "",
        size: comp.size || "",
        location: comp.location || "",
        website: comp.website || "",
        description: comp.description || "",
      },
    },
  });
}

// Update authenticated user's personal information (email, role, subscription untouched)
async function updatePersonalProfile(req, res) {
  const parsed = personalProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message || "Invalid personal details";
    return res.status(400).json({ error: message });
  }

  const { name, phone, city, country } = parsed.data;

  await users.updateOne(
    { _id: toObjectId(req.user.id) },
    {
      $set: {
        name,
        phone,
        city,
        country,
        updatedAt: new Date(),
      },
    }
  );

  res.json({
    personal: { name, phone, city, country },
  });
}

// Update authenticated user's professional details
async function updateProfessionalProfile(req, res) {
  const parsed = professionalProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.message || "Invalid professional details";
    return res.status(400).json({ error: message });
  }

  await users.updateOne(
    { _id: toObjectId(req.user.id) },
    {
      $set: {
        profile: parsed.data,
        updatedAt: new Date(),
      },
    }
  );

  res.json({
    professional: parsed.data,
  });
}

// Update authenticated recruiter's company profile
async function updateCompanyProfile(req, res) {
  if (req.user.role !== "recruiter") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parsed = companyProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.message || "Invalid company details";
    return res.status(400).json({ error: message });
  }

  await users.updateOne(
    { _id: toObjectId(req.user.id) },
    {
      $set: {
        company: parsed.data,
        updatedAt: new Date(),
      },
    }
  );

  res.json({
    company: parsed.data,
  });
}

accountRouter.put("/role", accountLimiter, requireJsonContentType, changeRole);
accountRouter.get("/profile", getProfile);
accountRouter.put(
  "/profile/personal",
  profileMutationLimiter,
  requireJsonContentType,
  updatePersonalProfile
);
accountRouter.put(
  "/profile/professional",
  profileMutationLimiter,
  requireJsonContentType,
  updateProfessionalProfile
);
accountRouter.put(
  "/profile/company",
  profileMutationLimiter,
  requireJsonContentType,
  updateCompanyProfile
);

export { accountRouter };
