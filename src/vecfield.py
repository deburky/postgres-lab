"""The documentation chunks as a 3-D field: a PCA of their embeddings, shared by the app's live
`/trace` endpoint and the offline tracer so both place questions in the same layout.

    field = Field.load()            # reads doc_chunks
    field.project(vector)           # -> [x, y, z] in [-1, 1]
    field.as_json()                 # ids, titles, sources, xyz for the city
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import psycopg

from settings import settings


@dataclass
class Field:
    ids: list[int]
    titles: list[str]
    sources: list[str]
    mean: np.ndarray
    comps: np.ndarray  # (3, dim)
    scale: np.ndarray  # (3,)
    xyz: np.ndarray  # (n, 3) in [-1, 1]

    @classmethod
    def load(cls, dsn: str | None = None) -> Field:
        dsn = dsn or settings.sqlalchemy_url("pg16").replace("postgresql+psycopg://", "postgresql://")
        with psycopg.connect(dsn) as c:
            rows = c.execute("SELECT id, source, title, embedding::text FROM doc_chunks ORDER BY id").fetchall()
        if not rows:
            raise RuntimeError("doc_chunks is empty: run `uv run --env-file .env app/ingest.py` first")
        M = np.array([[float(x) for x in r[3].strip("[]").split(",")] for r in rows], dtype=np.float32)
        mean = M.mean(axis=0)
        _, _, vt = np.linalg.svd(M - mean, full_matrices=False)
        comps = vt[:3]
        # fix the sign of each axis so the layout is stable across runs
        comps = comps * np.sign(comps[:, [0]] + 1e-12)
        P = (M - mean) @ comps.T
        scale = np.abs(P).max(axis=0)
        return cls([r[0] for r in rows], [r[2] for r in rows], [r[1] for r in rows], mean, comps, scale, P / scale)

    def project(self, vec) -> list[float]:
        p = (np.asarray(vec, dtype=np.float32) - self.mean) @ self.comps.T / self.scale
        return [round(float(x), 3) for x in p]

    def as_json(self) -> dict:
        return {"ids": self.ids, "titles": self.titles, "sources": self.sources, "xyz": self.xyz.round(3).astype(float).ravel().tolist()}
