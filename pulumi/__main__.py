"""Access as code for the playground database.

Owns *who may do what*: roles, memberships, grants and default privileges.
Does not own *what exists*: tables, schemas and extensions stay in the application / Alembic.

    cd pulumi
    pulumi preview          # the "check": diff of the spec against the live cluster
    pulumi up               # apply the difference
    pulumi destroy          # drop everything this stack created

Connection settings come from the stack config (Pulumi.<stack>.yaml); passwords are secrets.
"""

import pulumi_postgresql as pg

import pulumi

cfg = pulumi.Config()
database = cfg.get("database") or "app"
schemas = cfg.get_object("schemas") or ["public"]
owner = cfg.get("owner") or "app"  # role that creates tables

# -------------------------------------------------------------------------------
# Provider: how Pulumi reaches the cluster (host/port/user/password from Pulumi.<stack>.yaml)
# -------------------------------------------------------------------------------
provider = pg.Provider(
    "pg",
    host=cfg.require("host"),
    port=cfg.get_int("port") or 5432,
    username=cfg.require("username"),
    password=cfg.require_secret("password"),
    database=database,
    sslmode=cfg.get("sslmode") or "disable",
    superuser=False,  # we do not need to read pg_authid
)
opts = pulumi.ResourceOptions(provider=provider)

# -------------------------------------------------------------------------------
# Sequencing helper
# -------------------------------------------------------------------------------
# Grants on the same objects must not run in parallel (Postgres: "tuple concurrently updated"),
# so every privilege resource is chained after the previous one with depends_on.
_tail: list[pulumi.Resource] = []


def chained(factory, name: str, **kwargs) -> pulumi.Resource:
    res = factory(
        name,
        **kwargs,
        opts=pulumi.ResourceOptions(provider=provider, depends_on=list(_tail)),
    )
    _tail[:] = [res]
    return res


# -------------------------------------------------------------------------------
# Group roles (NOLOGIN): the privilege sets. Users get access by membership, never directly.
# -------------------------------------------------------------------------------
app_ro = pg.Role("app_ro", name="app_ro", login=False, opts=opts)
app_rw = pg.Role("app_rw", name="app_rw", login=False, opts=opts)

RO_TABLE = ["SELECT"]
RW_TABLE = ["SELECT", "INSERT", "UPDATE", "DELETE"]
RW_SEQUENCE = ["USAGE", "SELECT", "UPDATE"]

for schema in schemas:
    # both groups may see the schema
    for gname, role in (("app_ro", app_ro), ("app_rw", app_rw)):
        chained(
            pg.Grant,
            f"{schema}-{gname}-usage",
            role=role.name,
            database=database,
            schema=schema,
            object_type="schema",
            privileges=["USAGE"],
        )

    # existing objects
    chained(
        pg.Grant,
        f"{schema}-ro-tables",
        role=app_ro.name,
        database=database,
        schema=schema,
        object_type="table",
        privileges=RO_TABLE,
    )
    chained(
        pg.Grant,
        f"{schema}-rw-tables",
        role=app_rw.name,
        database=database,
        schema=schema,
        object_type="table",
        privileges=RW_TABLE,
    )
    chained(
        pg.Grant,
        f"{schema}-rw-sequences",
        role=app_rw.name,
        database=database,
        schema=schema,
        object_type="sequence",
        privileges=RW_SEQUENCE,
    )

    # objects `owner` creates in the future (otherwise every new table needs a new GRANT)
    chained(
        pg.DefaultPrivileges,
        f"{schema}-ro-future-tables",
        role=app_ro.name,
        database=database,
        schema=schema,
        owner=owner,
        object_type="table",
        privileges=RO_TABLE,
    )
    chained(
        pg.DefaultPrivileges,
        f"{schema}-rw-future-tables",
        role=app_rw.name,
        database=database,
        schema=schema,
        owner=owner,
        object_type="table",
        privileges=RW_TABLE,
    )
    chained(
        pg.DefaultPrivileges,
        f"{schema}-rw-future-sequences",
        role=app_rw.name,
        database=database,
        schema=schema,
        owner=owner,
        object_type="sequence",
        privileges=RW_SEQUENCE,
    )

# -------------------------------------------------------------------------------
# Login roles: people and services, each a member of exactly one group.
# -------------------------------------------------------------------------------
users = cfg.get_object("users") or {}  # {"name": {"member_of": "app_ro" | "app_rw"}}
groups = {"app_ro": app_ro, "app_rw": app_rw}
for name, spec in users.items():
    pg.Role(
        name,
        name=name,
        login=True,
        password=cfg.require_secret(
            f"password_{name}"
        ),  # pulumi config set --secret password_<name> ...
        roles=[groups[spec["member_of"]].name],
        opts=opts,
    )

pulumi.export("groups", [app_ro.name, app_rw.name])
pulumi.export("users", list(users))
pulumi.export("schemas", schemas)
