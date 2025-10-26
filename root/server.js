// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { MongoClient } from "mongodb";
import {
  StorageSharedKeyCredential,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions
} from "@azure/storage-blob";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("root/public")); // Serve your frontend files

/* ==============================
   MongoDB (Cosmos DB Mongo API)
   ============================== */
const MONGODB_CONNECTION_STRING = process.env.MONGODB_CONNECTION_STRING;
const COSMOS_DB = process.env.COSMOS_DATABASE || "BookstoreDB";
const COSMOS_COLLECTION = process.env.COSMOS_CONTAINER || "Books";

if (!MONGODB_CONNECTION_STRING) {
  console.error("❌ Missing MONGODB_CONNECTION_STRING in environment variables");
  process.exit(1);
}

let db, booksCollection;

/* ==============================
   Azure Blob Storage Setup
   ============================== */
const AZ_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT;
const AZ_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const AZ_CONTAINER = process.env.AZURE_CONTAINER_NAME || "covers";

if (!AZ_ACCOUNT || !AZ_KEY)
  console.error("⚠️ Missing Azure Storage account or key env vars");

const sharedKeyCredential = new StorageSharedKeyCredential(AZ_ACCOUNT, AZ_KEY);
const blobServiceClient = new BlobServiceClient(
  `https://${AZ_ACCOUNT}.blob.core.windows.net`,
  sharedKeyCredential
);
const containerClient = blobServiceClient.getContainerClient(AZ_CONTAINER);

// Ensure blob container exists
(async () => {
  try {
    const exists = await containerClient.exists();
    if (!exists) {
      await containerClient.create();
      console.log(`🪣 Created blob container: ${AZ_CONTAINER}`);
    }
  } catch (err) {
    console.error("❌ Error ensuring container:", err);
  }
})();

/* ==============================
   Helper: fetch all books
   ============================== */
async function listBooks() {
  return await booksCollection.find({}).sort({ _id: -1 }).toArray();
}

/* ==============================
   Connect to MongoDB and start server
   ============================== */
(async () => {
  try {
    const client = new MongoClient(MONGODB_CONNECTION_STRING, {
      tls: true,
      retryWrites: false,
      serverSelectionTimeoutMS: 10000,
    });

    console.log("🌐 Connecting to Cosmos MongoDB...");
    await client.connect();
    db = client.db(COSMOS_DB);
    booksCollection = db.collection(COSMOS_COLLECTION);
    console.log("✅ Connected to Cosmos MongoDB");

    // Start Express server only after DB connection
    const port = process.env.PORT || 3000;
    app.listen(port, () =>
      console.log(`🚀 Bookstore server running on port ${port}`)
    );
  } catch (err) {
    console.error("❌ Error connecting to MongoDB:", err);
  }
})();

/* ==============================
   Middleware: log incoming requests
   ============================== */
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
  next();
});

/* ==============================
   API ROUTES
   ============================== */

// Health check
app.get("/api/test", (req, res) => {
  res.json({ ok: true, message: "Backend is working!" });
});

// Get all books
app.get("/api/books", async (req, res) => {
  try {
    const items = await listBooks();
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Get one book
app.get("/api/books/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const book = await booksCollection.findOne({ id });
    if (!book) return res.status(404).json({ error: "Not found" });
    res.json(book);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Add new book
app.post("/api/books", async (req, res) => {
  try {
    const { title, author, price, coverBlob } = req.body;
    if (!title || !author)
      return res.status(400).json({ error: "Title and author required" });

    const id = uuidv4();
    const doc = {
      id,
      title,
      author,
      price,
      coverBlob,
      createdAt: new Date(),
    };

    const result = await booksCollection.insertOne(doc);
    if (!result.acknowledged) throw new Error("Insert failed");

    res.status(201).json(doc);
  } catch (err) {
    console.error("Insert error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// Update book
app.put("/api/books/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { title, author, price, coverBlob } = req.body;
    const updateDoc = {
      $set: { title, author, price, coverBlob, updatedAt: new Date() },
    };
    const result = await booksCollection.findOneAndUpdate(
      { id },
      updateDoc,
      { returnDocument: "after" }
    );
    if (!result.value)
      return res.status(404).json({ error: "Not found" });
    res.json(result.value);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Delete book
app.delete("/api/books/:id", async (req, res) => {
  try {
    const id = req.params.id;
    await booksCollection.deleteOne({ id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Generate SAS token for cover upload
app.post("/api/generate-sas", async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "filename required" });

    const safeName = filename.replace(/[^a-zA-Z0-9-.]/g, "");
    const blobName = `covers/${Date.now()}-${safeName}`;

    const permissions = new BlobSASPermissions();
    permissions.create = true;
    permissions.write = true;

    const startsOn = new Date();
    const expiresOn = new Date(startsOn.valueOf() + 5 * 60 * 1000); // 5 min

    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: AZ_CONTAINER,
        blobName,
        permissions,
        startsOn,
        expiresOn,
      },
      sharedKeyCredential
    ).toString();

    const url = `https://${AZ_ACCOUNT}.blob.core.windows.net/${AZ_CONTAINER}/${encodeURIComponent(
      blobName
    )}?${sasToken}`;

    res.json({ url, blobName });
  } catch (err) {
    console.error("SAS error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// Generate SAS for cover display
app.get("/api/cover-url", async (req, res) => {
  try {
    const blob = req.query.blob;
    if (!blob) return res.status(400).json({ error: "blob param required" });

    const startsOn = new Date();
    const expiresOn = new Date(startsOn.valueOf() + 10 * 60 * 1000);

    const permissions = new BlobSASPermissions();
    permissions.read = true;

    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: AZ_CONTAINER,
        blobName: blob,
        permissions,
        startsOn,
        expiresOn,
      },
      sharedKeyCredential
    ).toString();

    const url = `https://${AZ_ACCOUNT}.blob.core.windows.net/${AZ_CONTAINER}/${encodeURIComponent(
      blob
    )}?${sasToken}`;

    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});
