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
- Consume events, evaluate triggers, publish campaigns: `services/campaign-engine/src/campaign/event-consumer.service.ts`, `trigger-evaluator.service.ts`, `campaign-publisher.service.ts`
- Multi-channel dispatch: `services/channel-delivery/src/consumer/campaign-consumer.service.ts` (`dispatchWaterfall`, `dispatchConcurrent`, `sendChannel`)
