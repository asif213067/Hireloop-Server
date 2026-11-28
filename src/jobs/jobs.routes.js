import { Router } from "express";

import {
  applications,
  isObjectId,
  jobs,
  savedJobs,
  toObjectId,
  users,
} from "../db.js";
import { hasCompleteCompanyProfile } from "../account/account.routes.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  perUserJobLimiter,
  perUserJobMutationLimiter,
} from "../middleware/rateLimiters.js";
import { jobSchema } from "./jobs.validation.js";
import {
  checkUsageLimit,
  incrementMonthlyUsage,
} from "../subscription/subscription.utils.js";

const jobsRouter = Router();

// Chain for every /api/jobs route, after the app-level global limiter (index.js):
// requireAuth -> requireRole("recruiter"); per route: limiter -> 415 -> validation -> handler

jobsRouter.use(requireAuth, requireRole("recruiter"));

// POST bodies must be application/json (also used by PUT)
function requireJsonContentType(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("application/json")) {
    return res.status(415).json({ error: "Unsupported media type" });
  }
  next();
}

// 24-character hex or the job cannot exist
function requireValidJobId(req, res, next) {
  if (!isObjectId(req.params.id)) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}

// Zod validation; strict schema rejects unknown keys
function validateJob(req, res, next) {
  // Honeypot: any filled website field is a bot
  const website =
    typeof req.body?.website === "string" ? req.body.website.trim() : undefined;
  if (website) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const body = { ...req.body };
  delete body.website;

  const parsed = jobSchema.safeParse(body);
  if (!parsed.success) {
    const errors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "_";
      if (!(field in errors)) errors[field] = issue.message;
    }
    return res.status(400).json({ errors });
  }

  req.validatedJob = parsed.data;
  next();
}

// One shape for every endpoint; "_id" never leaves the server
function toJobResponse(doc, applicantsCount = 0) {
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
    responsibilities: doc.responsibilities,
    requirements: doc.requirements,
    status: doc.status,
    applicantsCount,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// Own recruiter id, always from the DB-backed req.user
function ownRecruiterId(req) {
  return toObjectId(req.user.id);
}

// The recruiter's own jobs, newest first, with one count query for all of them
async function listMyJobs(req, res) {
  const list = await jobs
    .find({ recruiterId: ownRecruiterId(req) })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  // Applications per job in a single aggregation
  const jobIds = list.map((job) => job._id);
  const counts = await applications
    .aggregate([
      { $match: { jobId: { $in: jobIds } } },
      { $group: { _id: "$jobId", count: { $sum: 1 } } },
    ])
    .toArray();

  // Jobs without applications are not in the result, so they count as 0
  const countByJobId = new Map(
    counts.map((row) => [row._id.toString(), row.count]),
  );

  res.json({
    jobs: list.map((job) =>
      toJobResponse(job, countByJobId.get(job._id.toString()) ?? 0),
    ),
  });
}

async function getJob(req, res) {
  // Ownership in the query: another recruiter's job is a 404 too
  const job = await jobs.findOne({
    _id: toObjectId(req.params.id),
    recruiterId: ownRecruiterId(req),
  });
  if (!job) {
    return res.status(404).json({ error: "Not found" });
  }

  const applicantsCount = await applications.countDocuments({ jobId: job._id });
  res.json({ job: toJobResponse(job, applicantsCount) });
}

// Update only validated fields plus updatedAt
async function updateJob(req, res) {
  const job = req.validatedJob;

  const update = {
    title: job.title,
    companyName: job.companyName,
    category: job.category,
    jobType: job.jobType,
    isRemote: job.isRemote,
    location: job.location ?? null,
    deadline: job.deadline,
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    salaryFrequency: job.salaryFrequency ?? null,
    responsibilities: job.responsibilities,
    requirements: job.requirements,
    updatedAt: new Date(),
  };

  const updated = await jobs.findOneAndUpdate(
    { _id: toObjectId(req.params.id), recruiterId: ownRecruiterId(req) },
    { $set: update },
    { returnDocument: "after" },
  );
  if (!updated) {
    return res.status(404).json({ error: "Not found" });
  }

  const applicantsCount = await applications.countDocuments({
    jobId: updated._id,
  });
  res.json({ job: toJobResponse(updated, applicantsCount) });
}

async function deleteJob(req, res) {
  // Ownership in the query; applications are kept so seekers keep their history
  const result = await jobs.deleteOne({
    _id: toObjectId(req.params.id),
    recruiterId: ownRecruiterId(req),
  });
  if (result.deletedCount === 0) {
    return res.status(404).json({ error: "Not found" });
  }

  // Saved rows for the deleted job are removed too
  await savedJobs.deleteMany({ jobId: toObjectId(req.params.id) });
  res.status(204).send();
}

// Insert only the validated fields; server sets identity, status and timestamps
async function createJob(req, res) {
  // Recruiters must complete required company information before posting jobs
  const recruiterDoc = await users.findOne(
    { _id: ownRecruiterId(req) },
    { projection: { company: 1 } }
  );
  if (!hasCompleteCompanyProfile(recruiterDoc)) {
    return res.status(403).json({
      error: "Company profile required",
      message:
        "Please complete your required company information in Settings before posting a job.",
    });
  }

  // Enforce monthly job posting limit for Free tier recruiters (Pro has unlimited)
  const usageCheck = checkUsageLimit(req.user, "jobPosts");
  if (!usageCheck.allowed) {
    return res.status(403).json({
      error: "Monthly job posting limit reached",
      message: `You have reached the monthly job posting limit of ${usageCheck.limit} jobs on the Free plan. Upgrade to Pro for unlimited job postings.`,
      usage: usageCheck,
    });
  }

  const job = req.validatedJob;
  const now = new Date();

  const document = {
    title: job.title,
    companyName: job.companyName,
    category: job.category,
    jobType: job.jobType,
    isRemote: job.isRemote,
    location: job.location ?? null,
    deadline: job.deadline,
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    salaryFrequency: job.salaryFrequency ?? null,
    responsibilities: job.responsibilities,
    requirements: job.requirements,
    recruiterId: ownRecruiterId(req),
    status: "published",
    createdAt: now,
    updatedAt: now,
  };

  const result = await jobs.insertOne(document);
  // Increment monthly counter atomically
  await incrementMonthlyUsage(req.user.id, "jobPosts");

  // A new job has no applicants yet
  res.status(201).json({
    job: toJobResponse({ ...document, _id: result.insertedId }, 0),
    usage: {
      ...usageCheck,
      count: (usageCheck.count ?? 0) + 1,
      remaining: usageCheck.isPro
        ? null
        : Math.max(0, (usageCheck.remaining ?? 1) - 1),
    },
  });
}

// "/mine" must be declared before "/:id"
jobsRouter.get("/mine", listMyJobs);

jobsRouter.get("/:id", requireValidJobId, getJob);

jobsRouter.put(
  "/:id",
  perUserJobMutationLimiter,
  requireValidJobId,
  requireJsonContentType,
  validateJob,
  updateJob,
);

jobsRouter.delete(
  "/:id",
  perUserJobMutationLimiter,
  requireValidJobId,
  deleteJob,
);

jobsRouter.post(
  "/",
  perUserJobLimiter,
  requireJsonContentType,
  validateJob,
  createJob,
);

export { jobsRouter };
