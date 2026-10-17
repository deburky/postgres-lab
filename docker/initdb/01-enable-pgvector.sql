-- Runs once when the data volume is first created (see Dockerfile).
-- The guide's init_db() also does this at app startup, so both paths are safe.
CREATE EXTENSION IF NOT EXISTS vector;
-- pgvectorscale: `diskann` index type (StreamingDiskANN). CASCADE pulls in vector if needed.
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
