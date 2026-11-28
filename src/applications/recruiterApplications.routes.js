import { Router } from "express";
import { z } from "zod";

import { applications, isObjectId, jobs, toObjectId, users } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const recruiterApplicationsRouter = Router();

// Recruiters only; requireAuth reads the role from the database
recruiterApplicationsRouter.use(requireAuth, requireRole("recruiter"));

const RECRUITER_SETTABLE_STATUSES = [
  "applied",
  "reviewing",
  "shortlisted",
  "interview",
  "offered",
  "rejected",
];

const PAGE_SIZE = 10;

const listQuerySchema = z.object({
  jobId: z.string().optional(),
  status: z
    .enum(["all", ...RECRUITER_SETTABLE_STATUSES, "withdrawn"])
    .default("all"),
  page: z.coerce.number().int().min(1).max(200).default(1),
});

const statusUpdateSchema = z
  .object({
    status: z.enum(RECRUITER_SETTABLE_STATUSES),
  })
  .strict();

function requireJsonContentType(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("application/json")) {
    return res.status(415).json({ error: "Unsupported media type" });
  }
  next();
}

// List applications for the recruiter's own posted jobs
async function listRecruiterApplications(req, res) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const { jobId, status, page } = parsed.data;
  const recruiterId = toObjectId(req.user.id);

  const recruiterJobs = await jobs
    .find(
      { recruiterId },
      { projection: { title: 1, companyName: 1, createdAt: 1 } }
    )
    .sort({ createdAt: -1 })
    .toArray();

  const jobOptions = recruiterJobs.map((job) => ({
    id: job._id.toString(),
    title: job.title,
    companyName: job.companyName,
  }));

  if (recruiterJobs.length === 0) {
    return res.json({
      applications: [],
      jobs: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
      totalPages: 1,
      stats: {
        total: 0,
        reviewing: 0,
        shortlisted: 0,
        interview: 0,
        offered: 0,
      },
    });
  }

  let targetJobIds = recruiterJobs.map((j) => j._id);
  if (jobId && jobId !== "all") {
    if (!isObjectId(jobId)) {
      return res.status(400).json({ error: "Invalid job id" });
    }
    const ownsJob = recruiterJobs.some((j) => j._id.toString() === jobId);
    if (!ownsJob) {
      return res.status(404).json({ error: "Not found" });
    }
    targetJobIds = [toObjectId(jobId)];
  }

  const baseMatch = { jobId: { $in: targetJobIds } };

  // Aggregate status counts for summary stats across the selected job scope
  const statusCounts = await applications
    .aggregate([
      { $match: baseMatch },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();

  const byStatus = Object.fromEntries(
    statusCounts.map((row) => [row._id, row.count])
  );
  const totalAll = statusCounts.reduce((sum, row) => sum + row.count, 0);

  const filter =
    status === "all" ? baseMatch : { ...baseMatch, status };

  const total =
    status === "all" ? totalAll : (byStatus[status] ?? 0);

  const list = await applications
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .toArray();

  // Batch-load applicant profile fields
  const applicantIds = [
    ...new Set(list.map((app) => app.applicantId?.toString()).filter(Boolean)),
  ].map((id) => toObjectId(id));

  const applicantDocs =
    applicantIds.length > 0
      ? await users
          .find(
            { _id: { $in: applicantIds } },
            { projection: { name: 1, email: 1, image: 1 } }
          )
          .toArray()
      : [];

  const applicantMap = new Map(
    applicantDocs.map((u) => [
      u._id.toString(),
      {
        name: u.name || "Candidate",
        email: u.email || "",
        image: u.image || null,
      },
    ])
  );

  res.json({
    applications: list.map((doc) => {
      const applicant = applicantMap.get(doc.applicantId?.toString()) || {
        name: "Candidate",
        email: "",
        image: null,
      };
      return {
        id: doc._id.toString(),
        jobId: doc.jobId.toString(),
        applicantId: doc.applicantId.toString(),
        applicantName: applicant.name,
        applicantEmail: applicant.email,
        applicantImage: applicant.image,
        status: doc.status,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: (doc.updatedAt || doc.createdAt).toISOString(),
        jobTitle: doc.jobTitle,
        companyName: doc.companyName,
        jobType: doc.jobType,
        isRemote: Boolean(doc.isRemote),
        location: doc.location ?? null,
      };
    }),
    jobs: jobOptions,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    stats: {
      total: totalAll,
      reviewing: byStatus.reviewing ?? 0,
      shortlisted: byStatus.shortlisted ?? 0,
      interview: byStatus.interview ?? 0,
      offered: byStatus.offered ?? 0,
    },
  });
}

// Update an application's hiring status (recruiter must own the job)
async function updateApplicationStatus(req, res) {
  if (!isObjectId(req.params.id)) {
    return res.status(404).json({ error: "Not found" });
  }

  const parsed = statusUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const appId = toObjectId(req.params.id);
  const application = await applications.findOne({ _id: appId });
  if (!application) {
    return res.status(404).json({ error: "Not found" });
  }

  // Verify the recruiter owns the job this application belongs to
  const job = await jobs.findOne(
    { _id: application.jobId, recruiterId: toObjectId(req.user.id) },
    { projection: { _id: 1 } }
  );
  if (!job) {
    return res.status(404).json({ error: "Not found" });
  }

  if (application.status === "withdrawn") {
    return res.status(409).json({
      error: "Candidate has withdrawn this application",
    });
  }

  const now = new Date();
  await applications.updateOne(
    { _id: appId },
    { $set: { status: parsed.data.status, updatedAt: now } }
  );

  res.json({
    application: {
      id: appId.toString(),
      status: parsed.data.status,
      updatedAt: now.toISOString(),
    },
  });
}

function startOfTodayUtc() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
}

