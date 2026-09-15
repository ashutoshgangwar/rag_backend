# Frontend Prompt — copy everything below this line

---

Build a complete frontend for an existing RAG backend using **React + Vite**.

Use **JavaScript, not TypeScript**.

The backend is already built, running, and tested. **Do not modify the backend.**
Do not install or use OpenAI, Anthropic, Gemini, Pinecone, or any paid cloud AI
service — the backend talks to a local Ollama instance for both the LLM and the
embeddings, and stores everything in MongoDB Atlas.

---

# The backend API (already working — this is the exact contract)

Base URL: `http://localhost:5000` (see the port note at the bottom — it may be `5001`).

CORS is already enabled on the backend for all origins, so the browser can call
it directly. No auth, no API keys, no tokens.

All responses are JSON. **Every error** — at any status code — has this shape:

```json
{ "success": false, "error": "Human readable message" }
```

So error handling can be centralized in one place.

## The mental model you are building a UI for

The backend stores **files** and **chunks**, and they are different things:

- A **file** is one uploaded PDF. Its original bytes are kept permanently, so it
  can be downloaded back. It has an ingestion `status`.
- A **chunk** is one ~900-character slice of that PDF, stored with a 768-number
  embedding vector. Chunks are what semantic search actually runs against.
  Every chunk knows which file and which **page number** it came from.

That relationship is the whole point of the UI: the user uploads *files*, but
answers are supported by *chunks*, and each chunk can be traced back to a file
and a page.

**All ids are 24-character hex strings** (MongoDB ObjectIds), e.g.
`"6aa8300c8e5634ce091f9fb4"` — never integers. Treat them as opaque strings;
never parse, sort, or do arithmetic on them.

---

## `GET /api/health`

Checks whether MongoDB Atlas and Ollama are reachable.

