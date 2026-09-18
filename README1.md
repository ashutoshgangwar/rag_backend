# RAG Backend — Project Overview + Interview Q&A (Hinglish)

---

## Part 1: Project Overview

### Ek line mein
Ye ek **Retrieval-Augmented Generation (RAG) backend** hai — Express.js + MongoDB Atlas Vector Search + Ollama (local LLM). User resume PDFs upload karta hai, system unhe chunks mein todke embeddings banata hai, aur phir user in documents ke upar natural language mein sawaal pooch sakta hai. Saath mein ek **AI Agents** module hai (Study Q&A, Email Writer, Trip Planner, etc.) aur **JWT-based auth** (signup/login).

### Kyun banaya?
LLM ko sirf wahi pata hota hai jo uske training data mein tha. Tumhara PDF usne kabhi nahi dekha — poochoge to confidently kuch bhi bana dega (hallucination). RAG isko fix karta hai: pehle relevant text dhundo, phir LLM ko bolo "sirf is text se answer do".

### Tech Stack

| Layer | Technology | Kaam |
| --- | --- | --- |
| Server | Node.js + Express 5 | REST API |
| Database | MongoDB Atlas | files, chunks, users, agents, agent_runs |
| Vector Search | Atlas `$vectorSearch` (HNSW, cosine) | semantic search |
| File storage | GridFS (`pdfs` bucket) | original PDF bytes |
| LLM | Ollama → `llama3.2:latest` | answer generate karna |
| Embeddings | Ollama → `nomic-embed-text` (768-dim) | text → vector |
| PDF parsing | `pdf-parse` v2 | per-page text nikalna |
| Upload | `multer` (memory storage) | multipart/form-data |
| Auth | `bcryptjs` + `jsonwebtoken` | password hashing + JWT |

**Koi LangChain nahi, koi OpenAI nahi, koi vector-store library nahi** — pura pipeline haath se likha hai, taaki har step samajh aaye.

### Architecture (Layering)

```
routes/       → URL wiring (+ multer, requireAuth)
controllers/  → input validate, JSON response shape
services/     → asli business logic (RAG, ingestion, auth, agents)
utils/        → pure functions (chunking, pdf parse, resume classifier, validators)
middleware/   → auth gate, central error handler (ApiError, asyncHandler)
config/db.js  → MongoClient, collections, GridFS, index creation
agents/       → agent catalog (form fields + system prompts)
```

### Ingestion Flow — `POST /api/documents/upload`

```
PDF → SHA-256 hash (duplicate? to wahi return karo)
    → text extract (per page)
    → resume classifier (resume nahi hai? → 422, kuch bhi store nahi hota)
    → GridFS mein original bytes store
    → files collection mein entry (status: processing)
    → per page chunking (~900 chars, 150 overlap)
    → har chunk ka embedding (4 at a time, Ollama)
    → chunks collection mein insertMany (content + embedding + fileId + pageNumber)
    → status: ready   (fail hua to status: failed + chunks cleanup)
```

### Retrieval Flow — `POST /api/chat`

```
question → embed (same nomic model!)
         → $vectorSearch (topK=5, numCandidates=topK*20, optional fileId filter)
         → numbered context: [Source 1 | file.pdf, page 2]
         → strict prompt ("ONLY context se answer do, warna 'I don't know...'")
         → llama3.2 (temperature 0.2)
         → answer + sources (similarity score ke saath)
```

### Resume Classifier (2-tier)
1. **Heuristic** — sections (experience, education, skills, projects...), contact details (email, phone, LinkedIn, GitHub), negative signals (bank statement, invoice, Aadhaar, offer letter...), length. Zyada tar files yahin decide ho jaati hain — free aur instant.
2. **LLM** — sirf "unsure" wale cases ke liye. Yes/No nahi poochte, balki **label** maangte hain (RESUME / LETTER / STATEMENT / ID / ARTICLE / OTHER), kyunki yes/no pe llama3.2 har cheez ko resume bol deta tha.