function computeExperienceYears(experienceList) {
  if (!Array.isArray(experienceList) || experienceList.length === 0) {
    return null;
  }
  let totalMonths = 0;
  const now = new Date();

  for (const item of experienceList) {
    if (!item?.startDate) continue;
    const start = new Date(`${item.startDate}-01T00:00:00Z`);
    if (Number.isNaN(start.getTime())) continue;

    const end = item.currentlyWorking
      ? now
      : item.endDate
        ? new Date(`${item.endDate}-01T00:00:00Z`)
        : now;
    if (Number.isNaN(end.getTime()) || end <= start) continue;

    const months =
      (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      (end.getUTCMonth() - start.getUTCMonth());
    totalMonths += Math.max(0, months);
  }

  if (totalMonths <= 0) return null;
  const years = Math.round(totalMonths / 12);
  return years >= 1 ? `${years} ${years === 1 ? "year" : "years"}` : "< 1 year";
}

// Overview metrics and latest 5 applications for the recruiter dashboard
async function getRecruiterSummary(req, res) {
  const recruiterId = toObjectId(req.user.id);
  const todayUtc = startOfTodayUtc();

  const recruiterJobs = await jobs
    .find(
      { recruiterId },
      { projection: { status: 1, deadline: 1 } }
    )
    .toArray();

  const totalJobPosts = recruiterJobs.length;
  const activeJobs = recruiterJobs.filter(
    (job) =>
      job.status === "published" &&
      job.deadline instanceof Date &&
      job.deadline.getTime() >= todayUtc.getTime()
  ).length;
  const closedJobs = Math.max(0, totalJobPosts - activeJobs);

  if (totalJobPosts === 0) {
    return res.json({
      stats: {
        totalJobPosts: 0,
        totalApplicants: 0,
        activeJobs: 0,
        closedJobs: 0,
      },
      recent: [],
    });
  }

  const jobIds = recruiterJobs.map((j) => j._id);
  const totalApplicants = await applications.countDocuments({
    jobId: { $in: jobIds },
  });

  const recentDocs = await applications
    .find({ jobId: { $in: jobIds } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(5)
    .toArray();

  const applicantIds = [
    ...new Set(
      recentDocs.map((doc) => doc.applicantId?.toString()).filter(Boolean)
    ),
  ].map((id) => toObjectId(id));

  const applicantDocs =
    applicantIds.length > 0
      ? await users
          .find(
            { _id: { $in: applicantIds } },
            { projection: { name: 1, image: 1, "profile.experience": 1 } }
          )
          .toArray()
      : [];

  const applicantMap = new Map(
    applicantDocs.map((u) => [
      u._id.toString(),
      {
        name: u.name || "Candidate",
        image: u.image || null,
        experience: computeExperienceYears(u.profile?.experience),
      },
    ])
  );

  res.json({
    stats: {
      totalJobPosts,
      totalApplicants,
      activeJobs,
      closedJobs,
    },
    recent: recentDocs.map((doc) => {
      const applicant = applicantMap.get(doc.applicantId?.toString()) || {
        name: "Candidate",
        image: null,
        experience: null,
      };
      return {
        id: doc._id.toString(),
        jobId: doc.jobId.toString(),
        applicantId: doc.applicantId.toString(),
        applicantName: applicant.name,
        applicantImage: applicant.image,
        jobTitle: doc.jobTitle,
        jobType: doc.jobType,
        experience: applicant.experience,
        status: doc.status,
        createdAt: doc.createdAt.toISOString(),
      };
    }),
  });
}

recruiterApplicationsRouter.get("/summary", getRecruiterSummary);
recruiterApplicationsRouter.get("/", listRecruiterApplications);
recruiterApplicationsRouter.patch(
  "/:id/status",
  requireJsonContentType,
  updateApplicationStatus
);

export { recruiterApplicationsRouter };
