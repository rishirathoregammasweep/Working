# Trigger flow when events arrive from the app

This document explains how a player or app event becomes outbound messaging across **multiple channels** (email, SMS, push, web push, WhatsApp, in-app/SSE, etc.) in this platform.

## End-to-end flow (high level)

1. **Ingest** — The casino app (or server) sends a validated **event envelope** to **event-ingestion** (HTTP). Idempotency is checked; optional enrichment runs; the event is written to analytics storage and published to the raw events queue.
2. **Campaign engine** — **campaign-engine** consumes from the raw events queue, updates **player state**, snapshots, conversion checks, and optional **journey** enrollment, then **evaluates triggers**.
3. **Triggers** — For each active trigger whose `event_type` matches and whose **conditions** pass (against player state, event payload, and optional scores), the engine builds a **matched trigger**. Single-event triggers fire immediately; **sequential** triggers advance Redis-backed sequence state until the full sequence completes.
4. **Campaign publish** — Each match is turned into an outbound message: campaign templates are loaded, **A/B test** and **control group** logic apply, and the message is published to RabbitMQ (`ge.campaigns` exchange, routing key `campaigns.outbound.v1`).
5. **Channel delivery** — **channel-delivery** consumes `ge.campaigns.outbound`, resolves the player’s contact info, applies suppression and policy, renders templates, then sends on one or more **channels** according to the campaign’s delivery mode.

## Diagram

```mermaid
flowchart LR
  subgraph App["Casino app / backend"]
    E[Player action → event]
  end

  subgraph Ingest["event-ingestion"]
    API[HTTP ingest]
    ID[Idempotency + optional enrichment]
    Q1[(ge.events.raw.v1)]
  end

  subgraph CE["campaign-engine"]
    EC[Event consumer]
    PS[Player state + snapshot]
    CV[Conversion tracker]
    JY[Journey enrollment]
    TE[Trigger evaluator]
    CP[Campaign publisher]
  end

  subgraph MQ2["RabbitMQ"]
    EX[ge.campaigns exchange]
    Q2[(ge.campaigns.outbound)]
  end

  subgraph CD["channel-delivery"]
    CC[Campaign consumer]
    R[Render + policy + suppression]
    CH{Delivery mode}
    WF[Waterfall: try channels in order]
    CCr[Concurrent: all channels in parallel]
    OUT[Per-channel send]
  end

  E --> API --> ID --> Q1
  Q1 --> EC --> PS --> CV --> JY --> TE --> CP
  CP --> EX --> Q2 --> CC --> R --> CH
  CH --> WF --> OUT
  CH --> CCr --> OUT
```

## UML diagrams