Returns **200** when healthy, **503** when degraded. The body shape is the same
either way, so read `success`, not just the status:

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
      "embeddingAvailable": true,
      "llmModel": "llama3.2:latest",
      "embeddingModel": "nomic-embed-text:latest"
    }
  }
}
```

When something is down, `mongodb` or `ollama` gains an `error` string field.

---

## `POST /api/documents/validate`

**Call this the moment files are picked, before the user can press Submit.**

This knowledge base accepts **resumes only**. `/validate` reads the selected
PDFs and tells you, per file, whether each one is a resume — without storing
anything and without embedding anything, so it is cheap and fast.

- `Content-Type: multipart/form-data`, field name `files` (repeat it per file)
- Never fails because of a bad document: a rejected file is a normal result

```json
{
  "success": true,
  "allAccepted": false,
  "accepted": 1,
  "rejected": 1,
  "results": [
    {
      "filename": "resume.pdf",
      "sizeBytes": 48211, "pageCount": 2, "characters": 3140,
      "accepted": true, "isResume": true, "needsOcr": false,
      "confidence": 0.94,
      "reason": "Found resume sections (experience, education, skills) and contact details.",
      "method": "heuristic",
      "alreadyUploaded": false, "existingId": null
    },
    {
      "filename": "bank-statement.pdf",
      "accepted": false, "isResume": false, "needsOcr": false,
      "confidence": 0.92,
      "reason": "This reads like a statement, invoice or official document, not a resume.",
      "method": "heuristic"
    }
  ]
}
```

**What the UI must do with this:**

- Show each picked file as a row with a ✅ / ❌ badge and the `reason` text.
- **Keep Submit disabled unless `allAccepted` is true**, or let the user remove
  the rejected rows and submit the rest.
- `needsOcr: true` is *not* "this is not a resume" — it means no text could be
  read. Say so specifically: the file is probably a scan or a photo, and it
  needs OCR before it can be indexed. Do not tell the user their resume is not a
  resume.
- `alreadyUploaded: true` means re-uploading those exact bytes will be a no-op;
  mark the row as already in the knowledge base.
- `method` is `"heuristic"`, `"llm"` or `"heuristic-fallback"` — useful in a
  debug view, not something to show a normal user.
- `/validate` is a convenience, not the enforcement. `/upload` runs the same
  check again, so never treat a pass here as a guarantee.

---

## `POST /api/documents/upload`

Ingests one or more resumes: stores the original bytes, extracts text page by
page, chunks it, embeds every chunk, stores the chunks.

- `Content-Type: multipart/form-data`
- Field name is `files` (repeat it per file). The old `file` name still works.
- **PDF only** — rejected by both MIME type and `.pdf` extension
- **Resumes only** — anything else is refused *before* it is stored
- Max size **20 MB** per file, **10 files** per request

Multi-file success — **201** (at least one file made it in):

```json
{
  "success": true,
  "message": "1 resume(s) stored and indexed, 2 rejected (not a resume).",
  "uploaded": 1,
  "rejected": 2,
  "failed": 0,
  "results": [
    { "filename": "resume.pdf", "outcome": "ingested", "fileId": "6aa8...",
      "pages": 1, "characters": 730, "chunksStored": 1, "status": "ready" },
    { "filename": "statement.pdf", "outcome": "rejected", "isResume": false,
      "confidence": 0.92,
      "error": "\"statement.pdf\" does not look like a resume. ... Only resumes/CVs can be uploaded here." }
  ]
}
```

`outcome` per file is one of:

| `outcome` | Meaning | How to show it |
| --- | --- | --- |
| `ingested` | stored and indexed | success |
| `duplicate` | identical bytes already indexed | informational, not success |
| `rejected` | the resume gate refused it | explain with `error`; offer to remove the row |
| `failed` | something broke (Ollama down, unreadable PDF) | retryable error — **not** "not a resume" |

If *every* file is rejected or failed, the status is **422** and
`success: false`. One bad file never fails the whole batch.

Single-file success — **201** (the flat shape below is still returned alongside
`results[]`, so existing single-file code keeps working):

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

**Duplicate uploads are not an error.** The backend hashes the file, and
re-uploading identical bytes returns **201** with `"deduplicated": true` and the
*existing* document's fields, with the message `"This PDF was already indexed;
returning the existing document."` Show this as an informational outcome, not a
success toast that implies new work happened and not a failure.

Failure cases you must handle in the UI:

| Situation | Status | `error` message |
| --- | --- | --- |
| no file sent | 400 | `No file uploaded. Send PDFs in a multipart field named "files".` |
| not a PDF | 400 | `"notes.txt" is not a PDF. Only .pdf resumes are allowed.` |
| not a resume | 422 | `"x.pdf" does not look like a resume. <why> Only resumes/CVs can be uploaded here.` |
| too many files | 400 | `Too many files. Maximum is 10 per upload.` |
| corrupt PDF | 400 | `The uploaded file is not a valid PDF.` |
| 0-byte file | 400 | `The uploaded PDF is empty (0 bytes).` |
| over 20 MB | 400 | `File too large. Maximum allowed size is 20 MB.` |
| scanned/image-only PDF (no extractable text) | 422 | `No text could be extracted from "x.pdf". Scanned/image-only PDFs need OCR first.` |
| Ollama down | 503 | `Cannot reach Ollama at ...` |
| MongoDB unreachable | 503 | `MongoDB is unavailable. ...` |

**Timing:** a 1-page PDF indexes in well under a second, but every chunk is
embedded one small batch at a time, so a large PDF can take minutes. The request
is synchronous — there is no job queue and no progress endpoint. Design for a
request that may run for a long time, and do not set a short client timeout.

---

## `GET /api/documents?limit=20&offset=0`

Lists the uploaded **PDFs** (not chunks), newest first.

- `limit`: 1–100, default 20
- `offset`: >= 0, default 0