### AI Agents Module
- 10 built-in agents, 3 groups (Education, Corporate & Work, Plans & Ideas).
- Har agent ka ek **form** (fields: text/select/number/textarea) + ek server-side **system prompt**.
- `POST /api/agents/:agentId/run` → form validate → prompt build → llama3.2 → `agent_runs` mein save.
- `POST /api/agents/runs/:runId/messages` → follow-up (last 6 messages history ke saath, max 40 messages).
- Sirf `code` agent ko code blocks allowed hain; baaki agents ke answer se code fences hata diye jaate hain.
- Ye RAG use nahi karte — context sirf wahi hai jo user ne form mein bhara.

### Auth
- Signup: company account (fullName, email, phone, companyName, designation, employeeStrength, industry) + bcrypt hash (12 rounds).
- Login: email **ya** phone + password → JWT (7 din).
- `requireAuth` middleware: Bearer token verify + DB mein user abhi bhi exist karta hai ya nahi check.

### Main API Endpoints

| Method | Path | Kaam |
| --- | --- | --- |
| GET | `/api/health` | MongoDB + Ollama reachability |
| POST | `/api/auth/signup`, `/login` | account banao / login |
| GET | `/api/auth/me` | current user |
| POST | `/api/documents/validate` | dry-run: ye PDFs resume hain? (kuch store nahi) |
| POST | `/api/documents/upload` | ingest (multiple files, field `files`) |
| GET | `/api/documents`, `/:id`, `/:id/chunks`, `/:id/download` | list / detail / chunks / original PDF |
| DELETE | `/api/documents/:id`, `/api/documents` | ek file ya sab kuch delete |
| POST | `/api/chat` | RAG question-answer |
| GET | `/api/agents` | agents list |
| POST | `/api/agents/:agentId/run` | agent run |
| POST | `/api/agents/runs/:runId/messages` | follow-up |

---

## Part 2: Interview Questions & Answers (Hinglish)

### A. RAG Basics

**1. RAG kya hota hai? Simple words mein samjhao.**
RAG = Retrieval-Augmented Generation. LLM ko direct sawaal dene ki jagah, pehle apne documents mein se relevant text dhundte hain (retrieval), phir wo text prompt mein daal ke LLM se answer banwate hain (generation). Isse LLM "knowledge base" nahi rehta, balki ek "reading comprehension engine" ban jaata hai jo diye gaye text ko padh ke answer deta hai.

**2. RAG ki zarurat kyun padi? Fine-tuning kyun nahi kiya?**
Fine-tuning mehenga hai, GPU chahiye, aur har naye document pe dobara train karna padta. RAG mein naya PDF upload karo, turant searchable. Saath hi RAG mein **sources** milte hain — answer kis page se aaya dikha sakte hain. Fine-tuned model ye nahi bata sakta aur hallucinate bhi kar sakta hai.

**3. Tumhare project mein RAG ke do main phases kaunse hain?**
- **Ingestion** (upload time): PDF → text → chunks → embeddings → MongoDB.
- **Retrieval + Generation** (question time): question → embedding → `$vectorSearch` → top chunks → prompt → llama3.2 → answer.

**4. Hallucination ko kaise control kiya?**
Teen cheezein: (1) strict prompt — "ONLY provided context se answer do, nahi mila to bolo *I don't know based on the provided documents*", (2) `temperature: 0.2` taaki model creative na ho, (3) agar koi chunk hi match nahi hua to LLM ko call hi nahi karte, seedha fallback message return karte hain.

**5. LangChain kyun use nahi kiya?**
Learning aur control ke liye. LangChain bahut kuch abstract kar deta hai — chunking, embeddings, vector store sab black box ban jaata hai. Yahan har step (chunking, embedding, `$vectorSearch`, prompt) apne code mein hai, to debug karna aur tune karna aasan hai. Dependencies bhi kam hain.

