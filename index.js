import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(cors());


// MongoDB setup
const client = new MongoClient(process.env.MONGODB_CLIENT);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db(process.env.MONGODB_NAME);
const users = db.collection("user");

mongodb: app.get("/", (req, res) => {
  res.send("Hello Asif Khan!");
});

app.get('/users', async (req, res) => {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
