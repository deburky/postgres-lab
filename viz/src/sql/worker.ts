// Postgres 18 compiled to WebAssembly (PGlite), with pgvector, in a Web Worker so the page around
// the console stays responsive while the database starts and while a query runs.

import { PGlite } from "@electric-sql/pglite";
import { worker } from "@electric-sql/pglite/worker";
import { vector } from "@electric-sql/pglite-pgvector";

worker({ init: () => PGlite.create({ extensions: { vector } }) });
