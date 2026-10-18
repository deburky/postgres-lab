// One lab per book chapter: the tables it starts with and the queries offered as chips. The seed
// runs once when the database starts (and again on Reset); every example is plain SQL the reader
// can edit before running.

export type Example = { label: string; sql: string };
export type Lab = {
  title: string;
  blurb: string;
  // extra SQL files under public/sql/ that run before the seed, such as pgmq's install script
  scripts?: string[];
  seed: string;
  examples: Example[];
};

// -------------------------------------------------------------------------------
// pgvector
// -------------------------------------------------------------------------------
const VECTORS: Lab = {
  title: "pgvector in your browser",
  blurb: "items: a dozen vectors on [fruit, tech, sport]. docs: 2,000 random 16-d unit vectors.",
  seed: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE items (id serial PRIMARY KEY, name text, category text, embedding vector(3));
INSERT INTO items (name, category, embedding) VALUES
  ('apple', 'food', '[0.9, 0.1, 0.0]'),
  ('banana', 'food', '[0.85, 0.05, 0.1]'),
  ('energy bar', 'food', '[0.6, 0.0, 0.7]'),
  ('smoothie', 'food', '[0.95, 0.0, 0.2]'),
  ('laptop', 'tech', '[0.0, 0.95, 0.1]'),
  ('phone', 'tech', '[0.05, 0.9, 0.05]'),
  ('tablet', 'tech', '[0.0, 1.0, 0.0]'),
  ('smartwatch', 'tech', '[0.0, 0.6, 0.7]'),
  ('fitness tracker', 'tech', '[0.0, 0.5, 0.85]'),
  ('football', 'sport', '[0.0, 0.0, 1.0]'),
  ('running shoes', 'sport', '[0.05, 0.1, 0.95]'),
  ('tennis racket', 'sport', '[0.0, 0.05, 0.9]');

CREATE TABLE docs (id int PRIMARY KEY, embedding vector(16));
INSERT INTO docs
SELECT i, l2_normalize(ARRAY(SELECT random() - 0.5 FROM generate_series(1, 16) WHERE i > 0)::vector)
FROM generate_series(1, 2000) AS i;
ANALYZE;`,
  examples: [
    {
      label: "Four distances",
      sql: `-- the four pgvector operators, from 'apple'
SELECT name,
       round((embedding <-> '[0.9,0.1,0]')::numeric, 3) AS l2,
       round((embedding <=> '[0.9,0.1,0]')::numeric, 3) AS cosine,
       round((embedding <#> '[0.9,0.1,0]')::numeric, 3) AS neg_inner,
       round((embedding <+> '[0.9,0.1,0]')::numeric, 3) AS l1
FROM items
ORDER BY embedding <=> '[0.9,0.1,0]';`,
    },
    {
      label: "kNN with a filter",
      sql: `-- 'sporty and techy', but only from the tech category
SELECT name, category, round((embedding <=> '[0,0.7,0.7]')::numeric, 3) AS distance
FROM items
WHERE category = 'tech'
ORDER BY embedding <=> '[0,0.7,0.7]'
LIMIT 3;`,
    },
    {
      label: "Vector arithmetic",
      sql: `-- smartwatch minus tablet plus apple: what is closest?
WITH q AS (
  SELECT (SELECT embedding FROM items WHERE name = 'smartwatch')
       - (SELECT embedding FROM items WHERE name = 'tablet')
       + (SELECT embedding FROM items WHERE name = 'apple') AS v
)
SELECT name, round((embedding <=> q.v)::numeric, 3) AS distance
FROM items, q
ORDER BY embedding <=> q.v
LIMIT 3;`,
    },
    {
      label: "Exact plan",
      sql: `-- no index yet: every row is scored, then sorted
EXPLAIN ANALYZE
SELECT id FROM docs
ORDER BY embedding <=> (SELECT embedding FROM docs WHERE id = 1)
LIMIT 10;`,
    },
    {
      label: "Build HNSW",
      sql: `CREATE INDEX IF NOT EXISTS docs_hnsw ON docs
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
SELECT pg_size_pretty(pg_relation_size('docs_hnsw')) AS index_size;`,
    },
    {
      label: "Plan with index",
      sql: `-- run 'Build HNSW' first; enable_seqscan = off because the table is small
SET enable_seqscan = off;
EXPLAIN ANALYZE
SELECT id FROM docs
ORDER BY embedding <=> (SELECT embedding FROM docs WHERE id = 1)
LIMIT 10;`,
    },
    {
      label: "Recall@10",
      sql: `-- how many of the true top 10 the index finds at ef_search 4; try 1, 10 or 40
SET hnsw.ef_search = 4;
SET enable_seqscan = off;
WITH q AS (SELECT embedding AS v FROM docs WHERE id = 7),
ann AS (SELECT id FROM docs, q ORDER BY embedding <=> q.v LIMIT 10)
SELECT count(*) AS found_of_10
FROM ann
WHERE id IN (
  SELECT id FROM (SELECT id, embedding <=> (SELECT v FROM q) AS d FROM docs) exact
  ORDER BY d LIMIT 10
);`,
    },
    {
      label: "Wrong opclass",
      sql: `-- an L2 index cannot serve a cosine query: the plan goes back to a sort
DROP INDEX IF EXISTS docs_hnsw;
CREATE INDEX IF NOT EXISTS docs_l2 ON docs USING hnsw (embedding vector_l2_ops);
SET enable_seqscan = off;
EXPLAIN
SELECT id FROM docs
ORDER BY embedding <=> (SELECT embedding FROM docs WHERE id = 1)
LIMIT 10;`,
    },
  ],
};

// -------------------------------------------------------------------------------
// JSONB
// -------------------------------------------------------------------------------
const JSONB: Lab = {
  title: "JSONB in your browser",
  blurb: "events: id, kind and a jsonb payload with a user, a device (sometimes) and line items.",
  seed: `
CREATE TABLE events (id serial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL);
INSERT INTO events (kind, payload) VALUES
  ('order', '{"user": {"id": 1, "plan": "pro"}, "device": "web", "items": [{"sku": "A1", "qty": 2}, {"sku": "B7", "qty": 1}]}'),
  ('order', '{"user": {"id": 2, "plan": "free"}, "device": "ios", "items": [{"sku": "A1", "qty": 1}]}'),
  ('order', '{"user": {"id": 3, "plan": "pro"}, "items": [{"sku": "C3", "qty": 5}]}'),
  ('signup', '{"user": {"id": 4, "plan": "free"}, "device": "web", "referrer": "newsletter"}'),
  ('order', '{"user": {"id": 1, "plan": "pro"}, "device": "android", "items": [{"sku": "B7", "qty": 3}, {"sku": "C3", "qty": 1}]}'),
  ('signup', '{"user": {"id": 5, "plan": "pro"}}'),
  ('order', '{"user": {"id": 5, "plan": "pro"}, "device": "web", "items": [{"sku": "A1", "qty": 4}]}');`,
  examples: [
    {
      label: "-> and ->>",
      sql: `-- -> returns jsonb, ->> returns text, #>> follows a path
SELECT id,
       payload -> 'user' AS user_json,
       payload #>> '{user,plan}' AS plan,
       (payload #>> '{user,id}')::int AS user_id,
       payload ->> 'device' AS device
FROM events;`,
    },
    {
      label: "Containment @>",
      sql: `-- does the document include this fragment? (a GIN index serves it)
SELECT id, kind, payload -> 'user' AS user_json
FROM events
WHERE payload @> '{"user": {"plan": "pro"}}';`,
    },
    {
      label: "The NULL trap",
      sql: `-- != 'web' silently drops rows with no device key: NULL != 'web' is NULL
SELECT 'device != web' AS filter, count(*) FROM events
WHERE payload ->> 'device' != 'web'
UNION ALL
SELECT 'not web, or no device', count(*) FROM events
WHERE payload ->> 'device' IS DISTINCT FROM 'web';`,
    },
    {
      label: "Arrays to rows",
      sql: `-- one row per line item, then ordinary GROUP BY
SELECT item ->> 'sku' AS sku, sum((item ->> 'qty')::int) AS units
FROM events, jsonb_array_elements(payload -> 'items') AS item
WHERE kind = 'order'
GROUP BY 1
ORDER BY units DESC;`,
    },
    {
      label: "jsonb_to_recordset",
      sql: `-- typed columns instead of jsonb values, no casts needed
SELECT e.id, li.sku, li.qty
FROM events e,
     jsonb_to_recordset(e.payload -> 'items') AS li(sku text, qty int)
ORDER BY e.id, li.sku;`,
    },
    {
      label: "JSON path",
      sql: `-- SQL/JSON path: the items with qty > 1, inside each document
SELECT id, jsonb_path_query_array(payload, '$.items[*] ? (@.qty > 1).sku') AS bulk_skus
FROM events
WHERE payload @? '$.items[*] ? (@.qty > 1)';`,
    },
    {
      label: "Updates",
      sql: `-- || merges, - removes a key, jsonb_set writes a path; RETURNING shows the result
UPDATE events
SET payload = jsonb_set(payload || '{"seen": true}', '{user,plan}', '"team"') - 'referrer'
WHERE id = 4
RETURNING id, payload;`,
    },
    {
      label: "GIN index",
      sql: `CREATE INDEX IF NOT EXISTS events_payload ON events USING gin (payload jsonb_path_ops);
SET enable_seqscan = off;
EXPLAIN SELECT id FROM events WHERE payload @> '{"device": "web"}';`,
    },
  ],
};

// -------------------------------------------------------------------------------
// pgmq
// -------------------------------------------------------------------------------
const PGMQ: Lab = {
  title: "pgmq in your browser",
  blurb: "pgmq 1.13 installed from its SQL. A queue called tasks with five messages waiting.",
  scripts: ["pgmq-1.13.0.sql"],
  seed: `
SELECT pgmq.create('tasks');
SELECT pgmq.send_batch('tasks', ARRAY[
  '{"job": "resize", "img": 1}', '{"job": "resize", "img": 2}', '{"job": "email", "to": "ana"}',
  '{"job": "resize", "img": 3}', '{"job": "email", "to": "bo"}'
]::jsonb[]);`,
  examples: [
    {
      label: "Peek at the queue",
      sql: `-- a queue is a table: q_<name>, one row per message
SELECT msg_id, read_ct, vt, message FROM pgmq.q_tasks ORDER BY msg_id;`,
    },
    {
      label: "Read 2, vt 30 s",
      sql: `-- take two messages and hide them from other readers for 30 seconds
SELECT msg_id, read_ct, message FROM pgmq.read('tasks', 30, 2);`,
    },
    {
      label: "Read again",
      sql: `-- the two you read are invisible now: the next reader gets the rest
SELECT msg_id, read_ct, message FROM pgmq.read('tasks', 30, 10);`,
    },
    {
      label: "Visibility timeout",
      sql: `-- a queue of its own: hide its one message for 1 s, wait 1.5 s, and it is back with read_ct 2
SELECT pgmq.create('flaky');
SELECT pgmq.purge_queue('flaky');
SELECT pgmq.send('flaky', '{"job": "flaky"}');
SELECT msg_id, read_ct FROM pgmq.read('flaky', 1, 1);
SELECT pg_sleep(1.5);
SELECT msg_id, read_ct, message FROM pgmq.read('flaky', 1, 1);`,
    },
    {
      label: "Delete and archive",
      sql: `-- delete drops a finished message; archive moves it to a_tasks for the record
SELECT pgmq.delete('tasks', 1::bigint) AS deleted,
       pgmq.archive('tasks', 2::bigint) AS archived;
SELECT msg_id, archived_at, message FROM pgmq.a_tasks;`,
    },
    {
      label: "Pop",
      sql: `-- read and delete in one step, at-most-once; only a visible message can be popped
SELECT pgmq.send('tasks', '{"job": "report"}');
SELECT msg_id, message FROM pgmq.pop('tasks');`,
    },
    {
      label: "Metrics",
      sql: `SELECT queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages
FROM pgmq.metrics('tasks');`,
    },
    {
      label: "Topics",
      sql: `-- route by pattern: bind queues to topics, then send once to a routing key
SELECT pgmq.create('emails'), pgmq.create('audit');
SELECT pgmq.bind_topic('mail.*', 'emails'), pgmq.bind_topic('#', 'audit');
SELECT pgmq.send_topic('mail.welcome', '{"to": "cy"}') AS queues_reached;
SELECT 'emails' AS queue, count(*) FROM pgmq.q_emails
UNION ALL SELECT 'audit', count(*) FROM pgmq.q_audit;`,
    },
  ],
};

// -------------------------------------------------------------------------------
// graph retrieval
// -------------------------------------------------------------------------------
const GRAPH: Lab = {
  title: "A document graph in your browser",
  blurb: "The doc-search corpus as a graph: 407 chunks, 440 API entities and 1,436 mentions. No embeddings.",
  scripts: ["doc-graph.sql"],
  seed: `SELECT 1;`,
  examples: [
    {
      label: "Hubs",
      sql: `-- how many chunks mention each entity; a few names appear almost everywhere
SELECT e.name, count(*) AS chunks
FROM mentions m JOIN entities e ON e.id = m.entity_id
GROUP BY e.name
ORDER BY chunks DESC
LIMIT 10;`,
    },
    {
      label: "A chunk's entities",
      sql: `-- the API names in the chunks of one section
SELECT c.id, e.name
FROM chunks c
JOIN mentions m ON m.chunk_id = c.id
JOIN entities e ON e.id = m.entity_id
WHERE c.title = 'Preventing Implicit IO when Using AsyncSession'
ORDER BY c.id, e.name;`,
    },
    {
      label: "Two hops",
      sql: `-- chunks that share an entity with chunk 201, counted by shared entities
SELECT c.page, c.title, count(*) AS shared
FROM mentions m1
JOIN mentions m2 ON m2.entity_id = m1.entity_id AND m2.chunk_id <> m1.chunk_id
JOIN chunks c ON c.id = m2.chunk_id
WHERE m1.chunk_id = 201
GROUP BY c.page, c.title
ORDER BY shared DESC
LIMIT 10;`,
    },
    {
      label: "Weighted by IDF",
      sql: `-- the same hop, with each shared entity weighted by ln(N / df), so hubs count for little
WITH idf AS (
  SELECT entity_id, ln((SELECT count(*) FROM chunks)::float / count(*)) AS w
  FROM mentions GROUP BY entity_id
)
SELECT c.page, c.title, round(sum(idf.w)::numeric, 2) AS score
FROM mentions m1
JOIN mentions m2 ON m2.entity_id = m1.entity_id AND m2.chunk_id <> m1.chunk_id
JOIN idf ON idf.entity_id = m1.entity_id
JOIN chunks c ON c.id = m2.chunk_id
WHERE m1.chunk_id = 201
GROUP BY c.page, c.title
ORDER BY score DESC
LIMIT 10;`,
    },
    {
      label: "Recursive walk",
      sql: `-- new nodes at each depth from chunk 201: even depths are chunks, odd depths are entities
WITH RECURSIVE edges (src, dst) AS (
  SELECT 'c' || chunk_id, 'e' || entity_id FROM mentions
  UNION ALL
  SELECT 'e' || entity_id, 'c' || chunk_id FROM mentions
),
walk (node, depth) AS (
  SELECT 'c201', 0
  UNION
  SELECT e.dst, w.depth + 1
  FROM walk w JOIN edges e ON e.src = w.node
  WHERE w.depth < 4
)
SELECT depth, count(*) AS new_nodes
FROM (SELECT node, min(depth) AS depth FROM walk GROUP BY node) first_seen
GROUP BY depth
ORDER BY depth;`,
    },
    {
      label: "Path between entities",
      sql: `-- chains from selectinload to create_engine through shared chunks, skipping hubs
WITH RECURSIVE kept AS (
  SELECT entity_id FROM mentions GROUP BY entity_id HAVING count(*) <= 20
),
walk (entity_id, path, via) AS (
  SELECT id, ARRAY[name], ARRAY[]::text[] FROM entities WHERE name = 'selectinload'
  UNION ALL
  SELECT m2.entity_id, w.path || e.name, w.via || c.title
  FROM walk w
  JOIN mentions m1 ON m1.entity_id = w.entity_id
  JOIN mentions m2 ON m2.chunk_id = m1.chunk_id AND m2.entity_id <> w.entity_id
  JOIN kept ON kept.entity_id = m2.entity_id
  JOIN entities e ON e.id = m2.entity_id
  JOIN chunks c ON c.id = m1.chunk_id
  WHERE cardinality(w.path) < 4 AND NOT e.name = ANY (w.path)
)
SELECT array_to_string(path, ' -> ') AS path, via AS through_sections
FROM walk
WHERE path[cardinality(path)] = 'create_engine'
LIMIT 5;`,
    },
  ],
};

export const LABS: Record<string, Lab> = { vectors: VECTORS, jsonb: JSONB, pgmq: PGMQ, graph: GRAPH };
