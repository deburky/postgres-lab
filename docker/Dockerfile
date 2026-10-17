# Local PostgreSQL 16 with pgvector and pgvectorscale (Timescale's StreamingDiskANN index) preinstalled.
# Image docs: https://github.com/pgvector/pgvector#docker, https://github.com/timescale/pgvectorscale
FROM pgvector/pgvector:pg16

# pgvectorscale ships a .deb per Postgres major + CPU arch; pick the one matching this image.
ARG PGVECTORSCALE_VERSION=0.9.1
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    curl -fsSL -o /tmp/pgvectorscale.zip \
      "https://github.com/timescale/pgvectorscale/releases/download/${PGVECTORSCALE_VERSION}/pgvectorscale-${PGVECTORSCALE_VERSION}-pg16-${arch}.zip"; \
    unzip -o /tmp/pgvectorscale.zip -d /tmp/pgvectorscale; \
    apt-get install -y --no-install-recommends /tmp/pgvectorscale/*.deb; \
    rm -rf /tmp/pgvectorscale /tmp/pgvectorscale.zip /var/lib/apt/lists/*

# Any *.sql / *.sh in this directory runs once, on first start of an empty
# data directory, against $POSTGRES_DB as $POSTGRES_USER.
COPY initdb/ /docker-entrypoint-initdb.d/

# Sensible defaults for local dev; docker-compose.yml overrides them from the root .env.
ENV POSTGRES_USER=app \
    POSTGRES_PASSWORD=pwd \
    POSTGRES_DB=app

EXPOSE 5432
