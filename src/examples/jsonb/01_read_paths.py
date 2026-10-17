"""JSONB basics: insert dicts, read them back, and pull values out by path.

Run:  uv run --env-file .env src/examples/jsonb/01_read_paths.py

SQL operators covered
    ->    get JSON element (stays jsonb)        payload -> 'user'
    ->>   get element as text                   payload ->> 'device'
    #>>   get nested element as text by path    payload #>> '{user,country}'
"""

import asyncio

from _common import reset_events, run
from sqlalchemy import Integer, select

from db import SessionLocal
from models import Event


async def main() -> None:
    async with SessionLocal() as session:
        await reset_events(session)

        # 1. Whole row: the payload column comes back as a Python dict.
        doc = await session.scalar(select(Event).where(Event.kind == "error"))
        assert doc is not None
        print("\n=== payload is a plain dict on the ORM object")
        print("  ", type(doc.payload).__name__, doc.payload)

        # 2. `->` : Event.payload["user"] keeps the result as jsonb.
        await run(
            session,
            "-> keeps jsonb (nested object comes back as dict)",
            select(Event.id, Event.payload["user"]).where(Event.kind == "login"),
        )

        # 3. `->>` : .astext turns the element into text.
        await run(
            session,
            "->> via .astext (returns str)",
            select(Event.id, Event.payload["device"].astext).where(
                Event.kind == "login"
            ),
        )

        # 4. Nested path. Chaining [] works; on PG14+ SQLAlchemy renders it as subscript
        #    syntax `payload['user'] ->> 'country'` (older servers get `-> ... ->>`).
        await run(
            session,
            "nested via chained [] (subscript then ->>)",
            select(Event.id, Event.payload["user"]["country"].astext),
        )

        # 5. Tuple index emits the single `#>>` path operator instead.
        await run(
            session,
            "nested via tuple path (#>>)",
            select(Event.id, Event.payload[("user", "name")].astext),
        )

        # 6. Array element by integer index (0-based in Postgres too).
        await run(
            session,
            "first tag: array index",
            select(Event.id, Event.payload["tags"][0].astext),
        )

        # 7. Typed extraction: .as_integer() / .as_float() / .as_boolean() / .as_string()
        #    render `CAST(payload ->> 'code' AS INTEGER)` so you can filter/sort numerically.
        await run(
            session,
            "typed extraction with .as_integer()",
            select(Event.id, Event.payload["code"].as_integer()).where(
                Event.payload["code"].as_integer() >= 500
            ),
        )

        # 8. Same idea with an explicit cast, useful when the target type is not one of the as_*() helpers.
        await run(
            session,
            "explicit cast of user id, ordered numerically",
            select(
                Event.id,
                Event.payload[("user", "id")].astext.cast(Integer).label("user_id"),
            )
            .where(Event.payload.has_key("user"))
            .order_by("user_id"),
        )


if __name__ == "__main__":
    asyncio.run(main())
