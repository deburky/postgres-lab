"""JSONB filtering: containment, key existence, JSONPath, and a GIN index.

Run:  uv run --env-file .env src/examples/jsonb/02_filter_operators.py

SQL operators covered
    @>    left contains right          payload @> '{"user": {"country": "NG"}}'
    <@    left is contained by right   '{"a":1}' <@ payload
    ?     top-level key exists         payload ? 'amount'
    ?|    any of the keys exist        payload ?| array['amount','code']
    ?&    all of the keys exist        payload ?& array['user','tags']
    @?    JSONPath matches             payload @? '$.items[*] ? (@.qty > 1)'
    @@    JSONPath predicate is true   payload @@ '$.amount > 1000'
"""

import asyncio

from _common import reset_events, run, show_sql
from sqlalchemy import Index, select, text
from sqlalchemy.dialects.postgresql import array
from sqlalchemy.schema import CreateIndex

from db import SessionLocal, engine
from models import Event


async def main() -> None:
    async with SessionLocal() as session:
        await reset_events(session)

        # 1. Containment is the workhorse: nested dicts match partially, arrays match "has element".
        await run(
            session,
            "@> nested containment: Nigerian users",
            select(Event).where(Event.payload.contains({"user": {"country": "NG"}})),
        )
        await run(
            session,
            "@> array containment: events tagged 'promo'",
            select(Event).where(Event.payload.contains({"tags": ["promo"]})),
        )
        await run(
            session,
            "<@ contained_by: payloads that are a subset of this doc",
            select(Event).where(
                Event.payload.contained_by(
                    {
                        "code": 500,
                        "message": "upstream timeout",
                        "tags": ["api"],
                        "extra": 1,
                    }
                )
            ),
        )

        # 2. Key existence (top level only; for nested keys use contains or a path).
        #    has_any/has_all take a Postgres text[]: wrap the list in postgresql.array(),
        #    otherwise SQLAlchemy binds the Python list as a jsonb value and Postgres errors.
        await run(
            session,
            "? has_key: rows with an 'amount'",
            select(Event.id).where(Event.payload.has_key("amount")),
        )
        await run(
            session,
            "?| has_any: rows with 'amount' OR 'code'",
            select(Event.id).where(Event.payload.has_any(array(["amount", "code"]))),
        )
        await run(
            session,
            "?& has_all: rows with both 'user' AND 'items'",
            select(Event.id).where(Event.payload.has_all(array(["user", "items"]))),
        )

        # 3. Comparing extracted values (see 01 for the extraction helpers).
        await run(
            session,
            "purchases over 1000 using .as_float()",
            select(Event.id, Event.payload["amount"].as_float()).where(
                Event.kind == "purchase", Event.payload["amount"].as_float() > 1000
            ),
        )

        # 4. JSONPath (Postgres 12+). Lets you look inside arrays without unnesting.
        await run(
            session,
            "@? path_exists: any item with qty > 1",
            select(Event.id).where(
                Event.payload.path_exists("$.items[*] ? (@.qty > 1)")
            ),
        )
        await run(
            session,
            "@@ path_match: predicate on a scalar",
            select(Event.id).where(Event.payload.path_match("$.amount > 1000")),
        )

        # 5. Null handling: a missing key yields SQL NULL, so `!= 'x'` silently drops rows.
        await run(
            session,
            "missing key -> NULL: only rows that HAVE a device other than 'web'",
            select(Event.id).where(Event.payload["device"].astext != "web"),
        )
        await run(
            session,
            "include rows without the key: use is_(None) explicitly",
            select(Event.id).where(
                (Event.payload["device"].astext != "web")
                | (Event.payload["device"].astext.is_(None))
            ),
        )

    # 6. Indexing. A GIN index makes @>, ?, ?|, ?& and @? fast.
    #    jsonb_path_ops is smaller/faster but only supports @> and @?; default ops supports all.
    gin = Index(
        "ix_events_payload_gin",
        Event.payload,
        postgresql_using="gin",
        postgresql_ops={"payload": "jsonb_path_ops"},
    )
    show_sql("CREATE INDEX for containment queries", CreateIndex(gin))
    async with engine.begin() as conn:
        await conn.run_sync(gin.create, checkfirst=True)
        print("   index created (or already existed)")
        # Force the planner to consider the index even on 5 rows, just to show it in EXPLAIN.
        await conn.execute(text("SET enable_seqscan = off"))
        plan = await conn.execute(
            text(
                'EXPLAIN SELECT id FROM events WHERE payload @> \'{"user": {"country": "NG"}}\''
            )
        )
        print("\n=== EXPLAIN with the GIN index available")
        for (line,) in plan:
            print("  ", line)


if __name__ == "__main__":
    asyncio.run(main())
