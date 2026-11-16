import { z } from "zod";

// Keep identical to the client allowlists
export const ALLOWED_CATEGORIES = [
  "Engineering & Tech",
  "Design",
  "Product",
  "Product Management",
  "Marketing",
  "Sales",
  "Data & Analytics",
  "Customer Support",
  "Finance",
  "Human Resources",
  "Operations",
  "Other",
];

export const ALLOWED_JOB_TYPES = ["full-time", "part-time", "contract", "internship"];

export const ALLOWED_SALARY_FREQUENCIES = ["hour", "day", "week", "month", "year"];

// "YYYY-MM-DD" -> Date at UTC midnight, after real-date and recency checks
const deadlineSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Deadline must be a date (YYYY-MM-DD)")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "Deadline must be a real calendar date")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const now = new Date();
    const yesterdayUtcMidnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 1
    );
    return Date.UTC(year, month - 1, day) >= yesterdayUtcMidnight;
  }, "Deadline can't be earlier than yesterday")
  .transform((value) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  });

const salarySchema = z
  .number()
  .finite()
  .min(0, "Salary must be at least 0")
  .max(10_000_000, "Salary must be at most 10000000");

export const jobSchema = z
  .strictObject({
    title: z.string().trim().min(3, "Title must be 3-120 characters").max(120, "Title must be 3-120 characters"),
    companyName: z
      .string()
      .trim()
      .min(2, "Company name must be 2-120 characters")
      .max(120, "Company name must be 2-120 characters"),
    category: z.enum(ALLOWED_CATEGORIES),
    jobType: z.enum(ALLOWED_JOB_TYPES),
    isRemote: z.boolean(),
    location: z
      .string()
      .trim()
      .min(2, "Location must be 2-120 characters")
      .max(120, "Location must be 2-120 characters")
      .optional(),
    deadline: deadlineSchema,
    salaryMin: salarySchema.optional(),
    salaryMax: salarySchema.optional(),
    salaryFrequency: z.enum(ALLOWED_SALARY_FREQUENCIES).optional(),
    responsibilities: z
      .string()
      .trim()
      .min(20, "Responsibilities must be 20-5000 characters")
      .max(5000, "Responsibilities must be 20-5000 characters"),
    requirements: z
      .string()
      .trim()
      .min(20, "Requirements must be 20-5000 characters")
      .max(5000, "Requirements must be 20-5000 characters"),
  })
  .refine((job) => job.isRemote || job.location !== undefined, {
    message: "Location is required unless the job is remote",
    path: ["location"],
  })
  .refine(
    (job) => job.salaryFrequency !== undefined || (job.salaryMin === undefined && job.salaryMax === undefined),
    { message: "Salary frequency is required when a salary is provided", path: ["salaryFrequency"] }
  )
  .refine(
    (job) => job.salaryMin === undefined || job.salaryMax === undefined || job.salaryMax >= job.salaryMin,
    { message: "Maximum salary must be greater than or equal to the minimum", path: ["salaryMax"] }
  );