```json
{
  "success": true,
  "total": 3,
  "limit": 20,
  "offset": 0,
  "files": [
    {
      "id": "6aa8300c8e5634ce091f9fb4",
      "filename": "sample.pdf",
      "sizeBytes": 19859,
      "pageCount": 1,
      "chunkCount": 2,
      "status": "ready",
      "error": null,
      "createdAt": "2026-09-14T11:27:34.520Z"
    }
  ],
  "stats": { "files": 3, "chunks": 47 }
}
```

- `total` is the count of **all** files, for pagination.
- `stats` is the whole knowledge base at a glance — use it for a
  "3 documents · 47 chunks indexed" header.
- `status` is one of `pending` / `processing` / `ready` / `failed`. A `failed`
  file carries the reason in `error` — surface it on the row rather than hiding
  a broken document in the list.

---

## `GET /api/documents/:id`

One PDF's metadata and ingestion status. Same field set as a row above, plus
`characters`. Returns **404** with `No document with id "..."` if unknown, and
**400** if the id is not a valid 24-character ObjectId.

```json
{
  "success": true,
  "file": {
    "id": "6aa8300c8e5634ce091f9fb4",
    "filename": "sample.pdf",
    "sizeBytes": 19859,
    "pageCount": 1,
    "chunkCount": 2,
    "characters": 1285,
    "status": "ready",
    "error": null,
    "createdAt": "2026-09-14T11:27:34.520Z"
  }
}
```

---

## `GET /api/documents/:id/chunks?limit=20&offset=0`

The chunks belonging to one PDF, in document order. Returns a **200-character
preview**, never the 768-number embedding vector.

```json
{
  "success": true,
  "total": 2,
  "limit": 20,
  "offset": 0,
  "chunks": [
    {
      "id": "6aa8300c8e5634ce091f9fb5",
      "fileId": "6aa8300c8e5634ce091f9fb4",
      "filename": "sample.pdf",
      "chunkIndex": 0,
      "pageNumber": 1,
      "preview": "ACME Corporation Customer Policy Handbook\n1. Refund Policy...",
      "length": 531,
      "createdAt": "2026-09-14T11:27:34.520Z"
    }
  ]
}
```

---

## `GET /api/documents/:id/download`

Streams back the **original PDF bytes**, with `Content-Type: application/pdf`
and `Content-Disposition: inline`. This is a plain browser navigation or an
`<a href>` / `<iframe src>` target — do **not** fetch it as JSON.

---

## `DELETE /api/documents/:id`

Deletes one PDF: its stored bytes, all its chunks, and its metadata. Irreversible.

```json
{ "success": true, "message": "Deleted \"sample.pdf\" and 2 chunk(s).", "chunksDeleted": 2 }
```

Put this behind a confirmation dialog that names the file.

---

## `DELETE /api/documents`

Deletes **everything**. Irreversible.

```json
{ "success": true, "message": "Deleted 3 file(s) and 47 chunk(s).", "filesDeleted": 3, "chunksDeleted": 47 }
```

This must be behind a stronger confirmation than single-file delete.

---

## `POST /api/chat`

Asks a question against the indexed documents.

Request — `Content-Type: application/json`:

```json
{
  "question": "What is the refund policy?",
  "topK": 5,
  "fileIds": ["6aa8300c8e5634ce091f9fb4"]
}
```

- `question`: required, non-empty string, **max 1000 characters**
- `topK`: optional, 1–20, defaults to 5 — how many chunks to retrieve
- `fileIds`: optional array of file ids. When present, only those PDFs are
  searched. Omit it (or send `[]`) to search everything.

Success — **200**:

```json
{
  "success": true,
  "question": "What is the refund policy?",
  "answer": "Customers may request a full refund within 30 days of purchase... [Source 1]",
  "sources": [
    {
      "id": "6aa8300c8e5634ce091f9fb5",
      "fileId": "6aa8300c8e5634ce091f9fb4",
      "filename": "sample.pdf",
      "pageNumber": 1,
      "content": "ACME Corporation Customer Policy Handbook\n1. Refund Policy...",
      "similarity": 0.8206
    }
  ],
  "tookMs": 4305
}
```

