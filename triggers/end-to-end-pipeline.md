# Triggers: end-to-end pipeline

This document walks through the **full path** from an HTTP event ingest request through RabbitMQ, campaign-engine trigger evaluation, and outbound campaign messages. Trigger **definitions** live in PostgreSQL and are managed via APIs; this doc focuses on **runtime** behavior when events flow through the system.

**Related:** [Quick reference](./triggers-pipeline-quick-reference.md) · [Campaign-engine triggers detail](../services/campaign-engine/docs/triggers-and-event-flow.md)

---

## Architecture overview

| Stage | Service | Primary transports |
|-------|---------|--------------------|
| Ingest API | `event-ingestion` | HTTP → RabbitMQ (topic exchange `ge.events`), ClickHouse, Redis |
| Trigger execution | `campaign-engine` | RabbitMQ queue `ge.events.raw.v1` → Redis + PostgreSQL → RabbitMQ `ge.campaigns` |
| Delivery | `channel-delivery` | Queue `ge.campaigns.outbound` (routing `campaigns.outbound.v1`) |

---

## Phase 1 — HTTP ingestion (`event-ingestion`)

**Entrypoint:** `POST /events` on the event-ingestion service (`EventsController.ingest`).

### Step 1 — Guards (before the handler body runs)

| Aspect | Detail |
|--------|--------|
| **What it does** | `BrandRateLimitGuard` enforces per-brand rate limits (Redis-backed). `HmacGuard` validates `X-Tenant-API-Key` against stored API keys (PostgreSQL `api_keys` / cache), optionally verifies HMAC of the **raw** request body using `X-GammaEngage-Signature-*` headers when `HMAC_SECRET` is set (dev may skip unsigned requests). |
| **Writes** | Rate-limit counters in **Redis**; API key lookups may use **Redis** cache. |
| **Conditions** | Missing/invalid API key → 401. Invalid signature → 401. Rate limit exceeded → throttled response. |

### Step 2 — JSON schema validation (controller)

| Aspect | Detail |
|--------|--------|
| **What it does** | Parses the body with Zod `EventEnvelopeInputSchema` (from `@gammaengage/shared`). Fills `ingested_at` to current ISO time if omitted. |
| **Writes** | None. |
| **Conditions** | `schema_version` must be `1.0`; `event_id` UUID; `player_ref` must include `external_player_id` or `visitor_id`; `idempotency_key` non-empty; datetime fields valid; etc. Zod errors become HTTP 4xx via `toHttpException`. |

### Step 3 — `EventsService.ingestEvent`

| Aspect | Detail |
|--------|--------|
| **What it does** | (1) Runs `validateEventEnvelope` (full `EventEnvelopeSchema` including `ingested_at`). (2) **Idempotency:** `RedisService.checkAndSetIdempotency(brand_id, idempotency_key)` — first seen key wins. (3) Optional **game enrichment** via game-catalog client; merges game metadata under `metadata.enrichment.game`. (4) Concurrently: publish raw event to RabbitMQ, publish a **profile update** message (if a player id can be derived), insert into ClickHouse. |
| **Writes** | **Redis:** idempotency key for `(brand_id, idempotency_key)`. **RabbitMQ:** topic exchange `ge.events` (configurable), routing key default `events.raw.v1` → queue **`ge.events.raw.v1`**; second routing key `player.profile.updates` → queue **`ge.player.profile.updates`**. **ClickHouse:** raw events table (e.g. analytics / `events_raw` pipeline — see `ClickHouseService`). |
| **Conditions** | Duplicate idempotency key → `DuplicateEventError` → HTTP **409 Conflict**. Game enrichment failure is logged; ingest continues. RabbitMQ publish retries up to 3 times; failure throws and fails the request. |

---

## Phase 2 — Campaign engine event consumer (`campaign-engine`)

**Consumer:** `EventConsumerService` subscribes to **`ge.events.raw.v1`** (prefetch 10), with DLQ/retry via `assertQueueWithDlq` in `@gammaengage/shared`.

### Step 4 — Deliver message from queue

| Aspect | Detail |
|--------|--------|
| **What it does** | AMQP delivers JSON payload; request id may be taken from message headers for logging (`ClsService`). |
| **Writes** | None (read from queue). |
| **Conditions** | — |

### Step 5 — Parse and validate envelope

| Aspect | Detail |
|--------|--------|
| **What it does** | `JSON.parse` then `validateEventEnvelope` (same Zod schema as ingestion). |
| **Writes** | None. |
| **Conditions** | Invalid JSON or schema → message is **logged and discarded** (ack still happens later after empty processing path — invalid payloads do not throw). No DB/Redis updates for bad envelopes. |

### Step 6 — Update aggregated player state (Redis)

| Aspect | Detail |
|--------|--------|
| **What it does** | `PlayerStateService.updateFromEvent` loads existing state from Redis (if any), merges the event via `reduceEventIntoState`, writes back. |
| **Writes** | **Redis** key `player_state:{brand_id}:{player_id}` with TTL 90 days. |
| **Conditions** | `player_id` derived from `external_player_id` or `visitor_id`; empty string if both missing (state key still used). |

### Step 7 — Player snapshot (PostgreSQL, async)

| Aspect | Detail |
|--------|--------|
| **What it does** | `SnapshotService.upsertFromState(playerState)` — fire-and-forget; failures logged only. |
| **Writes** | **PostgreSQL** table **`player_snapshots`** — insert first version or update latest row for `(brand_id, player_id)` per service logic. |
| **Conditions** | Non-blocking; trigger path does not wait for success. |

