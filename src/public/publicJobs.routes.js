import { Router } from "express";
import { z } from "zod";

import { isObjectId, jobs, toObjectId, users } from "../db.js";
import { publicLimiter } from "../middleware/publicLimiter.js";

const publicJobsRouter = Router();

// No login on these routes: only IP rate limiting
publicJobsRouter.use(publicLimiter);

const JOB_TYPES = ["full-time", "part-time", "contract", "internship"];
const PAGE_SIZE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// Query string rules; unknown params (like utm_source) are ignored
const searchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  location: z.string().trim().max(100).optional(),
  type: z.string().max(100).optional(),
  remote: z.enum(["true", "false"]).optional(),
  posted: z.enum(["any", "1", "7", "14", "30", "older"]).default("any"),
  sort: z.enum(["recent", "closing", "match"]).default("recent"),
  page: z.coerce.number().int().min(1).max(200).default(1),
});

// Midnight UTC today: deadlines are stored at UTC midnight
function startOfTodayUtc() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
}

// Treat user text as plain text inside a regex
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// createdAt rule for the "Date posted" filter; $type skips jobs with broken dates
function postedFilter(posted) {
  if (posted === "any") return { $type: "date" };
  if (posted === "older")
    return { $type: "date", $lt: new Date(Date.now() - 30 * DAY_MS) };
  return {
    $type: "date",
    $gte: new Date(Date.now() - Number(posted) * DAY_MS),
  };
}

// Public shape of a job: no recruiterId, no internal fields
function toPublicJob(doc) {
  return {
    id: doc._id.toString(),
    title: doc.title,
    companyName: doc.companyName,
    category: doc.category,
    jobType: doc.jobType,
    isRemote: doc.isRemote,
    location: doc.location ?? null,
    deadline: doc.deadline.toISOString(),
    salaryMin: doc.salaryMin ?? null,
    salaryMax: doc.salaryMax ?? null,
    salaryFrequency: doc.salaryFrequency ?? null,
    createdAt: doc.createdAt.toISOString(),
  };
}

// Search, filter, sort and paginate the open jobs
async function listPublicJobs(req, res) {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid search" });
  }
  const query = parsed.data;

  // Only open jobs are public
  const baseFilter = {
    status: "published",
    deadline: { $gte: startOfTodayUtc() },
  };

  if (query.q) baseFilter.$text = { $search: query.q };
  if (query.location) {
    baseFilter.location = {
      $regex: escapeRegex(query.location),
      $options: "i",
    };
  }
  if (query.remote === "true") baseFilter.isRemote = true;

  // Always filter createdAt so jobs with broken dates stay invisible
  baseFilter.createdAt = postedFilter(query.posted);

  // Job type counts ignore the type filter itself, so each box shows what picking it would give
  const rows = await jobs
    .aggregate([
      { $match: baseFilter },
      { $group: { _id: "$jobType", count: { $sum: 1 } } },
    ])
    .toArray();

  const typeCounts = Object.fromEntries(JOB_TYPES.map((type) => [type, 0]));
  for (const row of rows) {
    if (Object.hasOwn(typeCounts, row._id)) typeCounts[row._id] = row.count;
  }

  // Unknown type values are ignored
  const types = (query.type ?? "")
    .split(",")
    .filter((type) => JOB_TYPES.includes(type));
  const filter =
    types.length > 0 ? { ...baseFilter, jobType: { $in: types } } : baseFilter;

  // Total from the counts: no second query
  const selectedTypes = types.length > 0 ? types : JOB_TYPES;
  const total = selectedTypes.reduce((sum, type) => sum + typeCounts[type], 0);

  // "Best match" only makes sense with a keyword
  const useScore = Boolean(query.q) && query.sort === "match";
  let sort = { createdAt: -1, _id: -1 };
  if (useScore)
    sort = { score: { $meta: "textScore" }, createdAt: -1, _id: -1 };
  if (query.sort === "closing") sort = { deadline: 1, createdAt: -1, _id: -1 };

  const projection = {
    title: 1,
    companyName: 1,
    category: 1,
    jobType: 1,
    isRemote: 1,
    location: 1,
    deadline: 1,
    salaryMin: 1,
    salaryMax: 1,
    salaryFrequency: 1,
    createdAt: 1,
  };
  if (useScore) projection.score = { $meta: "textScore" };

  const list = await jobs
    .find(filter, { projection })
    .sort(sort)
    .skip((query.page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .toArray();

  res.json({
    jobs: list.map(toPublicJob),
    total,
    page: query.page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
    typeCounts,
  });
}

// One open job with its full text, for the job page
async function getPublicJob(req, res) {
  if (!isObjectId(req.params.id)) {
    return res.status(404).json({ error: "Not found" });
  }

  const job = await jobs.findOne({
    _id: toObjectId(req.params.id),
    status: "published",
    // Skip jobs with broken createdAt dates
    createdAt: { $type: "date" },
    deadline: { $gte: startOfTodayUtc() },
  });
  if (!job) {
    return res.status(404).json({ error: "Not found" });
  }

  const recruiter = job.recruiterId
    ? await users.findOne(
        { _id: job.recruiterId },
        { projection: { company: 1 } },
      )
    : null;

  const rawCompany = recruiter?.company;
  const company =
    rawCompany && typeof rawCompany === "object"
      ? {
          name: typeof rawCompany.name === "string" ? rawCompany.name : "",
          logo: typeof rawCompany.logo === "string" ? rawCompany.logo : "",
          industry:
            typeof rawCompany.industry === "string" ? rawCompany.industry : "",
          size: typeof rawCompany.size === "string" ? rawCompany.size : "",
          location:
            typeof rawCompany.location === "string" ? rawCompany.location : "",
          website:
            typeof rawCompany.website === "string" ? rawCompany.website : "",
          description:
            typeof rawCompany.description === "string"
              ? rawCompany.description
              : "",
        }
      : null;

  res.json({
    job: {
      ...toPublicJob(job),
      responsibilities: job.responsibilities,
      requirements: job.requirements,
      company,
    },
  });
}

const ROLE_SYNONYMS = {
  software: ["developer", "engineer", "frontend", "backend", "full-stack", "fullstack", "web", "swe"],
  engineer: ["developer", "software", "frontend", "backend", "full-stack", "fullstack", "devops"],
  developer: ["engineer", "software", "frontend", "backend", "full-stack", "fullstack", "web"],
  frontend: ["front-end", "react", "next", "typescript", "javascript", "ui"],
  backend: ["back-end", "node", "api", "python", "java", "go", "database"],
  fullstack: ["full-stack", "frontend", "backend", "software", "developer"],
  data: ["analyst", "analytics", "business analyst", "bi", "sql", "science"],
  analyst: ["analytics", "business analyst", "data", "bi", "reporting"],
  analytics: ["analyst", "data", "business analyst", "bi"],
  designer: ["design", "ui", "ux", "product designer", "figma"],
  design: ["designer", "ui", "ux", "product designer", "figma"],
  product: ["product manager", "product management", "pm"],
  marketing: ["growth", "seo", "content", "digital marketing"],
  devops: ["sre", "cloud", "kubernetes", "aws", "infrastructure"],
};

const STOP_WORDS = new Set([
  "senior",
  "junior",
  "lead",
  "mid",
  "level",
  "intern",
  "the",
  "and",
  "for",
  "with",
  "of",
  "in",
  "at",
  "to",
]);

function buildMatchKeywords(headline = "", skills = []) {
  const tokens = new Set();
  const rawParts = [headline, ...skills]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !STOP_WORDS.has(part));

  for (const token of rawParts) {
    tokens.add(token);
    const synonyms = ROLE_SYNONYMS[token];
    if (synonyms) {
      for (const synonym of synonyms) tokens.add(synonym);
    }
  }

  return Array.from(tokens);
}

