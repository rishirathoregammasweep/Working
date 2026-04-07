# Event trigger → channel delivery (events → campaigns → channels)

This document describes how **raw player events** flow through **campaign-engine** (trigger evaluation, campaign publish) into **RabbitMQ**, then **channel-delivery**, where messages are sent on **email, SMS, push, web push, popup, WhatsApp**, etc.

It complements [scheduled-campaign-flow.md](./scheduled-campaign-flow.md), which covers **scheduled** bulk sends. Here the entrypoint is **`ge.events.raw.v1`**, not the scheduler.

---

## 1. High-level architecture

```mermaid
flowchart TB
  subgraph ingest["Ingest"]
    RAW["Queue: ge.events.raw.v1"]
  end

  subgraph ce["campaign-engine"]
    EC["EventConsumerService"]
    PS["PlayerStateService"]
    SN["SnapshotService"]
    CV["ConversionTrackerService"]
    JY["JourneyService optional"]
    TE["TriggerEvaluatorService"]
    TR[(PostgreSQL triggers)]
    CP["CampaignPublisherService"]
    CA[(PostgreSQL campaigns)]
  end

  subgraph mq["RabbitMQ"]
    EX["Exchange: ge.campaigns"]
    Q["Queue: ge.campaigns.outbound"]
    RK["Routing key: campaigns.outbound.v1"]
  end

  subgraph cd["channel-delivery"]
    CC["CampaignConsumerService"]
    PP["PlayerProfileClient"]
    TH["Send throttle / suppression / frequency caps"]
    SEND["Per-channel send"]
  end

  RAW --> EC
  EC --> PS
  EC --> SN
  EC --> CV
  EC --> JY
  EC --> TE
  TE --> TR
  TE -->|matched triggers| CP
  CP --> CA
  CP --> EX
  EX --> RK
  RK --> Q
  Q --> CC
  CC --> PP
  CC --> TH
  CC --> SEND
```

---

## 2. Where `channels` come from (trigger vs campaign)

Both **`triggers`** and **`campaigns`** store a comma-separated channel list (e.g. `email,sms,push`). **They can differ** by design.

| Path | Channels used in the outbound message | Templates / waterfall / control group |
|------|----------------------------------------|--------------------------------------|
| **Event-driven** (`MatchedTrigger`) | **`triggers.channels`** (split to array in `buildMatchedTrigger`) | **`campaigns`** row loaded in `CampaignPublisherService` |
| **Scheduled** (`SchedulerService.dispatchToPlayers`) | **`campaigns.channels`** | Same campaign row |

```mermaid
flowchart LR
  subgraph eventPath["Event path"]
    T["Trigger row\nchannels"]
    M["CampaignOutboundMessage.channels"]
    T --> M
  end

  subgraph schedPath["Scheduled path"]
    C["Campaign row\nchannels"]
    M2["CampaignOutboundMessage.channels"]
    C --> M2
  end
```

---

## 3. Sequence: event → evaluate → publish → deliver

```mermaid
sequenceDiagram
  autonumber
  participant Q1 as RabbitMQ ge.events.raw.v1
  participant EC as EventConsumerService
  participant PS as PlayerStateService
  participant TE as TriggerEvaluatorService
  participant DB as DB triggers
  participant CP as CampaignPublisherService
  participant CA as DB campaigns
  participant Q2 as RabbitMQ ge.campaigns.outbound
  participant CD as CampaignConsumerService
  participant PP as PlayerProfileClient
  participant EM as EmailService

  Q1->>EC: validated EventEnvelope
  EC->>PS: updateFromEvent
  Note over EC: snapshot, conversions, journey enrollment
  EC->>TE: evaluate(envelope, playerState)
  TE->>DB: find active triggers brand_id + event_type

  alt No match / RG block / conditions fail
    TE-->>EC: matchedTriggers = []
    Note over EC: no publish
  else One or more matches
    loop Each MatchedTrigger
      TE-->>EC: trigger_id, campaign_id, channels, …
      EC->>CP: publishCampaign(trigger)
      CP->>CA: findOne campaign
      CP->>Q2: JSON CampaignOutboundMessage
    end
  end

  Q2->>CD: consume message
  alt Control group or throttled
    CD-->>CD: return early
  else Deliver
    CD->>PP: getContact
    CD->>CD: render templates waterfall or concurrent
    CD->>EM: email if channel selected and contact OK
  end
```