### Step 8 — Conversion attribution (`checkConversion`)

| Aspect | Detail |
|--------|--------|
| **What it does** | For the current event, looks for **recent** rows in **`campaign_delivery_logs`** (30-day window), joins to **`campaigns`** where `conversion_event_types` includes this `event_type`, checks per-campaign **`attribution_window_hours`** (default 72h) from send time, then inserts a conversion if inside the window. |
| **Writes** | **PostgreSQL** **`campaign_conversions`** via `INSERT … ON CONFLICT DO NOTHING` (unique on brand, campaign, player, converted event type). Revenue read from payload (`amount` / `transaction_amount` / `revenue`). |
| **Conditions** | No `player_id` → skip. No recent delivery logs → skip. Event type not in campaign’s conversion list → skip. Outside attribution window → skip. |

### Step 9 — Journey enrollment (parallel path, not the same as “trigger” rows)

| Aspect | Detail |
|--------|--------|
| **What it does** | If `JourneyService` is injected and `player_id` non-empty: `enrollFromEvent` loads **active** journeys with `trigger_event_type` = this event’s type. Evaluates `entry_conditions` against **player state** when present. `tryEnroll` may delete/replace enrollment depending on `re_enrollment`. |
| **Writes** | **PostgreSQL** **`journey_enrollments`** — insert new active enrollment with `next_step_at` from first step delay; or delete existing row when re-enrolling. |
| **Conditions** | Entry conditions failing → skip that journey. `re_enrollment: never` and already enrolled → skip. |

### Step 10 — Trigger evaluation

| Aspect | Detail |
|--------|--------|
| **What it does** | `TriggerEvaluatorService.evaluate` loads **`triggers`** from PostgreSQL where `brand_id`, `event_type` match and `is_active = true`. For each trigger, evaluates **all** `conditions` (AND). Optional **AI scores** (`churn_score`, `vip_score`, `rg_risk_score`) fetched once via `NbaService` if any trigger needs them. **Segment** conditions use `SegmentationService.playerMatchesSegment`. **Sequential** triggers use Redis key `seq:{brand_id}:{player_id}:{sequence_id}` to track step order and optional time window; on completion the key is deleted and one `MatchedTrigger` is emitted. **Single-event** triggers emit `MatchedTrigger` when conditions pass. |
| **Writes** | **PostgreSQL:** read-only on `triggers`. **Redis:** sequence progress keys (SET/EX with TTL; DEL on reset/complete). |
| **Conditions** | If `NbaService` reports player **RG-blocked**, **no** triggers match (empty array). AI condition but scores unavailable → that condition fails. Wrong sequence step can reset or defer firing (see `trigger-evaluator.service.ts`). Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`; segment uses `segment_id` with `eq`/`neq`. |

### Step 11 — Publish one outbound message per matched trigger

| Aspect | Detail |
|--------|--------|
| **What it does** | For each `MatchedTrigger`, `CampaignPublisherService.publishCampaign` loads **`campaigns`**, assigns **A/B test** variant via `AbTestService`, computes **control group** (A/B control flag or deterministic hash vs `control_group_pct`). Builds `CampaignOutboundMessage` with templates (variant B overrides). If **not** control group, `ConversionTrackerService.logDelivery` records the send. Publishes to exchange **`ge.campaigns`**, routing key **`campaigns.outbound.v1`**, bound to queue **`ge.campaigns.outbound`**. |
| **Writes** | **PostgreSQL:** read `campaigns`; **insert** **`campaign_delivery_logs`** when not in control group (for later attribution). **RabbitMQ:** persistent JSON message (control-group messages still published; downstream skips actual delivery when `is_control_group` is true). |
| **Conditions** | Missing campaign row still builds message with empty templates (loader returns null — verify behavior in code paths). Control group skips delivery log. |

### Step 12 — Ack / retry / DLQ

| Aspect | Detail |
|--------|--------|
| **What it does** | On success, **ack** the raw event message. On thrown errors, **republish** to retry queue or **DLQ** per shared helper; then ack original. |
| **Writes** | RabbitMQ retry/DLQ mechanics. |
| **Conditions** | Retries capped by `DEFAULT_MAX_RETRIES` and backoff settings in shared package. |

---

## Phase 3 — Channel delivery (`channel-delivery`)

**Consumer:** `CampaignConsumerService` reads **`ge.campaigns.outbound`**.

| Aspect | Detail |
|--------|--------|
| **What it does** | Parses `CampaignOutboundMessage`, resolves contact info, applies suppression, contact policy, templates, per-channel send (email, SMS, push, etc.). Respects `is_control_group` to skip real sends while still allowing analytics/forwarding as implemented. |
| **Writes** | Varies by channel (provider APIs, logs). Not part of campaign-engine’s trigger tables. |
| **Conditions** | Throttling, unsubscribe/suppression, waterfall channel ordering when configured. |

---

## Summary: who writes what (runtime)

| Store | Typical writes on one successful event path |
|-------|---------------------------------------------|
| **Redis (ingestion)** | Idempotency key; rate limits |
| **Redis (campaign-engine)** | `player_state:…`; optional `seq:…` for sequences |
| **PostgreSQL** | `player_snapshots`; `campaign_conversions?`; `journey_enrollments?`; read `triggers`; `campaign_delivery_logs` per non-control send |
| **ClickHouse (ingestion)** | Raw event stream |
| **RabbitMQ** | In: `ge.events.raw.v1` · Out: `ge.campaigns.outbound` |

**Not written at runtime:** definitions in **`triggers`** (those are created/updated via campaign management APIs, not when an event fires).