The **PlantUML** blocks below are standard UML (component + sequence). Paste them into [PlantUML Live](https://www.plantuml.com/plantuml/uml) or use a VS Code / IDE PlantUML extension to render. The **Mermaid** sequence diagram is the same flow in a form many Markdown viewers render natively (including GitHub).

### Component diagram (services, queues, data stores)

```plantuml
@startuml trigger-flow-components
skinparam componentStyle rectangle
skinparam linetype ortho

actor "Casino app\nor BFF" as App

package "event-ingestion" <<service>> {
  [EventsController\n/ EventsService] as EI
}

package "campaign-engine" <<service>> {
  [EventConsumerService] as EC
  [PlayerStateService\nSnapshotService\nConversionTracker\nJourneyService] as PS
  [TriggerEvaluatorService] as TE
  [CampaignPublisherService] as CP
}

package "channel-delivery" <<service>> {
  [CampaignConsumerService\n+ channel adapters] as CD
}

cloud "Message broker" {
  queue "ge.events.raw.v1" as Qraw
  queue "ge.campaigns.outbound" as Qout
}

database "PostgreSQL" as PG {
  card "triggers, campaigns,\nplayer_snapshots,\njourneys, conversions,\ntracking…" as pgc
}

database "Redis" as RD {
  card "idempotency,\nplayer_state,\ntrigger seq:*,\nthrottle" as rdc
}

database "ClickHouse" as CH {
  card "events_raw,\nplayer_state,\nanalytics buffers" as chc
}

App --> EI : <<async>>\nHTTP POST event
EI --> RD : idempotency
EI --> CH : events_raw (+ optional player_state)
EI --> Qraw : publish envelope

Qraw --> EC : consume
EC --> PS : update state,\nsnapshot, conversions,\njourneys
PS --> RD : SET player_state
PS --> PG : INSERT/UPDATE snapshots,\nconversions, enrollments
EC --> TE : evaluate
TE --> PG : <<read>> triggers,\ncampaigns
TE --> RD : GET/SET seq:*\n(sequential triggers)
TE --> CP : MatchedTrigger[]
CP --> PG : <<read>> campaign;\nINSERT delivery_log\n(if not control)
CP --> Qout : publish outbound\nmessage

Qout --> CD : consume
CD --> PG : contact, suppression,\ntracking tokens
CD --> RD : throttle INCR
CD --> CH : campaign.dispatched,\nemail.open/click
CD --> App : SMS / email /\npush / …

@enduml
```

### Sequence diagram (happy path: one event → one campaign send)

```plantuml
@startuml trigger-flow-sequence
autonumber
actor "Casino app" as App
participant "event-ingestion" as EI
participant "Redis\n(idempotency)" as R0
participant "ClickHouse" as CH
participant "ge.events.raw.v1" as Q1
participant "campaign-engine\nEventConsumer" as CE
participant "Redis\n(player_state)" as R1
participant "PostgreSQL" as PG
participant "TriggerEvaluator\n+ Publisher" as TE
participant "ge.campaigns.outbound" as Q2
participant "channel-delivery" as CD

App -> EI: ingest EventEnvelope
activate EI
EI -> R0: checkAndSetIdempotency
EI -> CH: insert events_raw
EI -> Q1: publish
deactivate EI

Q1 -> CE: deliver message
activate CE
CE -> R1: SET player_state
CE -> PG: upsert player_snapshots
CE -> PG: checkConversion (read logs;\nmaybe INSERT conversion)
CE -> PG: journey enroll (optional)
CE -> TE: evaluate + publish
activate TE
TE -> PG: SELECT triggers
TE -> R1: sequence state (if needed)
TE -> PG: SELECT campaign, A/B;\nINSERT campaign_delivery_logs
TE -> Q2: publish CampaignOutboundMessage
deactivate TE
deactivate CE

Q2 -> CD: deliver message
activate CD
CD -> PG: load contact, suppression
CD -> CD: render, dispatch channels
CD -> CH: forward campaign.dispatched
deactivate CD

@enduml
```

### Sequence diagram (Mermaid — for Markdown preview)

```mermaid
sequenceDiagram
  autonumber
  actor App as Casino app
  participant EI as event-ingestion
  participant R0 as Redis (idempotency)
  participant CH as ClickHouse
  participant Q1 as ge.events.raw.v1
  participant CE as campaign-engine
  participant R1 as Redis (player_state)
  participant PG as PostgreSQL
  participant TE as Triggers + publisher
  participant Q2 as ge.campaigns.outbound
  participant CD as channel-delivery

  App->>EI: POST EventEnvelope
  EI->>R0: idempotency SET
  EI->>CH: insert events_raw
  EI->>Q1: publish

  Q1->>CE: consume
  CE->>R1: SET player_state
  CE->>PG: snapshot upsert
  CE->>PG: conversions / journeys (optional)
  CE->>TE: evaluate + publish
  TE->>PG: read triggers, campaigns
  TE->>R1: seq state (sequential triggers)
  TE->>PG: insert delivery_log (non-control)
  TE->>Q2: publish outbound

  Q2->>CD: consume
  CD->>PG: contact, suppression, tracking
  CD->>CH: campaign.dispatched (async)
  CD-->>App: channel sends (email, SMS, …)
```

## When Postgres, Redis, and ClickHouse write

Writes are listed in roughly the order they happen along the path. Some steps are **reads only** (for example loading active triggers); those are noted briefly so it is clear where the database is touched.

### 1. Event ingestion (`event-ingestion`)

| Store | What happens |
|--------|----------------|
| **Redis** | **Idempotency:** `checkAndSetIdempotency` records the `(brand_id, idempotency_key)` so duplicate HTTP submits are rejected before side effects. |
| **ClickHouse** | **`events_raw`:** each accepted envelope is inserted for analytics and raw replay. |
| **ClickHouse** | **`player_state` (optional):** after the raw insert, a fire-and-forget path may insert a row for **deposit / bet / session / registration**-style events (aggregated counters in ClickHouse; separate from Redis player state in campaign-engine). |
| **RabbitMQ** | Publish to the raw events queue and profile-update stream (not DB/Redis/CH, but part of the same ingest step). |

### 2. Campaign engine (`campaign-engine`, one message from `ge.events.raw.v1`)

| Store | What happens |
|--------|----------------|
| **Redis** | **`player_state:{brand_id}:{player_id}`:** merged state is **SET** with TTL after each event (`PlayerStateService.updateFromEvent`). This is what trigger conditions use. |
| **Postgres** | **`player_snapshots`:** **insert** on first seen player, else **update** in place (`SnapshotService.upsertFromState`) — async/non-blocking relative to ack in practice but still part of processing. |
| **Postgres** | **Conversion tracking:** **reads** `campaign_delivery_logs` and `campaigns`; if the event matches a campaign’s conversion type inside the attribution window, **`campaign_conversions`** gets an **insert** (`INSERT … ON CONFLICT DO NOTHING`). |
| **Postgres** | **Journeys (optional):** if a journey matches the event and entry rules, **`journey_enrollments`** may be **inserted** or prior rows **deleted/updated** (`JourneyService.enrollFromEvent`). |
| **Postgres** | **Triggers:** **read** active rows from **`triggers`** for `brand_id` + `event_type` (no write on evaluate). |
| **Redis** | **Sequential triggers:** keys `seq:{brand_id}:{player_id}:{sequence_id}` are **SET** / **DEL** as steps complete (`TriggerEvaluatorService`). |
| **Postgres** | **Campaign publish:** **read** `campaigns` (and A/B logic). When the player is **not** in the control group, **`campaign_delivery_logs`** gets a **save** (`ConversionTrackerService.logDelivery`) so later conversions can be attributed. |
| **Postgres** | **Conversions:** no extra write at publish beyond the delivery log above; conversion rows appear on **later** events when `checkConversion` matches. |

### 3. Channel delivery (`channel-delivery`, outbound message)

| Store | What happens |
|--------|----------------|
| **Postgres** | **Email tracking:** when email HTML is instrumented, **open/click tokens** are **inserted** into the tracking table (`TrackingService.createOpenToken` / `createClickToken`). |
| **Redis** | **Send throttle:** if daily caps apply, counters may be **INCR** / **EXPIRE** (and **DECR** on failure paths) per player/channel (`SendThrottleService`). |
| **ClickHouse** | **`events_raw_buffer`:** after dispatch, a **`campaign.dispatched`** row is forwarded for analytics (`CampaignEventForwarderService` → non-blocking). |
| **Postgres** | **Email opens/clicks:** when a tracking URL is hit, **`fired_at`** is **updated** on the token row; then **ClickHouse** receives **`email.opened`** / **`email.clicked`** via the same forwarder pattern. |

### Summary diagram (storage touchpoints)

```mermaid
flowchart TB
  subgraph ingest["event-ingestion"]
    R1[(Redis idempotency)]
    CH1[(CH events_raw)]
    CH1b[(CH player_state optional)]
  end

  subgraph ce["campaign-engine"]
    R2[(Redis player_state)]
    PG1[(PG player_snapshots)]
    PG2[(PG conversions + delivery logs + journeys)]
    R3[(Redis seq: triggers)]
    PG3[(PG triggers read, campaigns read)]
  end

  subgraph cd["channel-delivery"]
    PG4[(PG email tracking)]
    R4[(Redis throttle)]
    CH2[(CH campaign.dispatched + opens/clicks)]
  end

  ingest --> ce --> cd
```

## Multiple channels

### Where channels are defined

- **Triggers** store a comma-separated channel list (for example `email,sms,push`), which becomes the `channels` array on the outbound message.
- **Campaigns** can set **`waterfall`**: when true, channel-delivery tries channels **in list order** and **stops after the first successful** handoff; when false, it attempts **all listed channels concurrently** (`Promise.allSettled`).

So “multiple channels” can mean:

| Mode | Behaviour |
|------|-----------|
| **Concurrent** (default) | Email, SMS, push, etc. are all attempted for the same campaign send (subject to suppression, caps, and missing contact details per channel). |
| **Waterfall** | Same ordered list, but only until one channel succeeds — useful when you want a single best-effort path (for example SMS first, then email). |

### Supported delivery paths (conceptual)

Channel-delivery routes each channel name to the appropriate integration (email provider, SMS, mobile push, web push registry, WhatsApp, SSE/popup for in-app, etc.). Each path can independently fail, be suppressed, or be retried according to service rules.

### After send

- A **`campaign.dispatched`** style event can be forwarded to analytics (for example ClickHouse).
- **Webhooks** can be notified for downstream systems.

## Key queues and exchange (reference)

| Name | Role |
|------|------|
| `ge.events.raw.v1` | Raw validated events for campaign-engine consumption |
| `ge.campaigns` (topic) + `campaigns.outbound.v1` | Routed messages to `ge.campaigns.outbound` for channel-delivery |

## Related code (for maintainers)

- Ingest and publish to raw queue: `services/event-ingestion/src/events/events.service.ts`, `rabbitmq.service.ts`
- ClickHouse on ingest: `services/event-ingestion/src/events/clickhouse.service.ts` (`events_raw`, optional `player_state`)
- Redis idempotency: `services/event-ingestion/src/events/redis.service.ts` (used from `events.service.ts`)
- Consume events, evaluate triggers, publish campaigns: `services/campaign-engine/src/campaign/event-consumer.service.ts`, `trigger-evaluator.service.ts`, `campaign-publisher.service.ts`
- Redis player state: `services/campaign-engine/src/player-state/player-state.service.ts`; sequential triggers: `trigger-evaluator.service.ts`
- Postgres snapshots and conversions: `services/campaign-engine/src/snapshot/snapshot.service.ts`, `conversions/conversion-tracker.service.ts`
- Multi-channel dispatch: `services/channel-delivery/src/consumer/campaign-consumer.service.ts` (`dispatchWaterfall`, `dispatchConcurrent`, `sendChannel`)
- ClickHouse forward from delivery: `services/channel-delivery/src/analytics/campaign-event-forwarder.service.ts`, `tracking/tracking.service.ts`
