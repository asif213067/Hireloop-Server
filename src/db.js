import { ObjectId } from "mongodb";
import { MongoClient } from "mongodb";

import { env } from "./env.js";

// Shared client; one connection for the whole process
export const mongoClient = new MongoClient(env.mongoUri);

export const db = mongoClient.db(env.dbName);

// Better Auth `user` collection (same database the client writes to)
export const users = db.collection("user");

export const jobs = db.collection("jobs");

// One document per application: { jobId, applicantId, createdAt }
export const applications = db.collection("applications");

// One document per saved job: { jobId, applicantId, createdAt }
export const savedJobs = db.collection("savedJobs");

export async function connectToMongoDB() {
  await mongoClient.connect();
  console.log("You successfully connected to MongoDB!");
}

// Create the job and application indexes once at startup
export async function ensureJobIndexes() {
  await jobs.createIndexes([
    { key: { recruiterId: 1, createdAt: -1 } },
    { key: { status: 1, createdAt: -1 } },
    // Public browsing: open jobs, newest first
    { key: { status: 1, deadline: 1, createdAt: -1 } },
  ]);

  // Keyword search; a collection can have only one text index
  await jobs.createIndex(
    {
      title: "text",
      companyName: "text",
      category: "text",
      responsibilities: "text",
      requirements: "text",
    },
    {
      name: "jobs_text_search",
      weights: {
        title: 10,
        companyName: 5,
        category: 3,
        responsibilities: 1,
        requirements: 1,
      },
    },
  );

  // One application per seeker per job; the jobId prefix also speeds up counts
  await applications.createIndex(
    { jobId: 1, applicantId: 1 },
    { unique: true },
  );

  // The seeker's own list, newest first
  await applications.createIndex({ applicantId: 1, createdAt: -1 });

  // One save per seeker per job
  await savedJobs.createIndex({ applicantId: 1, jobId: 1 }, { unique: true });
}

// The Mongo adapter stores Better Auth ids as ObjectIds; sub is the hex string
export function isObjectId(value) {
  return (
    typeof value === "string" &&
    ObjectId.isValid(value) &&
    /^[0-9a-fA-F]{24}$/.test(value)
  );
}

export function toObjectId(value) {
  return new ObjectId(value);
}