### B. Embeddings & Vector Search

**6. Embedding kya hota hai?**
Text ko numbers ke array (vector) mein convert karna, aise ki **similar meaning wale texts ke vectors paas-paas** hon. `nomic-embed-text` har text ke liye 768 numbers deta hai. "Refund within 30 days" aur "How do I get my money back" ke vectors close honge, jabki "Shipping costs $15" door hoga.

**7. 768 dimension kahan se aaya aur ye important kyun hai?**
`nomic-embed-text` model hamesha 768-dim vector deta hai. Atlas vector index mein `numDimensions: 768` set hai — dono match hone chahiye. Isliye `embedding.service.js` mein `assertVector()` write time pe hi length aur NaN check karta hai. MongoDB galat length ka array chup-chaap store kar leta, error sirf `$vectorSearch` pe aata — jo debug karna mushkil hai.

**8. Question aur chunks ke liye same embedding model kyun zaroori hai?**
Har embedding model ka apna alag "vector space" hota hai. Agar chunks model A se aur question model B se embed kiya, to unke beech distance ka koi matlab nahi — random results aayenge. Isi wajah se embedding model badalna ho to **saare chunks re-embed** karne padenge.

**9. Cosine similarity kya hai aur yahi kyun choose kiya?**
Cosine do vectors ke beech ka angle (direction) compare karta hai, length ignore karta hai. Text ke liye yahi chahiye — ek lamba paragraph aur ek chhota sentence same topic pe ho to same direction mein point karenge, bhale magnitude alag ho.

**10. Atlas ka `vectorSearchScore` kis range mein aata hai?**
Cosine ke liye Atlas score ko normalize karta hai: `(1 + cosine) / 2`, to range `[0, 1]` hoti hai, 1 matlab identical. Ye pgvector ke `1 - distance` se alag scale hai, to agar koi similarity threshold lagana ho to dobara tune karna padega.

**11. `numCandidates` aur `limit` mein kya fark hai?**
`limit` = kitne final results chahiye (topK = 5). `numCandidates` = Atlas kitne approximate neighbours dekhega ranking se pehle. Hum `topK * 20` rakhte hain (max 1000). Kam rakhoge to recall girega (sahi chunk miss ho sakta hai), zyada rakhoge to slow.

**12. Vector index ki zarurat kyun? Sab vectors se compare kar lete.**
Brute force O(n) hai — har query pe har chunk se compare. Lakhon chunks pe slow. Atlas **HNSW** (Hierarchical Navigable Small World) graph banata hai jo approximate nearest neighbours roughly logarithmic time mein deta hai. Thoda accuracy trade hota hai, speed bahut milti hai.

**13. `$vectorSearch` ke saath `$match` pehle kyun nahi laga sakte?**
`$vectorSearch` pipeline ka **first stage** hona compulsory hai. Filter karna ho to stage ka apna `filter` option use karna padta hai — aur wo sirf un fields pe kaam karta hai jo index mein `type: "filter"` declare hain. Isliye humne `fileId` ko filter field banaya, jisse "sirf is PDF mein search karo" possible hai.

**14. Response mein embedding kyun nahi bhejte?**
768 doubles ≈ 6 KB per chunk. Bhej diya to response actual content se kai guna bada ho jaayega aur kisi kaam ka nahi. `$project` mein `embedding` exclude kiya hai, aur `listChunks` mein `projection: { embedding: 0 }`.

**15. Vector index eventually consistent hai — iska kya matlab?**
Chunk insert karte hi wo turant searchable nahi hota — Atlas background mein index update karta hai (usually < 1 sec). Upload ke turant baad question poochoge to rare case mein naya chunk miss ho sakta hai. Ye upload-then-ask flow ka ek known seam hai.

