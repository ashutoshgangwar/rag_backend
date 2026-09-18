# RAG Backend — Express + MongoDB Atlas Vector Search + Ollama

A Retrieval-Augmented Generation backend. No OpenAI, no LangChain, no vector-store
library. Every part of the pipeline is written out by hand so you can read it and
see exactly what RAG does.

The models run locally through Ollama; only the storage layer is in the cloud,
because `$vectorSearch` is an Atlas feature.

```
Ollama (local)                MongoDB Atlas
├── llama3.2:latest           ├── files    metadata + ingestion status
└── nomic-embed-text:latest   ├── chunks   text + embedding[768]  ← vector index
                              └── pdfs.*   GridFS: the original PDF bytes
```

---

## 1. What RAG is

A language model only knows what was in its training data. It has never seen
your PDF, and if you ask it about your PDF it will confidently make something
up.

RAG fixes this by **not** relying on the model's memory. Instead:

1. **Ahead of time (ingestion):** chop your documents into small chunks, convert
   each chunk into a vector that captures its *meaning*, and store those vectors
   in a database.
2. **At question time (retrieval):** convert the question into a vector the same
   way, find the handful of chunks whose vectors are closest to it, and paste
   those chunks into the prompt.
3. **Generation:** tell the model "answer using ONLY this text".

The model stops being a knowledge base and becomes a *reading comprehension
engine* over text you supplied. That is the whole idea.

---

## 2. Architecture

### Ingestion — `POST /api/documents/upload`

```
PDF file(s) (multipart upload)
      │
      ▼
extract text                 utils/pdfParser.js        (pdf-parse v2)
      │
      ▼
is it a resume?              utils/resumeClassifier.js (reject here, before any write)
      │
      ▼
clean text                   utils/chunkText.js        (cleanText)
      │
      ▼
split into overlapping chunks  utils/chunkText.js      (~900 chars, 150 overlap)
      │
      ▼
store the bytes in GridFS    services/document.service.js  → Atlas pdfs.files
      │                                                        (permanent original)
      ▼
embed every chunk            services/embedding.service.js → Ollama /api/embed
      │                                                       nomic-embed-text
      ▼
insertMany content+embedding services/document.service.js  → Atlas chunks
```

Two things are stored permanently, and they serve different purposes: the
**GridFS blob** is the original file, kept so the document can be re-chunked or
downloaded later; the **chunks** are what search actually runs against. Every
chunk keeps a `fileId` back-reference and a `pageNumber`, which is what lets an
answer cite the file and page it came from.

The PDF itself is **never** sent to the LLM. Only small retrieved chunks are, and
only at question time.

### Retrieval — `POST /api/chat`

```
question
   │
   ▼
embed the question           Ollama /api/embed  (same model as ingestion!)
   │
   ▼
question vector (768 floats)
   │
   ▼
Atlas $vectorSearch          aggregate([{ $vectorSearch: { ... } }])
   │
   ▼
top 5 chunks
   │
   ▼
build a numbered context block
   │
   ▼
strict RAG prompt  ──────▶  Ollama /api/generate  (llama3.2:latest)
   │
   ▼
answer + the sources it came from
```

### Files

```
src/
├── server.js                      Express app, health check, startup checks
├── config/db.js                   MongoClient, collections, GridFS bucket,
│                                  vector-index creation + readiness wait
├── routes/
│   ├── auth.routes.js             signup, login, me, logout
│   ├── document.routes.js         multer upload config + document routes
│   └── chat.routes.js             chat route
├── controllers/
│   ├── auth.controller.js         signup/login request + response shaping
│   ├── document.controller.js     upload, list, get, chunks, download, delete
│   └── chat.controller.js         request/response + input validation for chat
├── services/
│   ├── auth.service.js            accounts, bcrypt hashing, JWT issue/verify
│   ├── ollama.service.js          the only place that talks HTTP to Ollama
│   ├── embedding.service.js       text -> vector (+ dimension validation)
│   ├── document.service.js        INGESTION pipeline + GridFS + cascade delete
│   └── rag.service.js             RETRIEVAL pipeline + prompt
├── utils/
│   ├── chunkText.js               cleaning + overlapping chunking
│   ├── validators.js              signup/login field validation + normalizing
│   └── pdfParser.js               PDF -> per-page text
└── middleware/
    ├── auth.middleware.js         requireAuth / optionalAuth bearer-token gate
    └── error.middleware.js        ApiError, asyncHandler, central error handler
```

