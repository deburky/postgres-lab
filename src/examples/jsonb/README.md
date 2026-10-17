# JSONB with SQLAlchemy

Runnable walkthrough of Postgres `jsonb` through the SQLAlchemy 2.0 API, using the
`Event` model in `src/models.py` (a `payload: JSONB` column). Each script prints the SQL
SQLAlchemy generates, then the rows in psql's aligned table format (no extra dependency,
see `print_table` in `_common.py`), so the output looks like what you would see in psql.

Every script starts by reloading the same five sample rows (`_common.py`), so they can be
run in any order and repeatedly.

Prefer a notebook? `notebooks/jsonb_playground.ipynb` covers the same ground with every query returned
as a pandas DataFrame, plus a section on flattening documents with `pd.json_normalize`. Open it
in VS Code, pick the `.venv` kernel, run all. It uses top-level `await`.

```bash
uv run --env-file .env src/examples/jsonb/01_read_paths.py
uv run --env-file .env src/examples/jsonb/02_filter_operators.py
uv run --env-file .env src/examples/jsonb/03_aggregate_and_update.py
uv run --env-file .env src/examples/jsonb/04_unnest_arrays.py
```

| Script | Topic | SQLAlchemy API |
|---|---|---|
| `01_read_paths.py` | extracting values | `col["k"]`, `.astext`, `col[("a","b")]`, `col["k"][0]`, `.as_integer()` / `.as_float()`, `.cast()` |
| `02_filter_operators.py` | filtering + GIN index | `.contains()`, `.contained_by()`, `.has_key()`, `.has_any()`, `.has_all()`, `.path_exists()`, `.path_match()`, `Index(postgresql_using="gin")` |
| `03_aggregate_and_update.py` | unnesting, aggregating, updating | `func.jsonb_array_elements(...).table_valued(...)`, `func.jsonb_agg`, `func.jsonb_build_object`, `.concat()`, `func.jsonb_set`, `.delete_path()`, `.op("-")` |
| `04_unnest_arrays.py` | array -> rows, in depth; each step has the raw SQL in a comment | `jsonb_array_elements`, `WITH ORDINALITY`, `jsonb_array_elements_text`, `jsonb_each`, `jsonb_to_recordset`, `jsonb_path_query`, `jsonb_typeof` |

## Operator cheat sheet

| SQL | SQLAlchemy | Notes |
|---|---|---|
| `payload -> 'k'` | `Event.payload["k"]` | stays jsonb; nested dict/list on the Python side |
| `payload ->> 'k'` | `Event.payload["k"].astext` | text |
| `payload #>> '{a,b}'` | `Event.payload[("a", "b")].astext` | tuple key = path |
| `(payload ->> 'k')::int` | `Event.payload["k"].as_integer()` | also `as_float`, `as_boolean`, `as_string` |
| `payload @> '{...}'` | `Event.payload.contains({...})` | the main filter; GIN-indexable |
| `payload <@ '{...}'` | `Event.payload.contained_by({...})` | |
| `payload ? 'k'` | `Event.payload.has_key("k")` | top-level keys only |
| `payload ?\| array[...]` | `Event.payload.has_any(array([...]))` | needs `postgresql.array` |
| `payload ?& array[...]` | `Event.payload.has_all(array([...]))` | needs `postgresql.array` |
| `payload @? '$.path'` | `Event.payload.path_exists("$.path")` | JSONPath |
| `payload @@ '$.a > 1'` | `Event.payload.path_match("$.a > 1")` | JSONPath predicate |
| `payload \|\| '{...}'` | `Event.payload.concat({...})` | top-level merge, right wins |
| `payload - 'k'` | `Event.payload.op("-")(literal("k", Text))` | no helper; type the key as Text |
| `payload #- '{a,b}'` | `Event.payload.delete_path(["a", "b"])` | |
| `jsonb_set(payload, '{a,b}', '"v"')` | `func.jsonb_set(Event.payload, array(["a","b"]), literal("v", JSONB))` | typing the literal as JSONB JSON-encodes it |

## Gotchas worth remembering

- **Missing keys are SQL NULL.** `payload->>'device' != 'web'` drops rows that have no
  `device` at all. Add `.is_(None)` explicitly if you want them (script 02, step 5).
- **A Python list binds as jsonb by default** on a JSONB column's operators. Where Postgres
  wants `text[]` (`?|`, `?&`, `jsonb_set` path) wrap it in `postgresql.array([...])`.
- **`.op("-")` inherits the column's type** for the right-hand side, so pass
  `literal("k", Text)` or Postgres looks for a non-existent `jsonb - jsonb`.
- **`jsonb_path_query` needs a `JSONPATH`-typed argument.** A plain str binds as varchar
  and Postgres reports "function jsonb_path_query(jsonb, character varying) does not exist".
  Use `literal("$.a[*]", JSONPATH)`.
- **`with_ordinality="n"` adds the column itself.** Don't also pass `column("n", Integer)`,
  or Postgres complains the alias has more columns than the function returns.
- **A join needs a left side.** If the SELECT list has no `events` column, add
  `.select_from(Event)` before `.join(item, true())`.
- **Table-valued functions need typed columns.** `table_valued(column("value", JSONB))`,
  not `table_valued("value")`, or `[]` and `.astext` are unavailable on the result.
- **In-place dict mutation is invisible to the ORM.** `ev.payload["x"] = 1` does not mark
  the row dirty. Reassign the attribute (`ev.payload = {**ev.payload, "x": 1}`) or declare
  the column as `MutableDict.as_mutable(JSONB)`.
- **GIN index op classes.** `jsonb_path_ops` is smaller and faster but only serves `@>`
  and `@?`. The default `jsonb_ops` also serves `?`, `?|`, `?&`. Neither helps `->>` equality
  filters; for those, build a B-tree expression index on `(payload ->> 'k')`.
