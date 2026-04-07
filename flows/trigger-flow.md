# Hierarchical flow: Event → Trigger → Campaign → Channel delivery

This page shows the pipeline as a **top-down tree** centered on four stages: **Event** → **Trigger** → **Campaign** → **Channel delivery**. Supporting detail hangs under each stage. For full prose and write matrices, see [trigger-explanation.md](./trigger-explanation.md).

**How to read:** Follow the **spine** (large rounded nodes **1 → 2 → 3 → 4**). Each stage lists what runs there. A second diagram lists **queues and data stores** next to the same four stages.

---

## Spine diagram — the four stages

```mermaid
graph TD
  ROOT((Player / app event))

  ROOT --> EV([1 · Event])
  EV --> TR([2 · Trigger])
  TR --> CA([3 · Campaign])
  CA --> DL([4 · Channel delivery])

  %% --- Event (ingestion) ---
  EV --> e1[HTTP event-ingestion — validate envelope]
  EV --> e2[Redis — idempotency key]
  EV --> e3[ClickHouse — events_raw + optional player_state row]
  EV --> e4[RabbitMQ — publish to ge.events.raw.v1]

  %% --- Trigger (campaign-engine: from event to matched triggers) ---
  TR --> t1[EventConsumer — read from ge.events.raw.v1]
  TR --> t2[Redis — player_state updated from event]
  TR --> t3[Postgres — campaign_player_snapshots upsert]
  TR --> t4[Conversions + journeys — optional PG writes / reads]
  TR --> t5[Postgres — load active triggers by event_type]
  TR --> t6[TriggerEvaluator — conditions on state + event]
  TR --> t7[Redis — seq:* keys for sequential triggers]

  %% --- Campaign (publisher: matched trigger → outbound message) ---
  CA --> c1[CampaignPublisher — one message per matched trigger]
  CA --> c2[Postgres — read campaign, A/B assignment, control group]
  CA --> c3[Postgres — campaign_delivery_logs when not control]
  CA --> c4[Build payload — templates, channels, waterfall flag]
  CA --> c5[RabbitMQ — ge.campaigns exchange · campaigns.outbound.v1]

  %% --- Channel delivery ---
  DL --> d1[CampaignConsumer — ge.campaigns.outbound]
  DL --> d2[Player profile, suppression, contact policy]
  DL --> d3[Redis — send throttle · daily caps]
  DL --> d4[Render — per channel · email tracking tokens in Postgres]
  DL --> d5[Dispatch — waterfall or concurrent multi-channel]
  DL --> d6[Send — email, SMS, push, web push, WhatsApp, popup / SSE]
  DL --> d7[ClickHouse — campaign.dispatched, opens / clicks · webhooks]

  classDef rootStyle fill:#b8d4e8,stroke:#2c5282,stroke-width:2px,color:#1a202c
  classDef stage1 fill:#bbdefb,stroke:#1565c0,stroke-width:2px,color:#0d47a1
  classDef stage2 fill:#c8e6c9,stroke:#2e7d32,stroke-width:2px,color:#1b5e20
  classDef stage3 fill:#ffe0b2,stroke:#e65100,stroke-width:2px,color:#bf360c
  classDef stage4 fill:#e1bee7,stroke:#6a1b9a,stroke-width:2px,color:#4a148c
  classDef leaf fill:#fafafa,stroke:#616161,stroke-width:1px,color:#212121

  class ROOT rootStyle
  class EV,e1,e2,e3,e4 stage1
  class TR,t1,t2,t3,t4,t5,t6,t7 stage2
  class CA,c1,c2,c3,c4,c5 stage3
  class DL,d1,d2,d3,d4,d5,d6,d7 stage4
```

### Spine in one sentence per stage

| # | Stage | Role |
|---|--------|------|
| **1** | **Event** | Accept the envelope, dedupe, persist analytics, enqueue for the engine. |
| **2** | **Trigger** | Refresh state, evaluate rules in DB + Redis, produce **matched triggers**. |
| **3** | **Campaign** | Turn each match into an **outbound campaign message** (templates, experiment, logs) and publish to the campaign queue. |
| **4** | **Channel delivery** | Consume that message, apply policy, and **send** on one or more channels. |

