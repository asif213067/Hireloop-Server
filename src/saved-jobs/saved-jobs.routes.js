import { Router } from "express";
import { z } from "zod";

import { applications, isObjectId, jobs, savedJobs, toObjectId } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { saveLimiter } from "../middleware/saveLimiter.js";

const savedJobsRouter = Router();

// Seekers only; requireAuth reads the role from the database
savedJobsRouter.use(requireAuth, requireRole("seeker"));

// Save body: only the job id is accepted
const saveSchema = z.object({ jobId: z.string() }).strict();

// List query: which page
const listSchema = z.object({
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

// Save an open job for reading later
async function saveJob(req, res) {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success || !isObjectId(parsed.data.jobId)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  // Only open jobs can be saved
  const job = await jobs.findOne({
    _id: toObjectId(parsed.data.jobId),
    status: "published",
    deadline: { $gte: startOfTodayUtc() },
  });
  if (!job) {
    return res.status(404).json({ error: "Not found" });
  }

  const document = {
    applicantId: toObjectId(req.user.id),
    jobId: job._id,
    createdAt: new Date(),
  };

  try {
    await savedJobs.insertOne(document);
    res.status(201).json({ saved: true });
  } catch (error) {
    // The unique index (applicantId + jobId) blocks a second save
    if (error.code === 11000) {
      return res.status(409).json({ error: "Already saved" });
    }
    throw error;
  }
}

// Unsave is idempotent: 204 even when nothing was saved
async function unsaveJob(req, res) {
  if (!isObjectId(req.params.jobId)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  await savedJobs.deleteOne({
    applicantId: toObjectId(req.user.id),
    jobId: toObjectId(req.params.jobId),
  });
  res.status(204).send();
}

// The seeker's saved job ids, for the UI's saved-state checks
async function listSavedIds(req, res) {
  const rows = await savedJobs
    .find(
      { applicantId: toObjectId(req.user.id) },
      { projection: { jobId: 1 } },
    )
    .limit(500)
    .toArray();
  res.json({ jobIds: rows.map((row) => row.jobId.toString()) });
}

// The seeker's saved jobs with stats, open ones first, then closed
async function listSavedJobs(req, res) {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const page = parsed.data.page;
  const applicantId = toObjectId(req.user.id);

  // This seeker's saved entries, newest saved first
  const saves = await savedJobs
    .find({ applicantId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(500)
    .toArray();

  // Their jobs in one query, no status or deadline filter; deleted jobs drop out
  const ids = saves.map((save) => save.jobId);
  const rows = await jobs.find({ _id: { $in: ids } }).toArray();
  const jobById = new Map(rows.map((job) => [job._id.toString(), job]));

  // Which of these jobs this seeker already applied to
  const appliedRows = await applications
    .find(
      { applicantId, jobId: { $in: ids } },
      { projection: { jobId: 1 } },
    )
    .toArray();
  const appliedIds = new Set(appliedRows.map((row) => row.jobId.toString()));

  const today = startOfTodayUtc();
  const threeDays = today.getTime() + 3 * 24 * 60 * 60 * 1000;

  // Per-job flags from the saved order
  const kept = saves
    .filter((save) => jobById.has(save.jobId.toString()))
    .map((save) => {
      const job = jobById.get(save.jobId.toString());
      // Applied already for this seeker
      const applied = appliedIds.has(job._id.toString());
      // Closed: unpublished or past its deadline
      const closed = job.status !== "published" || job.deadline < today;
      // Closing soon: open, not applied and due within 3 days
      const closingSoon = !closed && !applied && job.deadline <= new Date(threeDays);
      return {
        id: job._id.toString(),
        title: job.title,
        companyName: job.companyName,
        jobType: job.jobType,
        isRemote: job.isRemote,
        location: job.location ?? null,
        salaryMin: job.salaryMin ?? null,
        salaryMax: job.salaryMax ?? null,
        salaryFrequency: job.salaryFrequency ?? null,
        deadline: job.deadline.toISOString(),
        closed,
        closingSoon,
        applied,
        savedAt: save.createdAt.toISOString(),
      };
    });

  // Open jobs first, then closed; saved order inside each group
  const ordered = [
    ...kept.filter((item) => !item.closed),
    ...kept.filter((item) => item.closed),
  ];

  // Stats cover every kept entry, not only this page
  res.json({
    jobs: ordered.slice((page - 1) * 10, page * 10),
    stats: {
      totalSaved: ordered.length,
      closingSoon: ordered.filter((item) => item.closingSoon).length,
    },
    page,
    pageSize: 10,
    total: ordered.length,
    hasMore: page * 10 < ordered.length,
  });
}

// "/ids" must be declared before "/:jobId"
savedJobsRouter.get("/ids", listSavedIds);
savedJobsRouter.get("/", listSavedJobs);

savedJobsRouter.post("/", saveLimiter, requireJsonContentType, saveJob);
savedJobsRouter.delete("/:jobId", saveLimiter, unsaveJob);

export { savedJobsRouter };
