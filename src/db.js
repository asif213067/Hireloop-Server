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

export async function connectToMongoDB() {
  await mongoClient.connect();
  console.log("You successfully connected to MongoDB!");
}

// Create the job and application indexes once at startup
export async function ensureJobIndexes() {
  await jobs.createIndexes([
    { key: { recruiterId: 1, createdAt: -1 } },
    { key: { status: 1, createdAt: -1 } },
  ]);

  // One application per seeker per job; the jobId prefix also speeds up counts
  await applications.createIndex(
    { jobId: 1, applicantId: 1 },
    { unique: true },
  );
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
