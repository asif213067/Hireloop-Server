import "dotenv/config";
import { MongoClient } from "mongodb";

// Dev helper: no argument reports only, --fix repairs missing dates and dates stored as text
const shouldFix = process.argv.includes("--fix");
const client = new MongoClient(process.env.MONGODB_CLIENT);

try {
  await client.connect();
  const jobs = client.db(process.env.MONGODB_NAME).collection("jobs");
  const fields = ["createdAt", "updatedAt", "deadline"];

  // How each date field is stored across all jobs (date, string, missing, object)
  async function report() {
    for (const field of fields) {
      const rows = await jobs
        .aggregate([{ $group: { _id: { $type: `$${field}` }, count: { $sum: 1 } } }])
        .toArray();
      console.log(field, "->", rows.map((row) => `${row._id}: ${row.count}`).join(", "));
    }
  }

  console.log("Before:");
  await report();

  if (shouldFix) {
    // Missing createdAt: use updatedAt, otherwise now
    await jobs.updateMany({ createdAt: { $exists: false } }, [
      { $set: { createdAt: { $ifNull: ["$updatedAt", "$$NOW"] } } },
    ]);

    // Missing updatedAt: use createdAt
    await jobs.updateMany({ updatedAt: { $exists: false } }, [
      { $set: { updatedAt: "$createdAt" } },
    ]);

    // Dates saved as text become real dates
    for (const field of fields) {
      await jobs.updateMany({ [field]: { $type: "string" } }, [
        { $set: { [field]: { $toDate: `$${field}` } } },
      ]);
    }

    console.log("After:");
    await report();
  }
} finally {
  await client.close();
}