**16. Storage kaise optimize kar sakte ho?**
Abhi embedding BSON array of doubles hai (~6 KB/chunk). `Binary.fromFloat32Array()` se float32 binary vector store karo to ~4x chhota ho jaata hai, recall pe almost koi farak nahi. Aur aage jaake quantization (int8) bhi option hai.

### C. Chunking

**17. Chunking kyun karte hain? Pura PDF ek vector mein kyun nahi?**
Ek embedding = ek vector. 50 page ka pura PDF ek vector mein daaloge to wo sab topics ka "average" ban jaayega aur kisi bhi specific sawaal se achhe se match nahi karega. Chhote chunks (~900 chars) mein ek-ek idea hota hai, to matching precise hoti hai.

**18. Overlap kyun rakha (150 chars)?**
Agar koi sentence do chunks ke boundary pe kat gaya to dono aadhe tukdon ka meaning kho jaata. Pichle chunk ke last 150 characters agle chunk ke start mein repeat karne se wo context bach jaata hai.

**19. Chunk size kaise decide kiya? Bada ya chhota rakhne ka kya effect?**
Chhota chunk → precise match, par context kam (LLM ko adhoori baat milti hai). Bada chunk → context zyada, par vector diluted aur prompt lamba. 900/150 ek balanced default hai; `.env` mein `CHUNK_SIZE`, `CHUNK_OVERLAP` se tune kar sakte ho.

**20. Chunk word ke beech mein na kate, iske liye kya kiya?**
`chunkText.js` window ke last 40% hisse mein `. `, `\n` ya space dhundta hai aur wahan cut karta hai. Agar koi boundary 60% se pehle hai to ignore karta hai, warna chunk bahut chhote ban jaate. Aur `start` hamesha aage badhta hai taaki infinite loop na ho.

**21. Per-page chunking kyun kiya?**
Taaki har chunk ke paas asli `pageNumber` ho aur answer cite kar sake "file.pdf, page 3". Trade-off: jo paragraph page break pe bata hai uska overlap us boundary pe nahi milta. Accurate citation zyada important laga.

**22. Letter-spacing wali problem kya thi?**
Kuch PDFs (design tools se export) har letter ke baad space daal dete hain: "D e s i g n e d". Embedding model ko single letters dikhte hain, chunk kisi se match nahi karta. `undoLetterSpacing()` aisi lines detect karta hai (≥8 tokens, ≥60% lone letters) aur spaces hata deta hai. Real test mein similarity 0.40 → 0.77 ho gayi. Code listings jaisi lines ("if ( a > b )") ko chhoda jaata hai kyunki wahan lone letters nahi, symbols hote hain.

**23. `cleanText()` kya kya karta hai?**
`\r\n` → `\n`, NUL bytes hatata hai, letter-spacing repair, multiple spaces/tabs ko ek space, 3+ blank lines ko 2, aur line ke end pe hyphen se tute words ("manage-\nment") ko jodta hai.

### D. Ingestion & Storage

**24. GridFS kya hai aur use kyun kiya?**
MongoDB ka ek document max 16 MB ka ho sakta hai. GridFS badi files ko chhote chunks mein todke do collections (`pdfs.files`, `pdfs.chunks`) mein store karta hai. Original PDF isliye rakhte hain taaki baad mein download ho sake ya naye chunking settings ke saath re-process ho sake.

**25. Upload file disk pe kyun nahi save karte?**
`multer.memoryStorage()` use kiya — file RAM mein aati hai aur seedha GridFS mein stream hoti hai. Koi temp file cleanup nahi, aur user ka filename kabhi file path nahi banta, to **path traversal** attack ka risk hi nahi.

**26. Duplicate upload kaise handle kiya?**
Poori file ka SHA-256 hash nikalte hain. `files` collection pe `sha256` ka **unique index** hai. Same hash `ready` status mein mila to wahi document return kar dete hain (`deduplicated: true`) — embedding dobara nahi chalti, jo sabse mehenga step hai. Agar pichla attempt `failed` tha to use saaf karke dobara try.