**About `similarity`:** it is a normalised cosine score in `[0, 1]` where 1 is
identical. In practice a genuinely relevant chunk scores roughly **0.75–0.90**,
and a weak match still scores around **0.6** — the scale does not start at zero.
So do not render it as a raw percentage bar from 0 to 100; that makes every
result look like a mediocre match. Either label the bands (strong / moderate /
weak) or scale the bar across the useful range.

`sources` is ordered best match first.

When nothing has been uploaded yet, the response still succeeds but adds a
`note` field and `sources` is empty:

```json
{
  "success": true,
  "question": "...",
  "answer": "I don't know based on the provided documents.",
  "sources": [],
  "note": "No documents have been uploaded yet.",
  "tookMs": 32
}
```

A second `note` — `"No chunk matched this question."` — means documents exist but
nothing was close enough. Word the empty state differently for the two cases.

Errors: **400** for an empty or over-long question or a non-array `fileIds`,
**502/503/504** if Ollama fails, errors out, or times out.

**Timing:** typically **1.5–6 seconds**. There is **no streaming** — the answer
arrives complete in one response. A loading state is mandatory.

---

# What to build

A single-page app with three areas. Keep it clean and readable — this project
exists to make the RAG pipeline visible, so the UI should *show* retrieval, not
hide it.

## 1. Chat (the main area)

- Message list: user questions and assistant answers, newest at the bottom,
  auto-scrolled.
- Input box with a send button. Submit on Enter, newline on Shift+Enter.
- Live character counter that warns past 1000 characters and blocks sending.
- While waiting: a typing/thinking indicator, input disabled, and a **Cancel**
  button that aborts the request with `AbortController`.
- Under each answer, show `tookMs` and the number of sources used.
- Show the `note` field as a hint when nothing matched, with a link that jumps to
  the upload panel when the knowledge base is empty.

### Scoping a question to specific PDFs

Above the input, show which documents will be searched: a compact multi-select of
the ready files, defaulting to **all**. Send the chosen ids as `fileIds`. When a
subset is selected, label the input area clearly ("Asking 1 of 3 documents") so
the user understands why an answer might be missing something.

### Sources — this is the important part

Under every answer, render a collapsible **Sources** section:

- One card per source, headed by **`filename` · page `pageNumber`** — that
  citation is the most valuable thing on the screen. `pageNumber` can be `null`
  for a PDF whose parser produced no page breakdown; fall back to the filename
  alone rather than printing "page null".
- Show `similarity` per the banding note above.
- `content` can be ~900 characters — truncate to ~200 with a "show more" toggle.
- Link the filename to `GET /api/documents/:fileId/download` so the user can open
  the original PDF and check the claim themselves.
- Make it obvious this is the exact text the model was given. That is what makes
  the answer auditable.

Optionally let the user set `topK` with a small slider (1–20) so they can watch
retrieval quality change.

## 2. Upload panel

- Drag-and-drop zone plus a click-to-browse fallback.
- Validate **client-side before sending**: extension is `.pdf`, size <= 20 MB,
  size > 0. Show the error immediately instead of a round trip.
- While uploading, show a real progress bar (see the `XMLHttpRequest` note below)
  and then an indeterminate "Indexing… embedding chunks" state, because the
  server keeps working long after the bytes finish arriving.
- On success show a summary: filename, pages, characters, chunks stored.
- If `deduplicated` is true, say so plainly: "Already indexed — showing the
  existing document."
- On failure show the server's `error` string verbatim — the backend messages are
  already written for humans.
- Refresh the document list and `stats` after a successful upload.

## 3. Document / knowledge base panel

- Header from `stats`: "3 documents · 47 chunks indexed".
- Paginated list of **files**, each row showing filename, page count, chunk count,
  formatted size, a relative timestamp ("2 minutes ago"), and a status pill.
- A `failed` row shows its `error` text and offers re-upload.
- Per row: **View chunks** (expands, loading from `/:id/chunks` on demand),
  **Download** (opens the original PDF), and **Delete** behind a confirmation
  dialog naming the file.
