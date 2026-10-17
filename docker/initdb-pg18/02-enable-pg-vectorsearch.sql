-- pg18 image only (docker/Dockerfile.pg18), after 01-enable-pgvector.sql.
-- pg_vectorsearch: the `prism` index type (IVF partitions + RaBitQ codes) and its own vec32/vec16
-- types. It indexes pgvector `vector` / `halfvec` columns as they are, so nothing else changes.
CREATE EXTENSION IF NOT EXISTS pg_vectorsearch;