---

## 4. Trigger evaluation (decision flow)

```mermaid
flowchart TD
  A[Load triggers for brand_id + event_type + is_active] --> B{Any triggers?}
  B -->|No| Z[Return empty array — nothing published]
  B -->|Yes| C{Need AI scores?}
  C -->|Yes| D[Fetch NBA scores]
  C -->|No| E[Evaluate conditions per trigger]
  D --> F{RG blocked?}
  F -->|Yes| Z
  F -->|No| E
  E --> G{All conditions met?}
  G -->|No| H[Skip trigger]
  G -->|Yes| I{sequence_id set?}
  I -->|No| J[Single-event match — build MatchedTrigger]
  I -->|Yes| K[Sequence logic in Redis]
  K --> L{Sequence complete?}
  L -->|No| M[Persist progress or reset — no fire]
  L -->|Yes| J
  H --> N{More triggers?}
  J --> N
  M --> N
  N -->|Yes| E
  N -->|No| O[Return MatchedTrigger list]
```

---

## 5. channel-delivery: dispatch modes

```mermaid
flowchart TD
  IN[Consume CampaignOutboundMessage] --> CG{is_control_group?}
  CG -->|yes| SKIP1[Log and return]
  CG -->|no| TH[SendThrottle checkAndRecord]
  TH -->|blocked| SKIP2[Return]
  TH -->|ok| CONTACT[PlayerProfile getContact]
  CONTACT --> REND[TemplateService.renderAll]
  REND --> WF{waterfall?}
  WF -->|yes| WLOOP[For each channel in order try sendChannel stop on first success]
  WF -->|no| CONC[Promise.allSettled all channels]
  WLOOP --> FWD[Forward campaign.dispatched / webhooks]
  CONC --> FWD
```

---

## 6. Early exits and “no value” behavior (summary)

| Stage | Behavior |
|-------|----------|
| Invalid JSON / envelope | Event discarded (warn), no trigger evaluation |
| No triggers for event | `matchedTriggers` empty |
| Conditions not met | Trigger skipped |
| AI condition but scores unavailable | Condition fails (fail-safe) |
| RG risk block | All triggers suppressed for that evaluation |
| Sequential trigger | Wrong step or window exceeded → no match until sequence completes |
| Missing field in state + payload | Comparison fails → trigger does not match |
| Campaign row missing in publisher | Templates use `undefined`; `channels` still from trigger |
| channel-delivery: control group | No real delivery |
| channel-delivery: throttle | Return without send |
| Email: no `contact.email` | Channel returns false; waterfall may try next channel |

---

## 7. RabbitMQ (event-driven publish)

| Piece | Value |
|--------|--------|
| Events queue (in) | `ge.events.raw.v1` |
| Campaign exchange | `ge.campaigns` (topic) |
| Routing key | `campaigns.outbound.v1` |
| Outbound queue | `ge.campaigns.outbound` |

---

## Related source files

| Area | Location |
|------|----------|
| Event consume + orchestration | `services/campaign-engine/src/campaign/event-consumer.service.ts` |
| Trigger evaluation | `services/campaign-engine/src/triggers/trigger-evaluator.service.ts` |
| Trigger entity (`channels`) | `services/campaign-engine/src/triggers/trigger.entity.ts` |
| Campaign publish + templates | `services/campaign-engine/src/campaign/campaign-publisher.service.ts` |
| Campaign entity (`channels`) | `services/campaign-engine/src/campaign/campaign.entity.ts` |
| Scheduled bulk (channels from campaign) | `services/campaign-engine/src/scheduler/scheduler.service.ts` |
| Outbound consume + channels | `services/channel-delivery/src/consumer/campaign-consumer.service.ts` |