The layering rule: **routes** wire URLs, **controllers** validate input and shape
JSON, **services** hold the actual RAG logic, **utils** are pure functions.

---

## 3. Installation

Requires Node.js 18+ (built-in `fetch`). This project was built and tested on
Node v20.20.0.

```bash
cd rag-backend
npm install
```

Dependencies:

| Package | Why |
| --- | --- |
| `express` | HTTP server and routing |
| `mongodb` | Atlas driver: client, GridFS, search-index management |
| `multer` | parses `multipart/form-data` so we can receive the PDF |
| `pdf-parse` | extracts text from the PDF (v2 class API, built on pdf.js) |
| `dotenv` | loads `.env` so credentials stay out of the source |
| `cors` | lets a browser frontend on another port call this API |
| `nodemon` *(dev)* | restarts the server on file changes for `npm run dev` |

There is **no** vector-store library, no LangChain, and no HTTP client library —
the vector search is a plain aggregation pipeline and Ollama is called with
native `fetch`.

---

## 4. Environment variables

Copy `.env.example` to `.env` and adjust:

```env
PORT=5000

MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=rag-cluster
MONGODB_DB_NAME=rag_db
MONGODB_COLLECTION_NAME=chunks

OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_LLM_MODEL=llama3.2:latest
OLLAMA_EMBEDDING_MODEL=nomic-embed-text:latest

# RAG tuning
CHUNK_SIZE=900
CHUNK_OVERLAP=150
TOP_K=5
MAX_UPLOAD_MB=20

# Auth - JWT_SECRET must be long and random, anyone who knows it can mint
# a valid session. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=<a long random string>
JWT_EXPIRES_IN=7d
BCRYPT_ROUNDS=12
```

`.env` is git-ignored. No credential appears anywhere in the source.

> **Special characters in the password.** The password is part of a URI, so
> `#`, `@`, `/` and `:` must be percent-encoded (`#` becomes `%23`). An
> unencoded character silently truncates the URI and you get
> `bad auth : authentication failed`, which looks like a wrong password.

> **macOS and port 5000.** macOS "AirPlay Receiver" also listens on port 5000 and
> answers every request with an empty `403`, so your requests never reach
> Express. Either turn it off in *System Settings → General → AirDrop & Handoff →
> AirPlay Receiver*, or set `PORT=5001` in `.env`. The server prints a warning at
> startup if it detects this.

---

## 5. How to set up MongoDB Atlas

`$vectorSearch` is an **Atlas** feature. A self-hosted community `mongod` has no
search-index support at all, and the server will refuse to start against one.

1. Create a cluster (the free M0 tier supports vector search).
2. **Database Access** → add a database user, note the password.
3. **Network Access** → add your current IP. This is the most common cause of a
   hanging connection: the driver just times out with no useful message.
4. Put the connection string in `.env` as `MONGODB_URI`.

You do **not** need to create the database, the collections, or the vector index
by hand. On boot the server creates them if they are missing:

| Collection | Holds |
| --- | --- |
| `files` | one document per PDF: filename, size, `sha256`, page count, status |
| `chunks` | one document per chunk: `content`, `embedding[768]`, `fileId`, `pageNumber` |
| `pdfs.files` / `pdfs.chunks` | GridFS — the original PDF bytes |

The vector index it creates on `chunks`:

```json
{
  "name": "chunks_vector_index",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
      { "type": "filter", "path": "fileId" }
    ]
  }
}
```

