// A scripted agent run, written exactly the way a real model would stream it:
// prose with inline <board .../> ops placed right after the words they draw.
// Ops: project, phase, task, node, part, edge, status, decision (see src/engine/board.js apply()).
// Each decision names the check that will prove it (verify); verification reports the proof.
// The guided tour adds a command prompt (ask) and checkpoints (tour); the plain demo plays through them.
// Split in two like a live run: the plan, then (after the user approves) the build.
// Decisions carry the reasoning: what was chosen, over what, why, and what it builds on.

export const PLAN_SCRIPT = `<board op="project" name="DocQA · chat with your PDFs" goal="People upload PDFs and ask questions; every answer cites the page it came from."/><board op="phase" name="planning"/>Planning: upload PDFs, ask questions<board op="task" id="p1" phase="planning" text="Upload PDFs, ask questions" status="done"/>, every answer cites its page<board op="task" id="p2" phase="planning" text="Answers cite their page" status="done"/>.

Parts: a web client<board op="node" id="web" name="Web client" kind="client" col="0" row="0" libs="React 18, pdf.js 4" api="Upload page, Chat view" paths="web/"/><board op="part" id="web.upload" of="web" name="Upload page" kind="page" links="api.documents: POST /documents"/><board op="part" id="web.chat" of="web" name="Chat view" kind="page" links="api.ask: POST /ask; web.viewer: open the cited page"/><board op="part" id="web.viewer" of="web" name="PDF page viewer" kind="view (pdf.js)"/>, an API server<board op="node" id="api" name="API server" col="1" row="0" libs="FastAPI 0.115, Python 3.12" api="POST /documents, POST /ask" paths="api/"/><board op="part" id="api.documents" of="api" name="POST /documents" kind="route" links="s3.pdfs: PutObject; worker.ingest: queue ingest(id)"/><board op="part" id="api.ask" of="api" name="POST /ask" kind="route" links="api.retrieve: the question"/><board op="edge" from="web" to="api" via="HTTP" api="POST /ask {question} → {answer, citations}"/> and a background worker<board op="node" id="worker" name="Ingest worker" col="1" row="1" libs="Celery 5.4, PyMuPDF 1.24" api="ingest(document_id)" paths="worker/"/><board op="part" id="worker.ingest" of="worker" name="ingest(document_id)" kind="job" links="s3.pdfs: read the PDF; worker.chunk: its pages"/><board op="edge" from="api" to="worker" via="queue" api="ingest(document_id) on Redis"/>. Big PDFs take minutes, so ingest runs in the background<board op="decision" id="d1" title="Process uploads inline or in the background" chose="A background worker fed by a job queue" over="Process during the upload request, Serverless function per upload" why="A 300-page PDF takes minutes to chunk and embed; the upload returns at once and the client polls status. Costs one more process and a Redis queue." affects="api, worker" evidence="A 300-page PDF takes minutes to chunk and embed" verify="A 300-page upload returns in under a second while the worker processes it"/>. How big can uploads get?<board op="question" id="q1" text="Largest PDF people will upload?" options="50 MB, 200 MB, No limit" about="d1"/> I'll assume 50 MB. PDFs go to S3<board op="node" id="s3" name="Object storage" kind="data" col="0" row="1" libs="Amazon S3" api="documents/{id}.pdf"/><board op="part" id="s3.pdfs" of="s3" name="documents/{id}.pdf" kind="object"/><board op="edge" from="api" to="s3" via="S3" api="PutObject documents/{id}.pdf"/>.

Chunks of ~500 tokens, each with its page<board op="part" id="worker.chunk" of="worker" name="Chunk ~500 tokens" kind="step" layer="ml" links="worker.embed: chunks + page"/><board op="decision" id="d2" title="How PDFs are split" chose="~500-token chunks, each tagged with its page number" over="One chunk per page, Fixed 1000-character windows" why="Citations need a page for every chunk, and 500 tokens keeps retrieval precise. Whole pages are too long to rank well." affects="worker" evidence="Goal: every answer cites the page it came from" verify="Eval: the right page is retrieved for at least 45 of 50 questions"/>, embedded<board op="part" id="worker.embed" of="worker" name="Embed chunks" kind="model" layer="ml" links="chunks: INSERT rows"/> into pgvector<board op="node" id="vdb" name="Vector index" kind="data" col="2" row="1" libs="pgvector 0.7, Postgres 16" api="chunks(document_id, page, text, embedding vector(1024))" paths="migrations/"/><board op="edge" from="worker" to="vdb" via="SQL" api="INSERT INTO chunks …"/><board op="decision" id="d3" title="Where embeddings live" chose="pgvector inside the Postgres that already holds documents" over="Pinecone, Qdrant" why="One less service to run, secure and back up. An HNSW index keeps search fast up to a few million chunks, which covers the expected corpus." affects="vdb" builds_on="d2" evidence="Postgres already stores the documents, Expected corpus: under 2 million chunks" verify="Search over 2 million chunks stays under 50 ms at p95"/><board op="task" id="p3" phase="planning" text="Chunk → embed → index" status="done"/>: two tables<board op="table" id="documents" name="documents" of="vdb" columns="id uuid pk; filename text; pages int; status text; created_at timestamptz"/><board op="table" id="chunks" name="chunks" of="vdb" columns="id uuid pk; document_id uuid fk>documents.id; page int; text text; embedding vector(1024)"/> and an HNSW index<board op="part" id="vdb.hnsw" of="vdb" name="HNSW index" kind="index" layer="ml" links="chunks: on embedding"/>. Assuming PDFs have text: no OCR<board op="assumption" id="a1" text="PDFs have a text layer: no OCR" about="d2"/>.

To answer: the top 8 chunks<board op="part" id="api.retrieve" of="api" name="Retrieve top 8" kind="step" layer="ml" links="vdb.hnsw: nearest 8 chunks; api.prompt: chunks + pages"/><board op="edge" from="api" to="vdb" via="SQL" api="ORDER BY embedding <=> $q LIMIT 8"/> go to Claude, which cites a page per claim<board op="part" id="api.prompt" of="api" name="Prompt with citations" kind="step" layer="ml" links="llm.answer: question + chunks"/><board op="node" id="llm" name="Claude API" kind="external" layer="ml" col="2" row="0" libs="anthropic SDK, claude-opus-5-5" api="messages.create" paths="api/answer.py"/><board op="part" id="llm.answer" of="llm" name="Write cited answer" kind="model"/><board op="edge" from="api" to="llm" via="HTTPS" api="messages.create (question + top 8 chunks)"/><board op="decision" id="d4" title="Who writes the answer" chose="Claude, given the top 8 chunks and told to cite a page for every claim" over="Return the best-matching passages as-is" why="People want an answer, not eight excerpts; the page numbers from d2 make every sentence checkable." affects="api, llm" builds_on="d2, d3" evidence="Goal: every answer cites the page it came from" verify="20 answers checked by hand: every claim cites the right page"/><board op="task" id="p4" phase="planning" text="Claude writes the answer" status="done"/>.

Two flows: ask<board op="flow" id="ask" name="Ask a question" steps="web>api: POST /ask {question}; api>vdb: top 8 chunks by similarity; api>llm: question + chunks; api>web: answer + page citations"/> and upload<board op="flow" id="upload" name="Upload a PDF" steps="web>api: POST /documents; api>s3: store the PDF; api>worker: ingest(document_id); worker>vdb: chunks + embeddings"/>.

Plan ready: 6 parts, 4 decisions<board op="task" id="p5" phase="planning" text="6 parts, 4 decisions" status="done"/>. Review it, then approve.`;