- A "Clear knowledge base" button wired to `DELETE /api/documents`, behind a
  stronger confirmation that states it deletes every document and cannot be
  undone.

## 4. Health indicator

- A small badge in the header: green when `success` is true, red otherwise.
- On hover or click, show which of MongoDB / Ollama is down, plus the database
  name and the model names.
- Poll `/api/health` every 30 seconds.
- When the backend is unreachable at all (network error), show a clear banner:
  "Cannot reach the backend at <URL>. Is it running?" — do not let the app look
  broken for what is just a stopped server.

---

# Project structure

```text
rag-frontend/
│
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   │
│   ├── api/
│   │   └── client.js            all fetch calls live here, nowhere else
│   │
│   ├── components/
│   │   ├── Header.jsx
│   │   ├── HealthBadge.jsx
│   │   ├── UploadPanel.jsx
│   │   ├── DocumentList.jsx
│   │   ├── DocumentRow.jsx      one file: status, actions, expandable chunks
│   │   ├── FileScopePicker.jsx  choose which PDFs a question searches
│   │   ├── ChatWindow.jsx
│   │   ├── MessageBubble.jsx
│   │   ├── SourceList.jsx
│   │   └── ConfirmDialog.jsx
│   │
│   ├── hooks/
│   │   ├── useHealth.js
│   │   ├── useDocuments.js
│   │   └── useChat.js
│   │
│   ├── utils/
│   │   └── format.js            bytes, similarity bands, relative time
│   │
│   └── styles/
│       └── index.css
│
├── .env
├── .env.example
├── .gitignore
├── index.html
├── vite.config.js
├── package.json
└── README.md
```

Rule: **components never call `fetch` directly.** Every network call goes through
`src/api/client.js`, and components consume the hooks.

---

# Environment variables

Vite only exposes variables prefixed with `VITE_`.

`.env`:

```env
VITE_API_BASE_URL=http://localhost:5000
```

Read it as `import.meta.env.VITE_API_BASE_URL` with a fallback to
`http://localhost:5000`. Never hardcode the URL in components.

Add `.env` and `node_modules/` and `dist/` to `.gitignore`, and commit a
`.env.example`.

---

# Technical requirements

- **React 18+ with Vite**, function components and hooks only. No class
  components, no Redux, no react-query — plain `useState` / `useEffect` /
  `useCallback` and three custom hooks is enough and keeps it readable.
- Use **native `fetch`**. Do not add axios.
- Styling: **plain CSS** in `src/styles/index.css` or CSS Modules. Do not pull in
  a component library. A clean, minimal, readable layout beats a heavy theme.
- No routing library — this is one page.
- The app must work at phone width. The three panels stack vertically on narrow
  screens.
- Support light and dark via `prefers-color-scheme`, using CSS custom properties.
- Basic accessibility: real `<button>` elements, labels on inputs, `aria-live` on
  the message list so answers are announced, visible focus rings.

## Gotchas — get these right

1. **All ids are opaque 24-character hex strings.** Use them as React keys and
   path segments as-is. Never `parseInt` an id, never sort by it, and never
   assume it is a number — this backend has no integer ids anywhere.

2. **FormData and Content-Type.** When uploading, build a `FormData` and append
   under the key `file`. **Do not set the `Content-Type` header yourself** — the
   browser must set it so it can include the multipart boundary. Setting it
   manually breaks the upload.

3. **Upload progress needs XHR.** `fetch` cannot report upload progress. If you
   want a real progress bar, use `XMLHttpRequest` with `xhr.upload.onprogress`
   for the upload call only, and `fetch` everywhere else. Wrap it in a promise so
   `client.js` still exposes a clean `async` function.

4. **Progress is not completion.** The progress bar reaching 100% only means the
   bytes arrived. The server then extracts, chunks, and embeds — which is by far
   the slower half. Switch to an indeterminate "Indexing…" state at 100%, not a
   success state.

