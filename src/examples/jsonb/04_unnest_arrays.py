"""jsonb_array_elements: turn one row holding a JSON array into one row per element.

Run:  uv run --env-file .env src/examples/jsonb/04_unnest_arrays.py

Before (one row, array inside):
    id | items
    ---+--------------------------------------------------------
    28 | [{"sku": "A-1", "qty": 2}, {"sku": "B-7", "qty": 1}]

After (one row per element, now GROUP BY / JOIN / WHERE-able):
    id | sku | qty
    ---+-----+----
    28 | A-1 |   2
    28 | B-7 |   1

Each step has the equivalent psql SQL in a comment block above it, so you can paste
it into `docker compose exec db psql -U app -d app` and compare.
"""
import asyncio

from sqlalchemy import Integer, Numeric, Text, column, func, literal, select, true
from sqlalchemy.dialects.postgresql import JSONB, JSONPATH

from _common import reset_events, run
from db import SessionLocal
from models import Event

# Table-valued function: `jsonb_array_elements(<expr>) AS item(value)`.
# `column("value", JSONB)` tells SQLAlchemy the element type so item.c.value["sku"] works.
item = (
    func.jsonb_array_elements(Event.payload["items"])
    .table_valued(column("value", JSONB))
    .render_derived()
)
sku = item.c.value["sku"].astext.label("sku")
qty = item.c.value["qty"].as_integer().label("qty")
price = item.c.value["price"].astext.cast(Numeric(12, 2)).label("price")


