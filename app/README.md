# Doc search + extractive summary (no LLM)

Ask a question, get the most relevant passages of the SQLAlchemy documentation and an extractive
summary of them. Retrieval is pgvector cosine search over embedded chunks; the summary is spaCy
picking sentences out of those chunks. Nothing generates text, so every answer also returns the
chunks it was built from, with scores and links.

| File | Role |
|---|---|
| `chunks.py` | `DocChunk` table: source page, section title, text, `Vector(384)` embedding, HNSW index |
| `ingest.py` | fetch 20 `.rst` pages from the sqlalchemy repo, clean, chunk by section, embed, store (idempotent) |
| `jobs.py` | the same ingest as a pgqueuer job queue: one job per page, several workers, retries, a nightly re-ingest schedule (see the root README) |
| `summarize.py` | extractive summariser: sentences ranked by content-word frequency, with query boost and length penalty |
| `app.py` | FastAPI: `POST /ask`, `GET /search`, `GET /health`; `GET /field` and `POST /trace` for the three.js city in `viz/` |

## Run it

All commands from the project root. `DB_ECHO=false` keeps SQLAlchemy from logging every statement.

```bash
docker compose up -d                                                 # pg16 + pgvector
DB_ECHO=false uv run --env-file .env app/ingest.py                   # once; ~2 min the first time
DB_ECHO=false uv run --env-file .env uvicorn --app-dir app app:app   # http://127.0.0.1:8000/docs
```

The first ingest downloads the embedding model (about 130 MB, cached under `~/.cache`). Re-running
it replaces the chunks page by page. To ingest a subset, pass a source prefix:
`uv run --env-file .env app/ingest.py orm/`.

Add `--reload` to the uvicorn line while editing `app.py`.

To ingest through a queue instead, with workers that can run anywhere the database is reachable:
`just queue-ingest` queues one job per page and `just queue-worker drain` (in one or more
terminals) works through them. `app/jobs.py` has the details.

## Call it

Interactive docs and a try-it form: <http://127.0.0.1:8000/docs>.

```bash
# health: database, chunk count, model names
curl -s localhost:8000/health

# ask: retrieval + summary
curl -s localhost:8000/ask -H 'content-type: application/json' \
     -d '{"query": "What does expire_on_commit do?", "k": 5, "sentences": 3}' | jq .

# ask, restricted to one part of the docs, summary only
curl -s localhost:8000/ask -H 'content-type: application/json' \
     -d '{"query": "How do I configure pool size?", "source_prefix": "core/"}' | jq -r .summary

# search: the retrieval step alone
curl -s 'localhost:8000/search?q=selectinload&k=3' | jq '.[] | {score, title, url}'
```

From Python:

```python
import httpx

r = httpx.post("http://127.0.0.1:8000/ask", json={"query": "difference between flush and commit", "k": 5, "sentences": 2})
answer = r.json()
print(answer["summary"])
for hit in answer["hits"]:
    print(hit["score"], hit["title"], hit["url"])
```

### `POST /ask`

| Field | Default | Meaning |
|---|---|---|
| `query` | required | the question, at least 3 characters |
| `k` | 5 | chunks retrieved (1 to 20) |
| `sentences` | 4 | sentences in the summary (1 to 15) |
| `source_prefix` | none | only sources starting with this, e.g. `"orm/"`, `"tutorial/"`, `"core/"` |

Response: `summary`, `keywords` (the most frequent content words of the retrieved text), `hits`
(source, title, url, cosine similarity score, chunk text, best first) and `timings_ms`.

### `GET /search`

Query parameters `q`, `k`, `source_prefix`; returns the `hits` list only.

### `POST /queue/trace`

For the queue scene, `viz/queue.html`. The body takes the scene's knobs (`jobs`, `workers`,
`batch_size`, `max_concurrent_tasks`, `concurrency_limit`, `job_ms`, `fail_rate`, `max_attempts`,
`retry_ms`, `enqueue` = `batch` or `drip`, `priorities`, `seed`); every field has a default. It runs
pgqueuer workers against the database, drains the jobs, and returns the timeline: `enqueue`,
`notify`, `start` and `end` events in ms from the first insert. See `queue_trace.py`.

### `GET /field` and `POST /trace`

For the city in `viz/`. `/field` returns every chunk with its PCA coordinates. `/trace` takes
`{"questions": [...], "mode": "sync" | "async", "k"}` and answers the batch with tracing on:
sync runs them one after another on one connection in a worker thread, async runs one task and
one connection per question under `asyncio.gather`. The response carries every event (embed,
pool checkout, statements, backend pid), the matched chunks with distances, and each question's
position in the field. CORS is open so the Vite dev server can call it.


## Reading the results

- Scores around 0.75 and above mean the right section was found; below about 0.65 the corpus has
  nothing solid and the summary will be off topic. Check the `hits` titles first.
- The summary is a digest of the retrieved passages, not an answer. It is best when the docs state
  the point in a sentence or two, and rambling when the docs do.
- Tokens like `asyncio_orm_avoid_lazyloads` are reStructuredText cross-reference labels the
  cleaner could not resolve to a title.

## Tuning

Settings (env vars or `.env`, see `src/settings.py`): `EMBED_MODEL` and `EMBED_DIM` (changing the
model means dropping `doc_chunks` and re-ingesting), `CHUNK_WORDS`, `SEARCH_K`, `SUMMARY_SENTENCES`,
`DOCS_REF` (git ref of the docs), `SPACY_MODEL`.

The summariser's two extra knobs are set in `app.py` where it is called: `length_penalty=0.75`
(0 is the original frequency sum, which always picks the longest sentences; 1 is the mean, which
picks the shortest) and `query=req.query` (boosts the question's words, substring-matched). Both
default to off in `summarize_text`, which reproduces the original algorithm.

Pages ingested are the `PAGES` list at the top of `ingest.py`.
