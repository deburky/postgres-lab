"""JSONB set-returning functions, aggregation, building JSON, and in-place updates.

Run:  uv run --env-file .env src/examples/jsonb/03_aggregate_and_update.py

SQL covered
    jsonb_array_elements(x)      one row per array element (a LATERAL join in practice)
    jsonb_each / jsonb_object_keys unnest an object
    jsonb_agg / jsonb_build_object build JSON from rows
    ||                           merge/concat (top-level keys only)
    -                            delete a top-level key
    #-                           delete by path
    jsonb_set(x, path, value)    replace a value by path (creates missing leaf keys)
"""

import asyncio

from _common import reset_events, run
from sqlalchemy import Numeric, Text, column, func, literal, select, true, update
from sqlalchemy.dialects.postgresql import JSONB, array

from db import SessionLocal
from models import Event


async def main() -> None:
    async with SessionLocal() as session:
        await reset_events(session)

        # 1. Unnest an array of objects. `.table_valued()` turns the function into a
        #    FROM-able thing with a `.value` column. Give the column a type (JSONB) so
        #    `[]`/.astext work on it. Joining on `true` gives a cross join; Postgres
        #    treats a function referencing another table as an implicit LATERAL.
        item = (
            func.jsonb_array_elements(Event.payload["items"])
            .table_valued(column("value", JSONB))
            .render_derived()
        )
        await run(
            session,
            "jsonb_array_elements: one row per purchased item",
            select(
                Event.id,
                item.c.value["sku"].astext.label("sku"),
                item.c.value["qty"].as_integer().label("qty"),
                item.c.value["price"].as_float().label("price"),
            )
            .select_from(Event)
            .join(item, true())  # ON true = cross join
            .where(Event.kind == "purchase")
            .order_by(Event.id),
        )

        # 2. Aggregate across the unnested rows: total quantity per event.
        await run(
            session,
            "SUM over unnested items",
            select(
                Event.id, func.sum(item.c.value["qty"].as_integer()).label("total_qty")
            )
            .select_from(Event)
            .join(item, true())
            .group_by(Event.id)
            .order_by(Event.id),
        )

        # 3. Unnest tags (an array of scalars) and count them.
        tag = (
            func.jsonb_array_elements_text(Event.payload["tags"])
            .table_valued(column("value", Text))
            .render_derived()
        )
        await run(
            session,
            "tag frequency via jsonb_array_elements_text",
            select(tag.c.value.label("tag"), func.count().label("n"))
            .select_from(Event)
            .join(tag, true())
            .group_by(tag.c.value)
            .order_by(func.count().desc(), tag.c.value),
        )

        # 4. Object keys: what top-level keys appear, and how often.
        key = (
            func.jsonb_object_keys(Event.payload)
            .table_valued(column("key", Text))
            .render_derived()
        )
        await run(
            session,
            "jsonb_object_keys: schema discovery",
            select(key.c.key, func.count())
            .select_from(Event)
            .join(key, true())
            .group_by(key.c.key)
            .order_by(func.count().desc(), key.c.key),
        )

        # 5. Build JSON from relational data: jsonb_agg + jsonb_build_object.
        await run(
            session,
            "jsonb_agg(jsonb_build_object(...)): one JSON array per kind",
            select(
                Event.kind,
                func.jsonb_agg(
                    func.jsonb_build_object(
                        "id", Event.id, "user", Event.payload[("user", "name")].astext
                    )
                ),
            )
            .group_by(Event.kind)
            .order_by(Event.kind),
        )

        # 6. Numeric aggregate on an extracted value, with a cast to Numeric for exact money maths.
        await run(
            session,
            "SUM(amount) per currency",
            select(
                Event.payload["currency"].astext.label("currency"),
                func.sum(Event.payload["amount"].astext.cast(Numeric(12, 2))).label(
                    "total"
                ),
            )
            .where(Event.kind == "purchase")
            .group_by("currency"),
        )

        # -------------------------------------------------------------------------------
        # Updates
        # -------------------------------------------------------------------------------

        # 7. `||` merges top-level keys (right side wins). Nested objects are REPLACED, not merged.
        await run(
            session,
            "|| merge: add 'reviewed' flag to all errors",
            update(Event)
            .where(Event.kind == "error")
            .values(payload=Event.payload.concat({"reviewed": True}))
            .returning(Event.id, Event.payload),
        )

        # 8. jsonb_set(target, text[] path, jsonb value). Typing the literal as JSONB makes
        #    SQLAlchemy JSON-encode the Python str -> '"enterprise"'::jsonb.
        await run(
            session,
            "jsonb_set: bump user.plan for user 1",
            update(Event)
            .where(Event.payload.contains({"user": {"id": 1}}))
            .values(
                payload=func.jsonb_set(
                    Event.payload,
                    array(["user", "plan"]),  # text[] path
                    literal("enterprise", JSONB),
                )
            )
            .returning(Event.id, Event.payload["user"]),
        )

        # 9. `-` removes a top-level key; `#-` (delete_path) removes by path.
        #    There is no helper for `-`, so use .op("-"). Type the key as Text, otherwise
        #    SQLAlchemy binds it as jsonb and Postgres has no `jsonb - jsonb` operator.
        await run(
            session,
            "- : drop top-level 'tags'",
            update(Event)
            .where(Event.kind == "error")
            .values(payload=Event.payload.op("-")(literal("tags", Text)))
            .returning(Event.id, Event.payload),
        )
        await run(
            session,
            "#- : drop nested user.plan",
            update(Event)
            .where(Event.payload.contains({"user": {"id": 1}}))
            .values(payload=Event.payload.delete_path(["user", "plan"]))
            .returning(Event.id, Event.payload["user"]),
        )

        # -------------------------------------------------------------------------------
        # 10. ORM-style: mutate the dict in Python. SQLAlchemy does NOT track changes inside
        #     a dict by default; reassigning the attribute is the simplest way to mark it dirty.
        #     (Alternative: wrap the column type with sqlalchemy.ext.mutable.MutableDict.)
        # -------------------------------------------------------------------------------
        ev = await session.scalar(select(Event).where(Event.kind == "error"))
        assert ev is not None
        ev.payload = {**ev.payload, "retries": 3}
        await session.commit()
        await run(
            session,
            "after ORM reassignment",
            select(Event.id, Event.payload).where(Event.kind == "error"),
        )


if __name__ == "__main__":
    asyncio.run(main())
