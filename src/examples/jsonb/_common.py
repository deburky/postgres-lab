"""Shared bits for the JSONB examples: sample data + a helper that prints
the SQL SQLAlchemy generates next to the rows it returns."""

import json
from collections.abc import Sequence
from decimal import Decimal
from typing import Any

from sqlalchemy import Delete, Insert, Select, Update, delete
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.ddl import ExecutableDDLElement

from db import engine
from models import Base, Event

# Anything we can both compile() for display and hand to session.execute().
Statement = Select[Any] | Insert | Update | Delete | ExecutableDDLElement

SAMPLE_EVENTS: list[dict[str, Any]] = [
    {
        "kind": "login",
        "payload": {
            "user": {"id": 1, "name": "Ada", "country": "NG", "plan": "pro"},
            "device": "web",
            "tags": ["returning", "2fa"],
        },
    },
    {
        "kind": "login",
        "payload": {
            "user": {"id": 2, "name": "Bola", "country": "GH"},
            "device": "mobile",
            "tags": ["new"],
        },
    },
    {
        "kind": "purchase",
        "payload": {
            "user": {"id": 1, "name": "Ada", "country": "NG", "plan": "pro"},
            "amount": 4500.50,
            "currency": "NGN",
            "items": [
                {"sku": "A-1", "qty": 2, "price": 1000},
                {"sku": "B-7", "qty": 1, "price": 2500.50},
            ],
            "tags": ["promo"],
        },
    },
    {
        "kind": "purchase",
        "payload": {
            "user": {"id": 3, "name": "Chidi", "country": "NG"},
            "amount": 120,
            "currency": "NGN",
            "items": [{"sku": "C-3", "qty": 1, "price": 120}],
            "tags": [],
            "refunded": True,
        },
    },
    {
        "kind": "error",
        "payload": {"code": 500, "message": "upstream timeout", "tags": ["api"]},
    },
]


async def reset_events(session: AsyncSession) -> None:
    """Create the table if needed and reload the sample rows."""
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all, tables=[Base.metadata.tables[Event.__tablename__]]
        )
    await session.execute(delete(Event))
    session.add_all(Event(**row) for row in SAMPLE_EVENTS)
    await session.commit()


def show_sql(title: str, stmt: Statement) -> None:
    print(f"\n=== {title}")
    compiled = stmt.compile(dialect=postgresql.dialect())
    print(str(compiled).strip())
    if compiled.params:
        print(f"-- params: {compiled.params}")


def _cell(value: Any) -> str:
    """Render one value the way psql would."""
    if value is None:
        return ""  # psql shows NULL as blank by default
    if isinstance(value, bool):
        return "t" if value else "f"
    if isinstance(value, Event):
        return f"Event#{value.id}({value.kind})"
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(", ", ": "))
    return str(value)


def print_table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> None:
    """Print rows in psql's default aligned format:

     id | sku
    ----+-----
     28 | A-1
    (1 row)
    """
    cells = [[_cell(v) for v in row] for row in rows]
    numeric = [
        all(isinstance(row[i], (int, float, Decimal)) and not isinstance(row[i], bool)
            for row in rows if row[i] is not None)
        for i in range(len(headers))
    ]
    widths = [
        max(len(headers[i]), *(len(r[i]) for r in cells)) if cells else len(headers[i])
        for i in range(len(headers))
    ]
    print(" " + " | ".join(h.center(w) for h, w in zip(headers, widths)))
    print("-" + "-+-".join("-" * w for w in widths) + "-")
    for row in cells:
        print(" " + " | ".join(
            c.rjust(w) if numeric[i] else c.ljust(w) for i, (c, w) in enumerate(zip(row, widths))
        ))
    n = len(rows)
    print(f"({n} row{'' if n == 1 else 's'})")


async def run(session: AsyncSession, title: str, stmt: Statement) -> None:
    """Print the statement, execute it, print the result as a psql-style table."""
    show_sql(title, stmt)
    result = await session.execute(stmt)
    headers = list(result.keys())
    rows = [tuple(row) for row in result]
    print()
    print_table(headers, rows)