function summarizeText(text, maxLength = 150) {
  if (typeof text !== "string") return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength).trimEnd()}...`;
}

const latestQuerySchema = z.object({
  headline: z.string().trim().max(120).optional(),
  skills: z.string().trim().max(300).optional(),
});

// Latest 6 open jobs for the landing page, prioritized for seekers with a headline
async function getLatestPublicJobs(req, res) {
  const parsed = latestQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query" });
  }

  const headline = parsed.data.headline ?? "";
  const skills = (parsed.data.skills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const filter = {
    status: "published",
    createdAt: { $type: "date" },
    deadline: { $gte: startOfTodayUtc() },
  };

  const docs = await jobs
    .find(filter, {
      projection: {
        title: 1,
        companyName: 1,
        category: 1,
        jobType: 1,
        isRemote: 1,
        location: 1,
        deadline: 1,
        salaryMin: 1,
        salaryMax: 1,
        salaryFrequency: 1,
        responsibilities: 1,
        requirements: 1,
        createdAt: 1,
      },
    })
    .sort({ createdAt: -1, _id: -1 })
    .limit(60)
    .toArray();

  const toLandingJob = (doc) => ({
    ...toPublicJob(doc),
    summary: summarizeText(doc.responsibilities),
  });

  const allLatest = docs.map(toLandingJob);
  const keywords = headline ? buildMatchKeywords(headline, skills) : [];

  if (keywords.length > 0) {
    const matched = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const haystack = [
        doc.title,
        doc.category,
        doc.requirements,
        doc.responsibilities,
      ]
        .filter((v) => typeof v === "string")
        .join(" ")
        .toLowerCase();

      if (keywords.some((kw) => haystack.includes(kw))) {
        matched.push(allLatest[i]);
      }
    }

    if (matched.length > 0) {
      const selected = matched.slice(0, 6);
      const selectedIds = new Set(selected.map((job) => job.id));
      for (const job of allLatest) {
        if (selected.length >= 6) break;
        if (!selectedIds.has(job.id)) {
          selected.push(job);
          selectedIds.add(job.id);
        }
      }

      return res.json({
        jobs: selected,
        personalized: true,
        matchedCount: matched.length,
      });
    }
  }

  return res.json({
    jobs: allLatest.slice(0, 6),
    personalized: false,
    matchedCount: 0,
  });
}

publicJobsRouter.get("/", listPublicJobs);
publicJobsRouter.get("/latest", getLatestPublicJobs);
publicJobsRouter.get("/:id", getPublicJob);

export { publicJobsRouter };