export const BUILD_SCRIPT = `<board op="phase" name="implementation"/>Building. API server first<board op="status" id="api" v="building"/><board op="task" id="i1" phase="implementation" text="API: upload + ask routes" status="building"/>.<board op="tour" at="build"/> Uploads go to storage<board op="status" id="s3" v="building"/> and queue a job<board op="status" id="s3" v="built"/><board op="diff" id="api"/>.

Worker: chunk and embed<board op="status" id="worker" v="building"/><board op="task" id="i2" phase="implementation" text="Worker: chunk + embed" status="building"/>, then write the index<board op="status" id="vdb" v="building"/>. Done<board op="diff" id="worker"/><board op="diff" id="vdb"/><board op="status" id="worker" v="built"/><board op="status" id="vdb" v="built"/><board op="task" id="i2" status="done"/>.

Ask route: top 8 chunks to Claude<board op="status" id="llm" v="building"/>. Citations work<board op="diff" id="llm"/><board op="status" id="llm" v="built"/><board op="status" id="api" v="built"/><board op="task" id="i1" status="done"/>.

Web client: upload and chat<board op="status" id="web" v="building"/><board op="task" id="i3" phase="implementation" text="Web: upload + chat UI" status="building"/>. Done<board op="diff" id="web"/><board op="diff" id="compose"/><board op="status" id="web" v="built"/><board op="task" id="i3" status="done"/>.

<board op="phase" name="verification"/>Testing.<board op="ask" cmd="pytest -q" why="Run the unit tests to check the code works"/><board op="run" cmd="pytest -q" pass="42" fail="0"/> All 42 unit tests pass<board op="task" id="v1" phase="verification" text="42 unit tests pass" status="done"/><board op="decision" id="d1" proof="pass" proof_by="test_upload_returns_before_ingest: 180 ms for a 300-page PDF"/><board op="status" id="api" v="verified"/><board op="status" id="s3" v="verified"/>.

Now answer quality: an eval set of 50 questions<board op="node" id="eval" name="Eval set (50 Qs)" kind="test" layer="ml" col="0" row="2" libs="pytest 8" paths="eval/"/><board op="part" id="eval.set" of="eval" name="50 questions + pages" kind="dataset" links="api.ask: ask each one; eval.score: answers"/><board op="part" id="eval.score" of="eval" name="Score: right page?" kind="step"/><board op="edge" from="eval" to="api"/><board op="diff" id="eval"/><board op="status" id="eval" v="built"/>.<board op="run" cmd="python eval/run_eval.py" pass="41" fail="9" ok="false"/>

Right page 41 times out of 50<board op="task" id="v2" phase="verification" text="Retrieval: 41/50 (82%)" status="failed"/><board op="status" id="vdb" v="failed"/><board op="decision" id="d2" proof="fail" proof_by="Eval: 41 of 50 answer pages found"/>; the target is 45. Most misses are split tables<board op="status" id="worker" v="failed"/>, so D2 changes: keep tables whole<board op="decision" id="d2" chose="Layout-aware ~500-token chunks that keep tables whole, each tagged with its page" why="The eval found 9 misses, 7 of them tables split across chunks. Keeping a table in one chunk fixes those at the cost of a few larger chunks." evidence="Eval: 41 of 50 answer pages found; 7 of the 9 misses were tables split across chunks"/><board op="tour" at="verify"/><board op="status" id="worker" v="building"/><board op="task" id="v3" phase="verification" text="Fix: keep tables whole" status="building"/><board op="diff" id="tables"/>.<board op="run" cmd="python eval/run_eval.py" pass="47" fail="3" ok="true"/>

Eval again: 47 of 50 found<board op="task" id="v2" text="Retrieval: 47/50 (94%)" status="done"/><board op="decision" id="d2" proof="pass" proof_by="Eval: 47 of 50 answer pages found"/><board op="task" id="v3" status="done"/><board op="status" id="worker" v="verified"/><board op="status" id="vdb" v="verified"/>. Search: 18 ms p95 on 2M chunks<board op="decision" id="d3" proof="pass" proof_by="Load test: p95 search 18 ms on 2M chunks"/>. 20 answers checked by hand: citations right<board op="task" id="v4" phase="verification" text="20 citations checked" status="done"/><board op="decision" id="d4" proof="pass" proof_by="20 answers checked by hand: all citations right"/><board op="status" id="llm" v="verified"/><board op="status" id="web" v="verified"/><board op="status" id="eval" v="verified"/>.

<board op="phase" name="deployment"/>Shipping: containers for the API and worker, a CDN for the web client<board op="task" id="d1" phase="deployment" text="Deploy to staging" status="building"/>. Staging smoke test: a cited answer in 6 seconds<board op="task" id="d1" status="done"/><board op="task" id="d2" phase="deployment" text="Smoke test: 6 s end to end" status="done"/>.

Production<board op="task" id="d3" phase="deployment" text="Production" status="building"/>. DocQA is live<board op="status" id="web" v="live"/><board op="status" id="api" v="live"/><board op="status" id="worker" v="live"/><board op="status" id="s3" v="live"/><board op="status" id="vdb" v="live"/><board op="status" id="llm" v="live"/><board op="task" id="d3" status="done"/><board op="phase" name="complete"/>.

Code is in \`api/\`, \`worker/\` and \`web/\`; I documented the setup in \`README.md\`. Add OCR for scanned PDFs next?

Your turn: change the board, then send it.`;