**27. Ingestion beech mein fail ho jaaye to kya hota hai?**
File ka status `processing` se `failed` ho jaata hai aur `error` field mein reason save hota hai. Jo chunks already insert ho gaye the unhe `deleteMany({ fileId })` se hata dete hain — warna wo search mein aate aur kisi ready file se linked nahi hote.

**28. Resume check GridFS store karne se PEHLE kyun hota hai?**
Agar pehle store karte aur baad mein reject karte, to har rejected file ke bytes GridFS mein orphan pade rehte. Pehle text extract → classify → reject ho to kuch bhi store nahi hota.

**29. `/validate` endpoint hai to `/upload` mein dobara check kyun?**
`/validate` sirf UI ki convenience hai (file select karte hi batana). Koi bhi seedha `/upload` pe POST karke validate skip kar sakta hai. Isliye asli enforcement `ingestPdf` → `assertIsResume()` ke andar hai. Rule: **client-side check pe kabhi bharosa mat karo.**

**30. Multiple files mein ek fail ho jaaye to?**
Har file independently process hoti hai aur `results[]` mein uska `outcome` aata hai: `ingested`, `duplicate`, `rejected` ya `failed`. Ek kharab file poore batch ko fail nahi karti.

**31. Delete karte waqt order kya hai aur kyun?**
MongoDB mein `ON DELETE CASCADE` nahi hai, to manually teen delete: pehle **chunks**, phir **GridFS blob**, phir **file metadata**. Chunks pehle isliye kyunki orphan chunk `$vectorSearch` mein aata rahega — wo zyada bura hai ek bina chunks wali file se.

**32. Embedding ek saath sab chunks ki kyun nahi (Promise.all)?**
Ollama local machine pe ek hi model instance chalata hai. 500 requests ek saath bhejoge to sirf queue lagegi aur memory badhegi. `embedMany` 4-4 ke batch mein bhejta hai, progress log karta hai, aur fail hone pe exact chunk number batata hai.

### E. Resume Classifier

**33. Resume classifier 2-tier kyun banaya? Sirf LLM kyun nahi?**
LLM har file pe kuch seconds leta. Zyada tar files heuristic se clearly resume ya clearly non-resume hoti hain — unpe LLM time waste hai. LLM sirf "grey band" (unsure) cases pe chalta hai. Fast + sasta + accurate.

**34. LLM se "Is this a resume? yes/no" kyun nahi poocha?**
Yes/no pe llama3.2 ka **yes-bias** tha — jis bhi document mein "education" ya "skills" likha ho usko resume bol deta. Ek textbook chapter ko resume bola, explain karte hue ki ye textbook hai! Forced-choice labels (RESUME/LETTER/STATEMENT/ID/ARTICLE/OTHER) se ye bias hat gaya. Sirf `RESUME` label pass hota hai.

**35. Ollama down ho to classifier kya karta hai?**
Upload block nahi hota. `heuristicFallback()` chal jaata hai — heuristic score ≥ 4 to pass, warna reject, confidence 0.55. LLM ka output parse na ho ya invalid label ho tab bhi yahi fallback.

**36. Scanned resume ka kya hota hai?**
200 chars se kam text nikla to `needsOcr: true` return hota hai — "not a resume" nahi bolte, kyunki wo resume ho sakta hai, bas text nahi hai. User ko clear message milta hai ki OCR karke upload karo.

**37. Section groups ek hi baar kyun count hote hain?**
"Work Experience" heading "experience" regex se bhi match karti. Agar raw keywords count karte to score artificially badh jaata. Har **concept group** (experience, education, skills...) max ek point deta hai.

### F. LLM / Ollama

**38. Ollama kyun choose kiya, OpenAI kyun nahi?**
Privacy (resume jaise personal data machine se bahar nahi jaata), zero API cost, koi API key nahi. Trade-off: local hardware pe speed kam, aur llama3.2 (3B) GPT-4 jitna smart nahi.

