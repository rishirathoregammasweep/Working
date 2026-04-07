# Player traffic vs campaigns — bullets (with one-line examples)

## How the split helps

- **Ingestion stays fast while campaigns do heavy work** — e.g. `POST /events` does not run every trigger synchronously; `campaign-engine` consumes `ge.events.raw.v1` async.
- **Change delivery without touching the public ingest API** — e.g. add a webhook path in `channel-delivery` without redeploying `event-ingestion`.
- **Clear queue contracts between “facts” and “sends”** — e.g. raw events → `ge.events.raw.v1`, outbound work → `ge.campaigns.outbound`.
- **Module isolation in-repo** — e.g. no service queries another service’s DB; use RabbitMQ and read-only HTTP where documented in root `README.md`.

## Player traffic (separate path)

- **`event-ingestion` — accept, dedupe, store, publish** — e.g. Redis `idem:*` then insert `events_raw` and publish to `ge.events.raw.v1` (port 3001 typical).
- **Per-brand rate limits on public routes** — e.g. 429 + `Retry-After` when a brand exceeds the Redis counter window.
- **SSE from browsers / SDK** — e.g. `GET /sse/campaigns?brand_id=&player_id=` holds long-lived connections for popups.
- **`player-profile` — durable profile + GDPR** — e.g. `DELETE .../gdpr` with `X-API-Key` anonymises across Postgres/ClickHouse/graph.
- **`game-catalog` — enrich events with game metadata** — e.g. HTTP lookup during ingest before write.
- **`identity-engine` — link identities from events** — e.g. consumer on `ge.events` builds the identity graph.
- **`analytics` / `ai-engine` — read-heavy scoring & reports** — e.g. `POST /player` scoring with a sub-200ms style target in `ai-engine`.

## Campaign handling (separate path)

- **`campaign-engine` — consume raw events, evaluate rules, publish sends** — e.g. update Redis `player_state:...` then push matches to `ge.campaigns`.
- **Campaign definitions & scheduler** — e.g. REST on port 3003; cron/scheduled sends go to `ge.campaigns.outbound`.
- **`channel-delivery` — actually send (email/SMS/push/webhook/SSE)** — e.g. consumer on `ge.campaigns.outbound` with throttles and quiet hours envs.
- **Admin paths stay off the hot ingest path** — e.g. suppressions via `tenant-admin` proxy to `channel-delivery` for audit + audit log.

## Flow (one glance)

- **Casino → ingest → facts** — e.g. wallet → `event-ingestion` → ClickHouse + `ge.events.raw.v1`.
- **Facts → decisions → queue** — e.g. `campaign-engine` → triggers → `ge.campaigns` / outbound.
- **Queue → channels** — e.g. `channel-delivery` → Sendgrid/Twilio/SSE bus as configured.
- **Parallel consumers** — e.g. `player-profile` and `identity-engine` also read the event stream without blocking ingest.

## Planning: where to look

- **Spikes, API keys, idempotency** — e.g. scale `event-ingestion` + Redis for limits and `idem:*`.
- **Triggers, journeys, schedules** — e.g. tune `campaign-engine` replicas and Postgres/Redis for that service.
- **Provider slowness, caps, compliance sends** — e.g. `channel-delivery` + `DAILY_SEND_CAP`, retries, DLQ patterns in `infra/deploy.py`.
- **PII / erasure** — e.g. `player-profile` GDPR endpoints and `gdpr_erasure_log`.

## Why not one mega-service

- **Different scale knobs** — e.g. ingest needs many stateless replicas; delivery may need fewer instances but longer timeouts.
- **Smaller blast radius** — e.g. a bug in Twilio integration should not kill `POST /events`.
- **Independent release trains** — e.g. ship campaign templates weekly without freezing event schema changes.
- **Mixed runtimes** — e.g. Nest `channel-delivery` vs Python `ai-engine` vs ClickHouse writers in one image is heavy operationally.
- **Network boundaries** — e.g. keep internal profile APIs off the same public ingress as raw event POST unless you add a gateway anyway.
- **Easier incidents** — e.g. “Rabbit backlog on `ge.campaigns.outbound`” vs “ClickHouse insert errors” show up in different health checks.

## Related docs

- [database-migrations.md](./database-migrations.md)
- [../README.md](../README.md) (rate limits, isolation)
- [../services/event-ingestion/README.md](../services/event-ingestion/README.md)