// What the demo's steps change in its (imaginary) repo: a live run reads this from git.
// Keyed by the step's <board op="diff" id="…"/>; a later step's file replaces an earlier one.
const file = (path, patch) => {
  const lines = patch.split("\n");
  return { path, patch, add: lines.filter((l) => l.startsWith("+")).length, del: lines.filter((l) => l.startsWith("-")).length };
};
export const DEMO_CHANGES = {
  api: [
    file("api/app.py", `@@ -1,7 +1,21 @@
-from fastapi import FastAPI
+from fastapi import FastAPI, HTTPException, UploadFile
+from .jobs import queue_ingest
+from .storage import put_pdf
+from .answer import answer
 
 app = FastAPI()
 
-@app.get("/health")
-def health():
-    return {"ok": True}
+MAX_BYTES = 50 * 1024 * 1024  # until you say otherwise (Q1)
+
+@app.post("/documents", status_code=202)
+async def upload(file: UploadFile):
+    data = await file.read()
+    if len(data) > MAX_BYTES:
+        raise HTTPException(413, "PDF too large")
+    doc_id = put_pdf(data)
+    queue_ingest.delay(doc_id)  # D1: the upload returns at once
+    return {"id": doc_id, "status": "processing"}
+
+@app.post("/ask")
+def ask(body: dict):
+    return answer(body["question"])`),
    file("api/jobs.py", `@@ -0,0 +1,6 @@
+from celery import Celery
+
+celery = Celery("docqa", broker="redis://redis:6379/0")
+
+def queue_ingest(document_id: str):
+    return celery.send_task("worker.ingest", args=[document_id])`),
  ],
  worker: [
    file("worker/ingest.py", `@@ -0,0 +1,12 @@
+import fitz  # PyMuPDF
+from .chunking import chunk_pages
+from .embed import embed_all
+from .store import save_chunks
+
+@celery.task(name="worker.ingest")
+def ingest(document_id: str):
+    pdf = fitz.open(stream=load_pdf(document_id), filetype="pdf")
+    pages = [(i + 1, page.get_text()) for i, page in enumerate(pdf)]
+    chunks = chunk_pages(pages)  # D2
+    save_chunks(document_id, chunks, embed_all(c.text for c in chunks))
+    mark_ready(document_id)`),
    file("worker/chunking.py", `@@ -0,0 +1,9 @@
+from .tokens import count_tokens, split_tokens
+
+def chunk_pages(pages, size=500):
+    """~500-token chunks, each tagged with its page (D2)."""
+    out = []
+    for page, text in pages:
+        for piece in split_tokens(text, size):
+            out.append(Chunk(page=page, text=piece))
+    return out`),
  ],
  vdb: [
    file("migrations/001_chunks.sql", `@@ -0,0 +1,9 @@
+CREATE EXTENSION IF NOT EXISTS vector;
+CREATE TABLE chunks (
+  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
+  page        int NOT NULL,
+  text        text NOT NULL,
+  embedding   vector(1024) NOT NULL
+);
+-- D3: HNSW keeps search fast up to a few million chunks
+CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);`),
  ],
  llm: [
    file("api/answer.py", `@@ -0,0 +1,14 @@
+import anthropic
+from .search import nearest_chunks
+
+client = anthropic.Anthropic()
+
+def answer(question: str):
+    chunks = nearest_chunks(question, k=8)
+    context = "\\n\\n".join(f"[page {c.page}] {c.text}" for c in chunks)
+    msg = client.messages.create(
+        model="claude-opus-5-5", max_tokens=800,
+        system="Answer from the excerpts. Cite a page for every claim, like [p. 12].",
+        messages=[{"role": "user", "content": f"{context}\\n\\nQuestion: {question}"}],
+    )
+    return {"answer": msg.content[0].text, "citations": [c.page for c in chunks]}`),
  ],
  web: [
    file("web/src/Upload.tsx", `@@ -0,0 +1,10 @@
+export function Upload({ onDone }: { onDone: (id: string) => void }) {
+  const drop = async (files: FileList) => {
+    const body = new FormData();
+    body.append("file", files[0]);
+    const res = await fetch("/documents", { method: "POST", body });
+    onDone((await res.json()).id);
+  };
+  return <DropZone accept="application/pdf" onDrop={drop} />;
+}
+`),
    file("web/src/Chat.tsx", `@@ -0,0 +1,11 @@
+export function Chat({ documentId }: { documentId: string }) {
+  const [turns, setTurns] = useState<Turn[]>([]);
+  const ask = async (question: string) => {
+    const res = await fetch("/ask", { method: "POST", body: JSON.stringify({ question, documentId }) });
+    setTurns((t) => [...t, { question, ...(await res.json()) }]);
+  };
+  return (
+    <Thread turns={turns} renderCitation={(page) => <PageLink documentId={documentId} page={page} />} onAsk={ask} />
+  );
+}
+`),
  ],
  // Not owned by anything on the board: it shows up as such.
  compose: [
    file("docker-compose.yml", `@@ -0,0 +1,11 @@
+services:
+  api:
+    build: ./api
+    ports: ["8000:8000"]
+  worker:
+    build: ./worker
+    command: celery -A worker worker
+  redis:
+    image: redis:7
+  db:
+    image: pgvector/pgvector:pg16`),
  ],
  eval: [
    file("eval/run_eval.py", `@@ -0,0 +1,8 @@
+import json
+from api.search import nearest_chunks
+
+questions = [json.loads(l) for l in open("eval/questions.jsonl")]
+hits = sum(q["page"] in {c.page for c in nearest_chunks(q["question"], k=8)} for q in questions)
+print(f"{hits} of {len(questions)} answer pages found")
+for q in questions:
+    print(("ok" if q["page"] in {c.page for c in nearest_chunks(q["question"], k=8)} else "not ok"), q["id"])`),
  ],
  // D2 changed: chunks keep tables whole. (A run's diff is against its start, so this file is still new.)
  tables: [
    file("worker/chunking.py", `@@ -0,0 +1,14 @@
+from .tokens import count_tokens, split_tokens
+from .layout import blocks_of
+
+def chunk_pages(pages, size=500, max_table=1500):
+    """Layout-aware ~500-token chunks that keep tables whole (D2, changed after the eval)."""
+    out = []
+    for page, layout in pages:
+        for block in blocks_of(layout):
+            if block.kind == "table" and count_tokens(block.text) <= max_table:
+                out.append(Chunk(page=page, text=block.text))  # never split a table
+                continue
+            for piece in split_tokens(block.text, size):
+                out.append(Chunk(page=page, text=piece))
+    return out`),
  ],
};
