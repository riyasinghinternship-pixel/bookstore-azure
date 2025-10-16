// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

import { MongoClient } from "mongodb";
import { StorageSharedKeyCredential, BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } from "@azure/storage-blob";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("root/public"));

/* --- MongoDB (Cosmos DB MongoDB API) setup --- */
const MONGODB_CONNECTION_STRING = process.env.MONGODB_CONNECTION_STRING;
const COSMOS_DB = process.env.COSMOS_DATABASE || "BookstoreDB";
const COSMOS_COLLECTION = process.env.COSMOS_CONTAINER || "Books";

if (!MONGODB_CONNECTION_STRING) {
  console.error("Missing MONGODB_CONNECTION_STRING in environment variables");
}

const mongoClient = new MongoClient(MONGODB_CONNECTION_STRING);
let db;
let booksCollection;

// Connect to MongoDB
(async () => {
  try {
    await mongoClient.connect();
    console.log("Connected to MongoDB (Cosmos DB)");
    db = mongoClient.db(COSMOS_DB);
    booksCollection = db.collection(COSMOS_COLLECTION);
  } catch (err) {
    console.error("Error connecting to MongoDB:", err);
  }
})();

/* --- Blob storage setup --- */
const AZ_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT;
const AZ_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const AZ_CONTAINER = process.env.AZURE_CONTAINER_NAME || "covers";

if (!AZ_ACCOUNT || !AZ_KEY) console.error("Missing Azure Storage account or key env vars");

const sharedKeyCredential = new StorageSharedKeyCredential(AZ_ACCOUNT, AZ_KEY);
const blobServiceClient = new BlobServiceClient(`https://${AZ_ACCOUNT}.blob.core.windows.net`, sharedKeyCredential);
const containerClient = blobServiceClient.getContainerClient(AZ_CONTAINER);

// ensure container exists (create if missing)
(async () => {
  try {
    const exists = await containerClient.exists();
    if (!exists) {
      await containerClient.create();
      console.log(`Created blob container: ${AZ_CONTAINER}`);
    }
  } catch (err) {
    console.error("Error ensuring container:", err);
  }
})();

/* --- Helper: fetch all items (simple) --- */
async function listBooks() {
  // Sort by _id descending (most recent first) - _id is always indexed
  const items = await booksCollection.find({}).sort({ _id: -1 }).toArray();
  return items;
}

/* --- API endpoints --- */
app.get("/api/books", async (req, res) => {
  try {
    const items = await listBooks();
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

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

app.post("/api/books", async (req, res) => {
  try {
    const { title, author, price, coverBlob } = req.body;
    const id = uuidv4();
    const doc = { id, title, author, price, coverBlob, createdAt: new Date().toISOString() };
    await booksCollection.insertOne(doc);
    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.put("/api/books/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { title, author, price, coverBlob } = req.body;
    const updateDoc = { 
      $set: { title, author, price, coverBlob, updatedAt: new Date().toISOString() }
    };
    const result = await booksCollection.findOneAndUpdate(
      { id },
      updateDoc,
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

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

/* --- Generate SAS for a single blob (for cover upload) --- */
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
    const expiresOn = new Date(startsOn.valueOf() + 5 * 60 * 1000); // 5 minutes

    const sasToken = generateBlobSASQueryParameters({
      containerName: AZ_CONTAINER,
      blobName,
      permissions: permissions,
      startsOn,
      expiresOn
    }, sharedKeyCredential).toString();

    const url = `https://${AZ_ACCOUNT}.blob.core.windows.net/${AZ_CONTAINER}/${encodeURIComponent(blobName)}?${sasToken}`;
    res.json({ url, blobName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

/* --- Generate read SAS for a blob (so front-end can display cover images) --- */
app.get("/api/cover-url", async (req, res) => {
  try {
    const blob = req.query.blob;
    if (!blob) return res.status(400).json({ error: "blob param required" });

    const startsOn = new Date();
    const expiresOn = new Date(startsOn.valueOf() + 10 * 60 * 1000); // 10 minutes read URL

    const permissions = new BlobSASPermissions();
    permissions.read = true;

    const sasToken = generateBlobSASQueryParameters({
      containerName: AZ_CONTAINER,
      blobName: blob,
      permissions,
      startsOn,
      expiresOn
    }, sharedKeyCredential).toString();

    const url = `https://${AZ_ACCOUNT}.blob.core.windows.net/${AZ_CONTAINER}/${encodeURIComponent(blob)}?${sasToken}`;
    // Redirect client to the blob SAS URL (so the <img> src can use it)
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Bookstore server running on port ${port}`);
});