**39. Ollama ke saath communication kaise hota hai?**
Native `fetch` se HTTP: `/api/generate` (answer) aur `/api/embed` (vector). `stream: false` taaki ek complete JSON aaye. Sab calls `callOllama()` se jaati hain jisme `AbortController` se 120s timeout hai, aur errors clean `ApiError` mein convert hote hain (timeout → 504, unreachable → 503, 404 → "model pull karo" hint).

**40. Temperature kya hai? RAG mein 0.2, classifier mein 0, agents mein 0.4 kyun?**
Temperature randomness control karta hai. RAG mein 0.2 — context ke kareeb raho. Classifier mein 0 — deterministic label chahiye. Agents (email, trip plan) mein 0.4 — thodi creativity chahiye, par zyada nahi.

**41. `num_ctx` kya hai aur agents mein 8192 kyun?**
Model ka context window (kitne tokens ek baar mein dekh sakta hai). Agents mein system prompt + form brief + 6 messages history + naya question — lamba ho sakta hai, isliye 8192. Default chhota hota to shuru ka prompt kat jaata.

### G. Agents Module

**42. Agents aur RAG chat mein kya fark hai?**
RAG chat documents se context laata hai (`$vectorSearch`). Agents mein koi embedding/search nahi — context sirf user ka bhara hua form + system prompt hai. Agents ek tarah se "structured prompt templates" hain.

**43. Agent catalog DB mein kaise jaata hai?**
Startup pe `ensureAgents()` `bulkWrite` se har agent ko `id` pe **upsert** karta hai. `$set` sirf catalog ke fields update karta hai, `$setOnInsert` se `createdAt` sirf pehli baar. Isse DB mein manually add kiye extra fields restart pe bhi bache rehte hain.

**44. System prompt frontend ko kyun nahi bhejte?**
`toPublicAgent()` `systemPrompt`, `enabled`, `order`, `_id` hata deta hai. System prompt internal implementation hai — expose karne se prompt-injection ke liye hints milte hain aur business logic leak hota hai.

**45. Form input validation kaise hota hai?**
`validateInput()` agent ke `fields` definition se har field check karta hai: required, select options mein hai ya nahi, number min/max, text max 300, textarea max 6000, total max 12000 chars. Saare errors ek saath `fields` object mein return hote hain taaki UI har field ke neeche error dikha sake. Unknown keys ignore.