That second entry is easy to overlook. A `$vectorSearch` can only filter on
fields declared as `type: "filter"` here — it is what makes "ask this question
against only *that* PDF" possible. Adding it later means rebuilding the index.

---

## 6. How to verify Ollama

```bash
ollama list                                # llama3.2 and nomic-embed-text listed?
curl http://localhost:11434/api/tags       # the daemon is answering

# a raw embedding call — should return 768 numbers
curl -s http://localhost:11434/api/embed \
  -d '{"model":"nomic-embed-text:latest","input":"hello"}' \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin)['embeddings'][0]))"
```

If a model is missing: `ollama pull llama3.2` / `ollama pull nomic-embed-text`.

---

## 7. How to start the Express server

```bash
npm start        # production-ish
npm run dev      # auto-restart on changes (nodemon)
```

On boot the server:

1. connects to Atlas (exits with a clear message if the URI, the credentials or
   the IP allow-list are wrong),
2. creates the ordinary indexes — `createIndex` is idempotent,
3. creates the vector index if absent, then **waits until it is queryable**.
   Atlas builds search indexes asynchronously (`QUEUED → BUILDING → READY`) and
   querying one before it is ready fails, so blocking here means the first
   upload cannot hit that race. The first ever boot therefore takes ~30s.
4. warns (but still starts) if Ollama or a model is missing.

Expected output:

```
[startup] MongoDB Atlas OK (database "rag_db")
[startup] collection indexes ready
[startup] vector index ready: chunks_vector_index (READY)
[startup] Ollama OK
[startup] RAG backend listening on http://localhost:5000
```

---

## 8. How to upload a PDF

This knowledge base holds **resumes only**. Anything else is refused before a
single byte is stored — see section 8b.

```bash
# one or many; the field name is "files"
curl -X POST http://localhost:5000/api/documents/upload \
  -F "files=@./resume.pdf" \
  -F "files=@./another-resume.pdf"
```

```json
{
  "success": true,
  "message": "Document stored and indexed successfully",
  "fileId": "6aa8300c8e5634ce091f9fb4",
  "file": "sample.pdf",
  "pages": 1,
  "characters": 1285,
  "chunksStored": 2,
  "status": "ready"
}
```

A `sample.pdf` (a short fake policy handbook) is included so you can try this
immediately.

Only `.pdf` files with MIME type `application/pdf` are accepted, up to
`MAX_UPLOAD_MB`, and at most `MAX_UPLOAD_FILES` per request. The upload is held
in memory and streamed straight into GridFS — nothing is ever written to local
disk, so there is no temp file to clean up and no way for a client-supplied
filename to become a path.

With several files, each one is ingested independently and gets its own entry in
`results[]` with an `outcome` of `ingested`, `duplicate`, `rejected` (not a
resume) or `failed` (something broke). One bad file never fails the batch.

## 8b. Resumes only

`utils/resumeClassifier.js` decides whether an extracted PDF is really a
resume/CV, in two tiers:

1. **A heuristic** over the extracted text — which resume sections appear
   (experience, education, skills, projects…), whether contact details are
   present, how long the document is, and whether it carries the giveaways of a
   statement, invoice or ID. Free and instant, and decisive for most files.
2. **The local LLM**, only for the minority the heuristic is unsure about. It is
   asked to *label* the document (RESUME / LETTER / STATEMENT / ID / ARTICLE /
   OTHER) rather than answer "is this a resume?" — asked the yes/no version,
   llama3.2 says yes to almost anything mentioning education or skills. Only the
   RESUME label passes. If Ollama is unreachable the check falls back to the
   heuristic rather than blocking every upload.

The gate lives in `document.service.ingestPdf`, and runs **before** the bytes are
written to GridFS, so a rejected file leaves nothing behind.

```bash
# ask first, without storing anything - this is what the UI calls on file-select
curl -X POST http://localhost:5000/api/documents/validate \
  -F "files=@./resume.pdf" -F "files=@./bank-statement.pdf"
```

