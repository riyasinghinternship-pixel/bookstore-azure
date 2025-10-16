// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

import { CosmosClient } from "@azure/cosmos";
import { StorageSharedKeyCredential, BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } from "@azure/storage-blob";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* --- Cosmos DB setup --- */
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB = process.env.COSMOS_DATABASE || "BookstoreDB";
const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || "Books";

if (!COSMOS_ENDPOINT || !COSMOS_KEY) {
  console.error("Missing Cosmos DB credentials in env (COSMOS_ENDPOINT/COSMOS_KEY)");
}

const cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
const database = cosmosClient.database(COSMOS_DB);
const container = database.container(COSMOS_CONTAINER);

/* --- Blob storage setup --- */
const AZ_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT;
const AZ_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const AZ_CONTAINER = process.env.AZURE_CONTAINER_NAME || "covers";

if (!AZ_ACCOUNT || !AZ_KEY) console.error("Missing Azure Storage account or key env vars");

const sharedKeyCredential = new StorageSharedKeyCredential(AZ_ACCOUNT, AZ_KEY);
const blobServiceClient = new BlobServiceClient(https://${AZ_ACCOUNT}.blob.core.windows.net, sharedKeyCredential);
const containerClient = blobServiceClient.getContainerClient(AZ_CONTAINER);

// ensure container exists (create if missing)
(async () => {
  try {
    const exists = await containerClient.exists();
    if (!exists) {
      await containerClient.create();
      console.log(Created blob container: ${AZ_CONTAINER});
    }
  } catch (err) {
    console.error("Error ensuring container:", err);
  }
})();

/* --- Helper: fetch all items (simple) --- */
async function listBooks() {
  const querySpec = { query: "SELECT * FROM c ORDER BY c._ts DESC" };
  const { resources: items } = await container.items.query(querySpec).fetchAll();
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
    const { resource } = await container.item(id, id).read(); // partitionKey = id (we used /id)
    if (!resource) return res.status(404).json({ error: "Not found" });
    res.json(resource);
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
    const { resource } = await container.items.create(doc);
    res.status(201).json(resource);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.put("/api/books/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { title, author, price, coverBlob } = req.body;
    // read existing
    const { resource } = await container.item(id, id).read();
    if (!resource) return res.status(404).json({ error: "Not found" });
    const updated = Object.assign(resource, { title, author, price, coverBlob, updatedAt: new Date().toISOString() });
    const { resource: replaced } = await container.item(id, id).replace(updated);
    res.json(replaced);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/api/books/:id", async (req, res) => {
  try {
    const id = req.params.id;
    await container.item(id, id).delete();
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
    const blobName = covers/${Date.now()}-${safeName};

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

    const url = https://${AZ_ACCOUNT}.blob.core.windows.net/${AZ_CONTAINER}/${encodeURIComponent(blobName)}?${sasToken};
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

    const url = https://${AZ_ACCOUNT}.blob.core.windows.net/${AZ_CONTAINER}/${encodeURIComponent(blob)}?${sasToken};
    // Redirect client to the blob SAS URL (so the <img> src can use it)
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(Bookstore server running on port ${port});
});