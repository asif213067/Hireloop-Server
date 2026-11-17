import { Router } from "express";
import { z } from "zod";

import { applications, isObjectId, jobs, toObjectId } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { applyLimiter } from "../middleware/applyLimiter.js";

const applicationsRouter = Router();

// Seekers only; requireAuth reads the role from the database
applicationsRouter.use(requireAuth, requireRole("seeker"));

// Status values: the client uses the same names
const ACTIVE_STATUSES = [
  "applied",
  "reviewing",
  "shortlisted",
  "interview",
  "offered",
];
const ARCHIVED_STATUSES = ["rejected", "withdrawn"];
const PAGE_SIZE = 10;

// Apply body: only the job id, nothing else is accepted
const applySchema = z.object({ jobId: z.string() }).strict();

// List query: which tab and which page
const listSchema = z.object({
  status: z.enum(["active", "archived"]).default("active"),
  page: z.coerce.number().int().min(1).max(200).default(1),
});

// Midnight UTC today: deadlines are stored at UTC midnight
function startOfTodayUtc() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
}

// POST bodies must be application/json
function requireJsonContentType(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("application/json")) {
    return res.status(415).json({ error: "Unsupported media type" });
  }
  next();
}

// Shape sent to the client; the job details are the snapshot saved at apply time
function toApplicationResponse(doc) {
  return {
    id: doc._id.toString(),
    jobId: doc.jobId.toString(),
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    jobTitle: doc.jobTitle,
    companyName: doc.companyName,
    jobType: doc.jobType,
    isRemote: doc.isRemote,
    location: doc.location ?? null,
  };
}

async function applyToJob(req, res) {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success || !isObjectId(parsed.data.jobId)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  // Only open jobs can be applied to
  const job = await jobs.findOne({
    _id: toObjectId(parsed.data.jobId),
    status: "published",
    deadline: { $gte: startOfTodayUtc() },
  });
  if (!job) {
    return res.status(404).json({ error: "Job not available" });
  }

  const now = new Date();
  const document = {
    jobId: job._id,
    applicantId: toObjectId(req.user.id),
    status: "applied",
    createdAt: now,
    updatedAt: now,
    // Snapshot: the seeker's list keeps working if the job is edited or deleted
    jobTitle: job.title,
    companyName: job.companyName,
    jobType: job.jobType,
    isRemote: job.isRemote,
    location: job.location ?? null,
  };

  try {
    const result = await applications.insertOne(document);
    res.status(201).json({
      application: toApplicationResponse({
        ...document,
        _id: result.insertedId,
      }),
    });
  } catch (error) {
    // The unique index (jobId + applicantId) blocks a second application
    if (error.code === 11000) {
      return res.status(409).json({ error: "Already applied" });
    }
    throw error;
  }
}

// The seeker's own applications for one tab, plus the stat card numbers
async function listMyApplications(req, res) {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const { status, page } = parsed.data;
  const applicantId = toObjectId(req.user.id);

  // One group query gives every count (stats and tab total)
  const rows = await applications
    .aggregate([
      { $match: { applicantId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();
  const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const totalApplied = rows.reduce((sum, row) => sum + row.count, 0);

  const tabStatuses =
    status === "archived" ? ARCHIVED_STATUSES : ACTIVE_STATUSES;
  const total = tabStatuses.reduce(
    (sum, name) => sum + (byStatus[name] ?? 0),
    0,
  );

  const list = await applications
    .find({ applicantId, status: { $in: tabStatuses } })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .toArray();

  // Success rate = offers divided by all applications; null when there are none
  const offered = byStatus.offered ?? 0;

  res.json({
    applications: list.map(toApplicationResponse),
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
    stats: {
      totalApplied,
      shortlisted: byStatus.shortlisted ?? 0,
      interviews: byStatus.interview ?? 0,
      successRate:
        totalApplied === 0 ? null : Math.round((offered / totalApplied) * 100),
    },
  });
}

// Has this seeker already applied to this job? Used by the Apply button
async function getApplicationStatus(req, res) {
  if (!isObjectId(req.params.jobId)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const existing = await applications.findOne(
    {
      jobId: toObjectId(req.params.jobId),
      applicantId: toObjectId(req.user.id),
    },
    { projection: { _id: 1 } },
  );
  res.json({ applied: existing !== null });
}

applicationsRouter.get("/mine", listMyApplications);
applicationsRouter.get("/status/:jobId", getApplicationStatus);
applicationsRouter.post("/", applyLimiter, requireJsonContentType, applyToJob);

export { applicationsRouter };