```json
{
  "success": true, "allAccepted": false, "accepted": 1, "rejected": 1,
  "results": [
    { "filename": "resume.pdf", "accepted": true, "confidence": 0.94,
      "reason": "Found resume sections (experience, education, skills) and contact details." },
    { "filename": "bank-statement.pdf", "accepted": false, "confidence": 0.92,
      "reason": "This reads like a statement, invoice or official document, not a resume." }
  ]
}
```

A scanned resume gets `needsOcr: true` rather than a "not a resume" rejection —
it *is* a resume, it just has no extractable text yet.

Set `RESUME_ONLY=false` to accept any document again, or `RESUME_LLM_CHECK=false`
to keep the fast heuristic but skip the LLM second opinion.

Uploading the same bytes twice is free: the file is hashed with SHA-256 and a
duplicate returns the existing document instead of re-running the embedding,
which is the expensive part.

```bash
curl "http://localhost:5000/api/documents?limit=5"            # stored PDFs
curl "http://localhost:5000/api/documents/<id>/chunks"        # its chunks
curl "http://localhost:5000/api/documents/<id>/download" -o out.pdf   # the original
curl -X DELETE "http://localhost:5000/api/documents/<id>"     # file + chunks + bytes
curl -X DELETE http://localhost:5000/api/documents            # wipe everything
```

MongoDB has no `ON DELETE CASCADE`, so deleting one document explicitly removes
its chunks, its GridFS blob and its metadata — in that order, because an orphaned
chunk would still be returned by `$vectorSearch`.

---

## 9. How to ask questions

```bash
curl -X POST http://localhost:5000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is this document about?"
  }'
```

```json
{
  "success": true,
  "question": "What is the refund policy?",
  "answer": "Customers may request a full refund within 30 days of purchase...",
  "sources": [
    {
      "id": "6aa8300c8e5634ce091f9fb5",
      "fileId": "6aa8300c8e5634ce091f9fb4",
      "filename": "sample.pdf",
      "pageNumber": 3,
      "content": "...",
      "similarity": 0.8206
    }
  ],
  "tookMs": 4305
}
```

Optional `topK` (1–20) overrides how many chunks are retrieved. Optional
`fileIds` (an array of document ids) restricts the search to those PDFs — that
filter works only because `fileId` is declared as a filter field in the vector
index.

`sources` is what makes the answer auditable — you can read the exact text the
model was given. The 768-number embeddings are deliberately **not** returned.

Ask something the documents do not cover and you get the guard-rail, not a
hallucination:

```bash
curl -X POST http://localhost:5000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "Who won the 2018 FIFA World Cup?"}'
# -> "I don't know based on the provided documents."
```

---

## 10. How retrieval works

`rag.service.js` does four things:

1. **Embed the question** with `nomic-embed-text` — the *same* model used during
   ingestion. This matters: two embedding models produce two different, unrelated
   vector spaces, so mixing them makes every distance meaningless.
2. **Search** for the `TOP_K` nearest chunks (below).
3. **Build the context** — each chunk is labelled `[Source 1 | id=…]` so you can
   trace which chunk an answer came from.
4. **Prompt llama3.2** with strict instructions:

```
You are a helpful AI assistant.

Answer the user's question using ONLY the provided context.

If the answer cannot be found in the context, say:
"I don't know based on the provided documents."

Do not invent information.

Context:
{{context}}

Question:
{{question}}
```

`temperature` is set to `0.2` — low, because we want the model to stay close to
the retrieved text rather than be creative.

Retrieval is *lexically blind*: "How do I get my money back?" retrieves the
refund paragraph even though it shares no keywords with it, because the two
texts have similar **meanings** and therefore nearby vectors. That is the part a
keyword search (`LIKE '%refund%'`) cannot do.

---

## 11. How embeddings work

An embedding model maps text to a point in a 768-dimensional space, arranged so
that **text with similar meaning lands close together**:

```
"refund within 30 days"   ->  [ 0.021, -0.118,  0.067, ... ]  768 floats
"how do I get my money back"  [ 0.019, -0.121,  0.070, ... ]  ← nearby
"express shipping costs $15"  [-0.084,  0.203, -0.011, ... ]  ← far away
```

Key points:

- `nomic-embed-text` always returns exactly **768** numbers, which is why the
  index declares `numDimensions: 768`. `embedding.service.js` rejects anything
  else at write time — MongoDB would happily store a wrong-length array and only
  `$vectorSearch` would complain later, which is far harder to debug.
- Embedding is **deterministic and cheap** — no generation, no creativity. It is
  a lookup-style forward pass.
- **Why chunk first?** An embedding is one vector per text. Embedding a whole
  50-page PDF would produce the "average" of everything in it, matching nothing
  precisely. ~900-character chunks keep each vector about one idea.
- **Why overlap chunks?** A sentence split across a boundary would lose its
  meaning in both halves. Repeating the last 150 characters at the start of the
  next chunk keeps that context whole. `chunkText.js` also prefers to cut at a
  sentence or space boundary rather than mid-word.

Ingestion embeds chunks 4 at a time (`embedMany`). Ollama runs one local model,
so firing hundreds of requests at once only causes queueing and memory pressure.

---

## 12. How Atlas `$vectorSearch` works

Atlas Vector Search is not an ordinary index. It is a **search index**, defined
as JSON, built asynchronously by Atlas on its own search nodes, and queried
through a dedicated aggregation stage.

**Cosine similarity** compares the *direction* of two vectors while ignoring
their length, which is what you want for text: a long paragraph and a short
sentence about the same topic point the same way even though their magnitudes
differ.

The query in `rag.service.js`:

```js
db.collection('chunks').aggregate([
  {
    $vectorSearch: {
      index: 'chunks_vector_index',
      path: 'embedding',
      queryVector: vector,            // a plain number[] — no cast, no literal
      numCandidates: topK * 20,
      limit: topK,
      filter: { fileId: { $in: [...] } },   // optional
    },
  },
  {
    $project: {
      content: 1, fileId: 1, filename: 1, pageNumber: 1,
      score: { $meta: 'vectorSearchScore' },
    },
  },
]);
```

Five things about this that are not obvious:

- **`$vectorSearch` must be the first stage.** You cannot `$match` ahead of it to
  narrow the candidate set; use the stage's own `filter`, which is why `fileId`
  had to be declared as a filter field in the index definition.
- **`numCandidates` is the search width.** Atlas finds this many approximate
  neighbours, then ranks them down to `limit`. Too low and recall suffers;
  10–20× `limit` is the usual sweet spot. It is capped at 10,000.
- **The score is normalised.** For cosine, Atlas returns `(1 + cosine) / 2`, so
  it lands in `[0, 1]` where 1 is identical. This is *not* the same scale as
  pgvector's `1 - distance`, so any similarity threshold needs re-tuning.
- **`$project` must exclude `embedding`.** 768 doubles is roughly 6 KB per chunk;
  returning them would dwarf the actual content in every response.
- **The index is eventually consistent.** A chunk that was just inserted is not
  instantly searchable — normally well under a second, but not guaranteed. It is
  the one seam in an upload-then-immediately-ask flow.

### Why a vector index at all