**46. `normalizeAnswer()` kya karta hai?**
LLM ka markdown frontend ke supported subset mein laata hai: saare headings `## `, `*`/`•` bullets → `- `, bold `**` hataana (inline code chhod ke), 3+ blank lines collapse. Aur agar agent ko code allowed nahi hai to poore ``` code blocks hata deta hai.

**47. Follow-up mein ek user dusre ka run kaise nahi dekh sakta?**
Query `{ _id, userId }` pe hoti hai. Dusre ka run ho to "not found" (404) — "forbidden" nahi bolte, taaki ye bhi pata na chale ki wo run exist karta hai. Aur user message DB mein tabhi push hota hai jab model answer de de — fail hone pe history mein adhoora sawaal nahi latakta.

### H. Auth & Security

**48. Password kaise store karte ho?**
bcrypt hash, 12 rounds (salt automatically included). Plain password kabhi store nahi hota. `toPublicUser()` har response se `passwordHash` hata deta hai.

**49. Login mein "user not found" aur "wrong password" ka same message kyun?**
**User enumeration** rokne ke liye — warna koi bhi check kar sakta hai kaunsa email registered hai. Saath hi user na mile tab bhi ek `DUMMY_HASH` se `bcrypt.compare` chalate hain, taaki response time bhi same rahe (**timing attack** se bachaav).

**50. JWT verify karne ke baad bhi DB mein user check kyun?**
JWT stateless hai — account delete ho jaaye tab bhi token 7 din valid rehta. `requireAuth` token ke `sub` se user DB mein dhundta hai; nahi mila to 401.

**51. Duplicate signup race condition kaise handle kiya?**
Pehle `assertIdentifiersAreFree()` se check (achha error message ke liye). Par do requests ek saath aayein to dono pass ho sakti hain — isliye asli guarantee `email` aur `phone` ke **unique indexes** hain. Insert pe error code 11000 aaye to use proper 409 message mein translate karte hain.

**52. Phone number se login mein country code na ho to?**
`phoneNational` field alag store hoti hai. Country code ke bina number aaya to national digits se match. Agar do accounts (alag countries) match ho gaye to guess nahi karte — 409 dete hain "country code include karo".

### I. Error Handling, Reliability, Design

**53. Error handling ka pattern kya hai?**
`ApiError(status, message, details)` custom class. `asyncHandler` async errors ko Express ke `next()` tak pahunchata hai. Ek central `errorHandler` sab errors ko consistent JSON mein badalta hai — multer errors (file too large, too many files), Mongo duplicate key (11000) sab yahin handle.

**54. Database connect na ho to server kya karta hai?**
Server start ho jaata hai aur background mein retry karta rehta hai. Tab tak koi request aaye to `getDb()` **503** deta hai (500 nahi) — 503 matlab "baad mein try karo". `/api/health` se status dekh sakte ho.

**55. Startup pe vector index ka wait kyun?**
Atlas search index asynchronously banata hai (`QUEUED → BUILDING → READY`). Ready hone se pehle query karo to fail. Server index `queryable` hone tak (max 120s) wait karta hai, taaki pehla upload/chat race mein na phase. Pehli baar boot ~30s leta hai.

**56. Is project mein kya improve karoge? (honest answer)**
- **Documents aur chat routes pe abhi auth nahi hai** — `requireAuth` lagana aur files/chunks pe `userId` add karke multi-tenant banana (vector index mein `userId` filter field).
- Rate limiting aur `helmet` security headers.
- Ingestion ko background queue (BullMQ) mein daalna — abhi request tab tak rukti hai jab tak saare embeddings na ban jaayein.
- Streaming answers (`stream: true` + SSE) better UX ke liye.
- **Hybrid search**: vector + keyword (Atlas `$search`) + re-ranking.
- OCR (Tesseract) scanned resumes ke liye.
- Float32 binary vectors storage ke liye.
- Tests (chunking, classifier, validators pure functions hain — unit test karna aasan).

**57. Isko scale kaise karoge — 1 lakh resumes?**
Ingestion ko async worker queue mein, Ollama ko GPU server pe ya multiple instances, embeddings batch mein. Atlas dedicated search nodes. Binary/quantized vectors se storage kam. Per-user filter taaki search space chhota ho. Frequently asked questions ka cache.

**58. RAG ki quality kaise measure karoge?**
Retrieval ke liye: test questions ka set banao jinke sahi chunks pata hon, phir **recall@k** aur **MRR** nikalo. Generation ke liye: faithfulness (answer context se hai ya nahi), answer relevance — manual review ya LLM-as-judge. Response ke `sources` aur `similarity` debugging mein bahut kaam aate hain.

---

### Quick Revision (interview se pehle 2 minute)

- RAG = retrieve relevant chunks + LLM ko sirf unse answer karwao.
- Chunk 900 / overlap 150, per page, word boundary pe cut.
- `nomic-embed-text` → 768-dim, cosine, same model for query + chunks.
- `$vectorSearch` first stage, `numCandidates = topK × 20`, `fileId` filter field.
- SHA-256 dedup, GridFS for originals, resume gate before storing.
- 2-tier classifier: heuristic → LLM labels (yes/no nahi).
- bcrypt 12 rounds, JWT 7d, dummy hash se timing attack protection.
- Delete order: chunks → GridFS → metadata.