5. **Abortable chat.** Chat can take 6+ seconds. Pass an `AbortSignal` to the
   fetch, and abort it on a Cancel click and on component unmount. Ignore
   `AbortError` — it is not a failure to show the user.

6. **Parse errors uniformly.** Write one helper in `client.js` that reads the
   response, and if `!res.ok` or `!body.success`, throws an `Error` carrying
   `body.error` and the status code. A network-level failure (backend not
   running) throws before you get a body — handle that separately with a clear
   "backend unreachable" message.

7. **The download endpoint is not JSON.** `GET /api/documents/:id/download`
   returns raw PDF bytes. Open it with an `<a href>` or `window.open`, never
   through the JSON helper — that helper will choke trying to parse it.

8. **Don't render `sources[].content` as HTML.** It is raw text extracted from a
   user's PDF. Render it as text, preserving newlines with
   `white-space: pre-wrap`.

9. **`createdAt` is a UTC ISO string.** Convert to local time for display. Note
   the field is camelCase now, not `created_at`.

10. **A just-uploaded document may not be searchable for a moment.** The vector
    index is eventually consistent — normally well under a second. If a question
    asked immediately after an upload returns no sources, that is expected
    behaviour, not a bug; a brief "indexing just finished, try again" hint beats
    an error.

11. **Empty states matter.** Handle all four: no documents uploaded, no messages
    yet, an answer with zero sources, and a document whose ingestion `failed`.

---

# README

Write a `README.md` covering:

1. What the app does and a description of the three panels
2. Prerequisites — the RAG backend must be running first
3. Installation and `npm run dev`
4. The `VITE_API_BASE_URL` variable and how to point it at a different port
5. The API contract it consumes (a short table of the nine endpoints)
6. How to test each flow manually: upload a PDF, ask a question, read the
   sources, scope a question to one file, download an original, delete one
   document, clear the knowledge base
7. Known limits: no streaming, no conversation memory (each question is
   independent), no auth, 20 MB upload cap, synchronous upload

---

# Important implementation instruction

Before writing code:

1. Check the installed Node.js version (Vite needs 18+).
2. Check whether a `package.json` or a frontend folder already exists; do not
   overwrite working code.
3. Reuse existing dependencies where possible, add only what is missing, and
   explain every dependency you add.

**Verify the backend is up before you start** so you are testing against the real
API rather than guessing:

```bash
curl http://localhost:5000/api/health
```

After implementation, test the complete flow end to end against the running
backend and fix anything that breaks:

```text
health badge turns green (mongodb + ollama both reachable)
        ↓
upload a PDF (use the sample.pdf in the backend repo)
        ↓
document appears in the list with status "ready", page and chunk counts
        ↓
expand it and confirm the chunk previews load
        ↓
ask a question about the PDF
        ↓
answer renders with sources showing filename and page number
        ↓
scope the question to that one file with fileIds and confirm it still answers
        ↓
ask something the PDF does not cover
        ↓
"I don't know based on the provided documents." renders correctly
        ↓
download the original PDF from a source card
        ↓
delete that single document and confirm it disappears
        ↓
clear the knowledge base and confirm the empty state
```

Also verify the failure paths by hand: upload a `.txt` file, upload a >20 MB
file, upload the same PDF twice (expect the deduplicated message, not an error),
send a 1001-character question, request a bogus document id, and stop the backend
and confirm the "unreachable" banner appears.

At the end, show me:

1. Files created
2. Dependencies installed and why
3. How to run it
4. What you tested and the result of each check

---

# Note on the backend port

The backend's `.env` sets `PORT=5000`, but on **macOS** the "AirPlay Receiver"
service also listens on port 5000 and answers every request with an empty `403`,
so requests never reach Express. If `curl http://localhost:5000/api/health`
returns an empty 403, either turn off AirPlay Receiver in *System Settings →
General → AirDrop & Handoff*, or run the backend with `PORT=5001` and set
`VITE_API_BASE_URL=http://localhost:5001` to match.