Without one, finding the nearest chunk means comparing the question against
**every** stored vector — exact, but O(n). Atlas builds an HNSW ("Hierarchical
Navigable Small World") graph of the vectors and walks it, giving approximate
nearest neighbours in roughly logarithmic time.

`similarity` in the index definition must match how the embeddings were made.
Changing the embedding model later means **re-embedding every chunk**: vectors
from a different model live in a different space, and every distance between old
and new vectors would be meaningless.

### Storage note

An embedding stored as a BSON array of doubles costs ~6 KB per chunk. Once
things work, `Binary.fromFloat32Array()` stores the same vector as a float32
binary vector — about 4× smaller, with no measurable recall loss. Not worth
doing on day one.

---

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness + reachability of MongoDB and Ollama |
| `POST` | `/api/auth/signup` | create a company account, returns a token |
| `POST` | `/api/auth/login` | log in with email **or** phone number + password |
| `GET` | `/api/auth/me` | the signed-in account (needs a bearer token) |
| `POST` | `/api/auth/logout` | client-side token discard |
| `POST` | `/api/documents/validate` | pre-flight: are these PDFs resumes? (stores nothing) |
| `POST` | `/api/documents/upload` | ingest one or more resumes (`multipart/form-data`, field `files`) |
| `GET` | `/api/documents` | list stored PDFs (`?limit=&offset=`) |
| `GET` | `/api/documents/:id` | one PDF's metadata and ingestion status |
| `GET` | `/api/documents/:id/chunks` | its chunks (`?limit=&offset=`), previews only |
| `GET` | `/api/documents/:id/download` | stream back the original PDF |
| `DELETE` | `/api/documents/:id` | delete one PDF, its chunks and its bytes |
| `DELETE` | `/api/documents` | wipe the knowledge base |
| `POST` | `/api/chat` | ask a question (`{ "question", "topK", "fileIds" }`) - bearer token, uses a prompt |
| `GET` | `/api/agents` | the AI agent catalog (needs a bearer token) |
| `POST` | `/api/agents/:agentId/run` | run an agent on a filled-in form |
| `POST` | `/api/agents/runs/:runId/messages` | ask a follow-up on an earlier run |
| `GET` | `/api/subscriptions/plans` | active plans + the free prompt limit (public) |
| `GET` | `/api/subscriptions/me` | prompts used/remaining and the active subscription |
| `POST` | `/api/subscriptions/subscribe` | buy a plan (`{ "planId": "monthly" }`) |
| `GET` | `/api/subscriptions/history` | every subscription this user bought |
| `GET` | `/api/admin/plans` | all plans, inactive included (admin) |
| `POST` | `/api/admin/plans` | create a plan (admin) |
| `PATCH` | `/api/admin/plans/:planId` | change amount / name / duration / `active` (admin) |
| `GET` | `/api/admin/settings` | billing settings (admin) |
| `PATCH` | `/api/admin/settings` | change `freePromptLimit` (admin) |

### Auth

**Sign up.** The account *is* the company account, so the company details are
captured here - there is no separate "create organization" step. Both an email
and a phone number are required, because either one can be used to log in.

```bash
curl -X POST http://localhost:5000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{
    "fullName": "Ada Lovelace",
    "email": "ada@example.com",
    "phone": "+91 98765 43210",
    "companyName": "Analytical Engines",
    "designation": "Head of Engineering",
    "employeeStrength": "51-200",
    "companyIndustry": "Software",
    "password": "Numbers123",
    "confirmPassword": "Numbers123"
  }'
```

`employeeStrength` is one of `1-10`, `11-50`, `51-200`, `201-500`, `501-1000`,
`1000+` - a raw headcount like `250` is accepted too and mapped into its band.

Passwords need at least 8 characters including a letter and a number, and
`confirmPassword` must match. Signup answers **201** with the same
`{ user, token }` shape login does, so the frontend can drop the new user
straight into the app:

```json
{
  "success": true,
  "message": "Account created.",
  "user": { "id": "...", "fullName": "Ada Lovelace", "email": "ada@example.com", "phone": "+919876543210", "companyName": "Analytical Engines", "designation": "Head of Engineering", "employeeStrength": "51-200", "companyIndustry": "Software" },
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresAt": "2026-09-22T10:00:00.000Z"
}
```

**Log in.** One field, `identifier`, covers both ways in - an `@` means email,
anything else is read as a phone number. The frontend needs a single input box,
not a toggle. (`email` or `phone` are accepted instead of `identifier` if your
form has two separate fields.)

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{ "identifier": "ada@example.com", "password": "Numbers123" }'

curl -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{ "identifier": "9876543210", "password": "Numbers123" }'
```

Phone numbers are normalized, so `+91 98765-43210`, `(+91) 9876543210` and a
bare `9876543210` all reach the same account. If two accounts from different
countries share those last 10 digits, login answers **409** asking for the
country code rather than guessing which person is signing in.

A wrong password and an unknown account give the **same** 401 and take the same
time, so the endpoint cannot be used to discover which emails and phone numbers
are registered.

**Use the token** on any protected route:

```bash
curl http://localhost:5000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

To put an existing route behind a login, add the middleware in front of it:

```js
const { requireAuth } = require('../middleware/auth.middleware');
router.post('/', requireAuth, asyncHandler(controller.chat));
```

The handler then has `req.user` and `req.userId`. The document routes are
**not** gated yet - they still accept anonymous requests. Chat needs a token,
because every question is metered (see Subscriptions API).

### Subscriptions API

Every prompt - `POST /api/chat`, an agent run, an agent follow-up - is metered.
A user gets `freePromptLimit` free prompts (5 by default) for the lifetime of
the account; after that the prompt routes answer **402** until they subscribe:

```json
{ "success": false, "error": "You have used all 5 free prompts. Subscribe to a plan to continue.",
  "details": { "code": "SUBSCRIPTION_REQUIRED", "freePromptLimit": 5, "plans": [ ... ] } }
```

A request that fails (bad input, model error) gives its prompt back. Successful
prompt responses carry `usage: { subscribed, freePromptsRemaining }`.

**Everything is configured in MongoDB.** On first startup the app seeds:

- `plans`: `daily` (49 INR, 1 day), `monthly` (499 INR, 1 month), `yearly` (4999 INR, 1 year)
- `settings`: `{ _id: "billing", freePromptLimit: 5 }`

Seeding only inserts missing documents, so changes you make are never overwritten.
Edit `amount`, `currency`, `interval` (`day`/`month`/`year`), `intervalCount`,
`name` or `active` directly in Atlas, or through the admin API. The change
applies to the next request, with no restart. A subscription keeps the price it
was bought at.

**Admins**: set `role: "admin"` on a user document in the `users` collection.

```bash
curl -X PATCH http://localhost:5000/api/admin/plans/monthly \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "amount": 399 }'

curl -X PATCH http://localhost:5000/api/admin/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "freePromptLimit": 10 }'
```

**Subscribe** - `POST /api/subscriptions/subscribe` with `{ "planId": "monthly" }`.
Buying again while subscribed stacks the new period after the current one.
No payment gateway is wired in yet, so this activates the plan straight away.
Put the gateway's order/verify step in front of it before going live.

### Agents API

Form-driven helpers (Study Q&A, Email Writer, Trip Planner, ...) on top of the
local `llama3.2`. They only **write text** - answers, drafts, plans. Nothing is
booked, sent or fetched live, and no embeddings or `$vectorSearch` are involved.
All three routes need a bearer token.

The catalog lives in `src/agents/catalog.js` and is upserted into the `agents`
collection by `id` on every startup. Extra fields on a stored agent survive, and
an agent inserted straight into MongoDB shows up too (`enabled: false` hides one).
Runs are stored per user in `agent_runs`.

**List agents** - `GET /api/agents`

```json
{ "success": true, "groups": [{ "id": "education", "label": "Education" }], "agents": [{ "id": "tutor", "name": "Study Q&A", "fields": [] }] }
```

**Run an agent** - `POST /api/agents/:agentId/run`

```bash
curl -X POST http://localhost:5000/api/agents/tutor/run \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "input": { "subject": "Physics", "level": "School", "request": "What is inertia?" } }'
```

```json
{ "success": true, "runId": "66f0c2...", "result": { "kind": "answer", "text": "## Inertia\n..." }, "tookMs": 1234 }
```

`input` is checked against the agent's `fields`: required fields must be
non-empty, a `select` value must be one of its `options`, a `number` must be
within `min`/`max`, `text` is capped at 300 characters and `textarea` at 6000
(12000 in total). A failure is a **400** naming every bad field:

```json
{ "success": false, "error": "Your question is required.", "details": { "fields": { "request": "Your question is required." } } }
```

**Follow up** - `POST /api/agents/runs/:runId/messages`

```bash
curl -X POST http://localhost:5000/api/agents/runs/$RUN_ID/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "question": "Give one more example" }'
```

```json
{ "success": true, "text": "...", "tookMs": 1234 }
```

`question` is capped at 1000 characters. The model sees the original brief and
the last 6 messages. Another user's run answers **404** exactly like a missing
one, and a conversation stops at 40 messages (**409**).

### Health check

```bash
curl http://localhost:5000/api/health
```

```json
{
  "success": true,
  "message": "RAG backend is running",
  "services": {
    "mongodb": {
      "reachable": true,
      "database": "rag_db",
      "vectorIndex": "chunks_vector_index"
    },
    "ollama": {
      "reachable": true,
      "models": ["nomic-embed-text:latest", "llama3.2:latest"],
      "llmAvailable": true,
      "embeddingAvailable": true
    }
  }
}
```

Returns **503** if either dependency is down, so a monitor can act on it.

### Errors

Every failure returns `{ "success": false, "error": "..." }` with a meaningful
status code:

| Situation | Status |
| --- | --- |
| no file / not a PDF / corrupt PDF / empty PDF / invalid question / bad id | `400` |
| unknown route / unknown document id | `404` |
| PDF parsed but contained no text (e.g. a scanned image PDF) | `422` |
| Ollama returned an HTTP error (e.g. model not pulled) | `502` |
| Ollama or MongoDB unreachable | `503` |
| Ollama took longer than 120s | `504` |

If ingestion fails partway, the file is marked `status: "failed"` with the reason
in its `error` field and any chunks already written are removed — a half-indexed
document would otherwise pollute every future search.

### Common failures

| Symptom | Cause |
| --- | --- |
| `bad auth : authentication failed` | wrong DB user/password, or an unencoded special character in the URI |
| connection hangs, then times out | your IP is not in Atlas **Network Access** |
| `does not support Atlas Search indexes` | `MONGODB_URI` points at a non-Atlas `mongod` |
| `Cannot reach Ollama` | `ollama serve` is not running |

---

## Security notes

- `.env` is git-ignored; credentials live only in `.env`. Because the password is
  part of a URI, percent-encode any `#`, `@`, `/` or `:` in it.
- Uploads are restricted to PDFs by **both** MIME type and extension, capped at
  `MAX_UPLOAD_MB`, and held in memory rather than written to disk — the
  client-supplied name is only ever a display label, never a path.
- Queries are built from typed values (`ObjectId`), never string-concatenated,
  and an id that is not a valid `ObjectId` is rejected with a 400.
- JSON bodies are capped at 1 MB and questions at 1000 characters.
- Stack traces are never returned when `NODE_ENV=production`.

## Where to go next

- **Async ingestion.** Upload currently blocks until every chunk is embedded,
  which is minutes for a large PDF. The `files.status` field
  (`pending`/`processing`/`ready`/`failed`) is already there for it: return `202`
  immediately and let a worker do the embedding while the client polls
  `GET /api/documents/:id`.
- **Conversation memory.** Add `conversations` and `messages` collections so chat
  is not one-shot.
- **An agent loop.** Replace the fixed retrieve-then-prompt pipeline with tools
  the model can choose between — `search_documents`, `keyword_search`,
  `get_chunk_context`, `summarize_document`. Note that `llama3.2:3b` is weak at
  tool calling; a 7B/8B instruct model handles it far better.
- **Hybrid search.** Add an Atlas Search (lexical) index and fuse it with vector
  results — embeddings are poor at exact invoice numbers, SKUs and names.
- Tune `CHUNK_SIZE` / `CHUNK_OVERLAP` / `TOP_K` and watch how `similarity`
  scores in the response change — that is the fastest way to build intuition.
