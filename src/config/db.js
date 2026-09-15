const { MongoClient, GridFSBucket } = require('mongodb');

const DB_NAME = process.env.MONGODB_DB_NAME || 'rag_db';
const FILES_COLLECTION = 'files';
const CHUNKS_COLLECTION = process.env.MONGODB_COLLECTION_NAME || 'chunks';
const BUCKET_NAME = 'pdfs';

/** The Atlas Vector Search index that powers $vectorSearch on `chunks`. */
const VECTOR_INDEX_NAME = 'chunks_vector_index';
const EMBEDDING_DIMENSION = 768;

let client = null;
let db = null;

/** Open the connection. Safe to call more than once. */
async function connect() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });

  await client.connect();
  db = client.db(DB_NAME);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not connected. Call connect() first.');
  return db;
}

const files = () => getDb().collection(FILES_COLLECTION);
const chunks = () => getDb().collection(CHUNKS_COLLECTION);

/** GridFS bucket holding the original PDF bytes (pdfs.files / pdfs.chunks). */
const bucket = () => new GridFSBucket(getDb(), { bucketName: BUCKET_NAME });

/** Used by /api/health. Returns true if MongoDB answers. */
async function ping() {
  await getDb().command({ ping: 1 });
  return true;
}

async function ensureCollectionIndexes() {
  await files().createIndex({ sha256: 1 }, { unique: true, name: 'files_sha256_unique' });
  await files().createIndex({ createdAt: -1 }, { name: 'files_created_idx' });
  await chunks().createIndex({ fileId: 1, chunkIndex: 1 }, { unique: true, name: 'chunks_file_order_unique' });
}

async function ensureVectorIndex({ waitMs = 120000 } = {}) {
  let existing;
  try {
    existing = await chunks().listSearchIndexes(VECTOR_INDEX_NAME).toArray();
  } catch (err) {
    // Self-hosted / community mongod has no search-index commands at all.
    throw new Error(
      'This cluster does not support Atlas Search indexes, so $vectorSearch is ' +
        `unavailable. Point MONGODB_URI at an Atlas cluster. (${err.message})`
    );
  }

  if (existing.length === 0) {
    await chunks().createSearchIndex({
      name: VECTOR_INDEX_NAME,
      type: 'vectorSearch',
      definition: {
        fields: [
          {
            type: 'vector',
            path: 'embedding',
            numDimensions: EMBEDDING_DIMENSION,
            similarity: 'cosine',
          },
          { type: 'filter', path: 'fileId' },
        ],
      },
    });
    console.log(`[startup] created vector index "${VECTOR_INDEX_NAME}" (building...)`);
  }

  return waitForVectorIndex(waitMs);
}

async function waitForVectorIndex(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';

  while (Date.now() < deadline) {
    const [index] = await chunks().listSearchIndexes(VECTOR_INDEX_NAME).toArray();
    if (index) {
      lastStatus = index.status;
      if (index.queryable) return { name: VECTOR_INDEX_NAME, status: index.status };
      if (index.status === 'FAILED') {
        throw new Error(`Vector index "${VECTOR_INDEX_NAME}" failed to build.`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    `Vector index "${VECTOR_INDEX_NAME}" was not queryable within ` +
      `${timeoutMs / 1000}s (last status: ${lastStatus}).`
  );
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

module.exports = {
  connect,
  getDb,
  files,
  chunks,
  bucket,
  ping,
  ensureCollectionIndexes,
  ensureVectorIndex,
  close,
  DB_NAME,
  CHUNKS_COLLECTION,
  VECTOR_INDEX_NAME,
  EMBEDDING_DIMENSION,
};