async def main() -> None:
    async with SessionLocal() as session:
        await reset_events(session)

        # 0. What we start from.
        #
        #   SELECT id, payload->'items' AS items
        #   FROM events
        #   WHERE kind = 'purchase';
        await run(
            session,
            "before: the array is one opaque value per row",
            select(Event.id, Event.payload["items"].label("items")).where(Event.kind == "purchase"),
        )

        # 1. Unnest. `.join(item, true())` is a cross join; Postgres makes it LATERAL
        #    automatically because the function refers to events.payload.
        #
        #   SELECT e.id,
        #          item.value->>'sku'                    AS sku,
        #          (item.value->>'qty')::int             AS qty,
        #          (item.value->>'price')::numeric(12,2) AS price
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_array_elements(e.payload->'items') AS item(value)
        #   WHERE e.kind = 'purchase'
        #   ORDER BY e.id, sku;
        await run(
            session,
            "after: one row per item",
            select(Event.id, sku, qty, price)
            .join(item, true())
            .where(Event.kind == "purchase")
            .order_by(Event.id, sku),
        )

        # 2. Now ordinary SQL works on the elements: filter...
        #
        #   SELECT e.id, item.value->>'sku' AS sku, (item.value->>'qty')::int AS qty
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_array_elements(e.payload->'items') AS item(value)
        #   WHERE (item.value->>'qty')::int > 1;
        await run(
            session,
            "WHERE on an element: items with qty > 1",
            select(Event.id, sku, qty).join(item, true()).where(qty > 1),
        )

        # 3. ...aggregate across events...
        #
        #   SELECT item.value->>'sku' AS sku,
        #          SUM((item.value->>'qty')::int) AS units,
        #          SUM((item.value->>'qty')::int * (item.value->>'price')::numeric(12,2)) AS revenue
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_array_elements(e.payload->'items') AS item(value)
        #   GROUP BY sku
        #   ORDER BY revenue DESC;
        await run(
            session,
            "GROUP BY sku across all purchases",
            select(sku, func.sum(qty).label("units"), func.sum(qty * price).label("revenue"))
            .select_from(Event)  # needed: no events.* column in SELECT, so the left side is not implied
            .join(item, true())
            .group_by(sku)
            .order_by(func.sum(qty * price).desc()),
        )

        # 4. ...or fold back per event, e.g. a computed line total to compare with payload.amount.
        #
        #   SELECT e.id,
        #          SUM((item.value->>'qty')::int * (item.value->>'price')::numeric(12,2)) AS items_total,
        #          (e.payload->>'amount')::numeric(12,2) AS amount
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_array_elements(e.payload->'items') AS item(value)
        #   GROUP BY e.id, e.payload->>'amount'
        #   ORDER BY e.id;
        await run(
            session,
            "per-event total from items vs stored amount",
            select(
                Event.id,
                func.sum(qty * price).label("items_total"),
                Event.payload["amount"].astext.cast(Numeric(12, 2)).label("amount"),
            )
            .join(item, true())
            .group_by(Event.id, Event.payload["amount"].astext)
            .order_by(Event.id),
        )

        # 5. WITH ORDINALITY gives you the element's position (1-based).
        #    `with_ordinality="n"` adds the column for you; don't declare it again.
        #
        #   SELECT e.id, item.n, item.value->>'sku' AS sku
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_array_elements(e.payload->'items')
        #        WITH ORDINALITY AS item(value, n)
        #   WHERE e.kind = 'purchase'
        #   ORDER BY e.id, item.n;
        numbered = (
            func.jsonb_array_elements(Event.payload["items"])
            .table_valued(column("value", JSONB), with_ordinality="n")
            .render_derived()
        )
        await run(
            session,
            "WITH ORDINALITY: position of each element",
            select(Event.id, numbered.c.n, numbered.c.value["sku"].astext.label("sku"))
            .join(numbered, true())
            .where(Event.kind == "purchase")
            .order_by(Event.id, numbered.c.n),
        )

        # 6. Arrays of scalars: jsonb_array_elements_text returns text directly.
        #
        #   SELECT tag.value AS tag, COUNT(*) AS events
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_array_elements_text(e.payload->'tags') AS tag(value)
        #   GROUP BY tag.value
        #   ORDER BY events DESC, tag;
        tag = (
            func.jsonb_array_elements_text(Event.payload["tags"])
            .table_valued(column("value", Text))
            .render_derived()
        )
        await run(
            session,
            "jsonb_array_elements_text on tags, then GROUP BY",
            select(tag.c.value.label("tag"), func.count().label("events"))
            .select_from(Event)
            .join(tag, true())
            .group_by(tag.c.value)
            .order_by(func.count().desc(), tag.c.value),
        )

        # 7. Objects instead of arrays: jsonb_each unnests key/value pairs.
        #
        #   SELECT e.id, kv.key, kv.value
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_each(e.payload->'user') AS kv(key, value)
        #   WHERE e.id = (SELECT MIN(id) FROM events)
        #   ORDER BY kv.key;
        kv = (
            func.jsonb_each(Event.payload["user"])
            .table_valued(column("key", Text), column("value", JSONB))
            .render_derived()
        )
        await run(
            session,
            "jsonb_each: user object as key/value rows",
            select(Event.id, kv.c.key, kv.c.value)
            .join(kv, true())
            .where(Event.id == select(func.min(Event.id)).scalar_subquery())
            .order_by(kv.c.key),
        )

        # ---- Same job, other tools from the Postgres JSON functions page ----------

        # 8. jsonb_to_recordset: unnest an array of objects STRAIGHT into typed columns.
        #    Column names must match the JSON keys; no ->> and no casts needed.
        #
        #   SELECT e.id, r.sku, r.qty, r.price
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_to_recordset(e.payload->'items')
        #        AS r(sku text, qty int, price numeric(12,2))
        #   WHERE e.kind = 'purchase'
        #   ORDER BY e.id, r.sku;
        rec = (
            func.jsonb_to_recordset(Event.payload["items"])
            .table_valued(
                column("sku", Text), column("qty", Integer), column("price", Numeric(12, 2))
            )
            .render_derived(with_types=True)
        )
        await run(
            session,
            "jsonb_to_recordset: typed columns directly",
            select(Event.id, rec.c.sku, rec.c.qty, rec.c.price)
            .join(rec, true())
            .where(Event.kind == "purchase")
            .order_by(Event.id, rec.c.sku),
        )

        # 9. jsonb_path_query: unnest with a JSONPath, including a filter inside the path.
        #    Returns one row per match, so it is also set-returning. The path must be
        #    typed JSONPATH: a plain str binds as varchar and Postgres finds no such function.
        #
        #   SELECT e.id, m.value
        #   FROM events e
        #   CROSS JOIN LATERAL jsonb_path_query(e.payload, '$.items[*] ? (@.price > 500)') AS m(value)
        #   ORDER BY e.id;
        matches = (
            func.jsonb_path_query(Event.payload, literal("$.items[*] ? (@.price > 500)", JSONPATH))
            .table_valued(column("value", JSONB))
            .render_derived()
        )
        await run(
            session,
            "jsonb_path_query: elements matching a JSONPath filter",
            select(Event.id, matches.c.value).join(matches, true()).order_by(Event.id),
        )

        # 10. jsonb_typeof: inspect what an element actually is (useful on messy data).
        #
        #   SELECT id,
        #          jsonb_typeof(payload->'tags')     AS tags,
        #          jsonb_typeof(payload->'amount')   AS amount,
        #          jsonb_typeof(payload->'refunded') AS refunded
        #   FROM events
        #   ORDER BY id;
        await run(
            session,
            "jsonb_typeof of a few paths",
            select(
                Event.id,
                func.jsonb_typeof(Event.payload["tags"]).label("tags"),
                func.jsonb_typeof(Event.payload["amount"]).label("amount"),
                func.jsonb_typeof(Event.payload["refunded"]).label("refunded"),
            ).order_by(Event.id),
        )


if __name__ == "__main__":
    asyncio.run(main())