---

## Same four stages — messaging & storage only

```mermaid
graph TD
  ROOT((Four stages))

  ROOT --> EV([1 · Event])
  EV --> TR([2 · Trigger])
  TR --> CA([3 · Campaign])
  CA --> DL([4 · Channel delivery])

  EV --> ev_q[Queue in: HTTP]
  EV --> ev_x[Queue out: ge.events.raw.v1]
  EV --> ev_s[Redis + ClickHouse — idempotency, events_raw, optional player_state]

  TR --> tr_q[Queue in: ge.events.raw.v1]
  TR --> tr_s[Redis + Postgres — state, snapshots, triggers read, seq:*]

  CA --> ca_q[Queue out: ge.campaigns → ge.campaigns.outbound]
  CA --> ca_s[Postgres — campaigns, delivery_logs]

  DL --> dl_q[Queue in: ge.campaigns.outbound]
  DL --> dl_s[Postgres · Redis · ClickHouse — contact, tracking, throttle, analytics]

  classDef rootStyle fill:#b8d4e8,stroke:#2c5282,stroke-width:2px,color:#1a202c
  classDef s1 fill:#bbdefb,stroke:#1565c0,stroke-width:1px,color:#0d47a1
  classDef s2 fill:#c8e6c9,stroke:#2e7d32,stroke-width:1px,color:#1b5e20
  classDef s3 fill:#ffe0b2,stroke:#e65100,stroke-width:1px,color:#bf360c
  classDef s4 fill:#e1bee7,stroke:#6a1b9a,stroke-width:1px,color:#4a148c

  class ROOT rootStyle
  class EV,ev_q,ev_x,ev_s s1
  class TR,tr_q,tr_s s2
  class CA,ca_q,ca_s s3
  class DL,dl_q,dl_s s4
```

---

## Compact tree — storage by stage

```mermaid
graph TD
  ROOT((Storage along the pipeline))

  ROOT --> ING([1 · Event / ingest])
  ROOT --> ENG([2–3 · Trigger + campaign engine])
  ROOT --> DEL([4 · Channel delivery])

  ING --> ING_R[Redis — idempotency]
  ING --> ING_C[ClickHouse — events_raw, optional player_state]

  ENG --> ENG_R[Redis — player_state, seq:*]
  ENG --> ENG_P[Postgres — snapshots, triggers, campaigns, delivery_logs, conversions, journeys]

  DEL --> DEL_P[Postgres — contact, suppression, email tracking]
  DEL --> DEL_R[Redis — throttle]
  DEL --> DEL_C[ClickHouse — campaign.dispatched, email.opened / clicked]

  classDef rootStyle fill:#b8d4e8,stroke:#2c5282,stroke-width:2px,color:#1a202c
  classDef stage fill:#e3f2fd,stroke:#1565c0,stroke-width:1px,color:#0d47a1
  classDef leaf fill:#fafafa,stroke:#616161,stroke-width:1px,color:#212121

  class ROOT rootStyle
  class ING,ENG,DEL stage
  class ING_R,ING_C,ENG_R,ENG_P,DEL_P,DEL_R,DEL_C leaf
```

---

## Legend (spine diagram)

| Color | Stage | Covers |
|-------|--------|--------|
| Blue | **1 · Event** | Ingest service, dedupe, raw analytics, raw queue. |
| Green | **2 · Trigger** | Consumer, state, DB triggers, evaluation, sequences. |
| Orange | **3 · Campaign** | Publisher, campaign row, logs, RabbitMQ outbound message. |
| Purple | **4 · Channel delivery** | Consumer, policy, multi-channel send, analytics side effects. |

---

## See also

- [trigger-explanation.md](./trigger-explanation.md) — narrative flow, multi-channel modes, detailed DB/Redis/ClickHouse write list
