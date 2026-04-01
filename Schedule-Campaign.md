# Scheduled campaign flow (create → send)

This document describes how a **scheduled campaign** moves from the admin UI through **campaign-engine**, **player-profile**, **RabbitMQ**, and **channel-delivery** to reach players on **email, SMS, push, web push, popup, WhatsApp**, etc.

---

## High-level picture

```mermaid
flowchart LR
  subgraph admin["Admin UI"]
    UI[Schedules page]
  end

  subgraph ce["campaign-engine"]
    API[SchedulerController /scheduled-campaigns]
    DB[(PostgreSQL scheduled_campaigns)]
    SCH[SchedulerService]
    CRON[cron / one-shot timer]
    PPQ[PlayerProfileClient queryAll]
    AMQP_PUB[Publish to RabbitMQ]
  end

  subgraph pp["player-profile"]
    BULK["GET /players/bulk"]
  end

  subgraph mq["RabbitMQ"]
    EX["Exchange: ge.campaigns"]
    Q["Queue: ge.campaigns.outbound"]
  end

  subgraph cd["channel-delivery"]
    CON[CampaignConsumerService]
    TH[Send throttle / suppression / policy]
    CH[Per-channel send: email, sms, push, …]
  end

  UI -->|REST + API key| API
  API --> DB
  SCH --> DB
  SCH --> CRON
  CRON -->|executeSchedule| SCH
  SCH --> PPQ
  PPQ --> BULK
  SCH -->|one message per player| AMQP_PUB
  AMQP_PUB --> EX
  EX --> Q
  Q --> CON
  CON --> TH
  TH --> CH
```

---

## 1. Create / update schedule (admin → API → DB → in-memory jobs)

```mermaid
sequenceDiagram
  participant UI as Admin UI
  participant CE as campaign-engine SchedulerController
  participant SVC as SchedulerService
  participant DB as PostgreSQL

  UI->>CE: POST/PUT /scheduled-campaigns (name, campaign_id, cron_expr or run_at, segment_filter, brand_id)
  CE->>SVC: create() / update()
  SVC->>DB: save schedule row
  alt Has cron_expr
    SVC->>SVC: registerCronJob (node-cron, UTC)
  else Has future run_at only
    SVC->>SVC: scheduleOneShot (setTimeout)
  end
```

**Notes:**

- On **process startup**, `reloadAllCronJobs()` loads **active** rows and registers cron or one-shot jobs again (in-memory `Map`, not Redis).
- **Campaign** is chosen by `campaign_id`; the schedule row does not duplicate channel copy — **channels come from the campaign** when dispatching.

---

## 2. When the job fires: who receives the send?

```mermaid
flowchart TD
  A[executeSchedule scheduleId] --> B[Load schedule + campaign from DB]
  B --> C{Campaign active?}
  C -->|no| X[Stop]
  C -->|yes| D[Build query from segment_filter + brand_id]
  D --> E[player-profile GET /players/bulk]
  E --> F[List of players for this brand / filter]
  F --> G[For each player: build CampaignOutboundMessage]
  G --> H[Optional: control group skip real send]
  H --> I[Publish JSON to ge.campaigns exchange routing key campaigns.outbound.v1]
```

**Recipient selection (today):**

- `segment_filter` on the schedule is mapped in code to **`brand_id`** plus optional **`allow_email` / `allow_sms` / `allow_push`** flags passed to player-profile bulk query.
- **Empty `{}`** means “no extra flags from the schedule” — bulk query is still scoped by **`brand_id`**; exact semantics of “all players” vs filters are implemented in **player-profile**.
- **Campaign** supplies **`channels`** (comma-separated on the campaign entity → array in the message), **template fields** (email HTML, SMS body, push text, etc.), **control_group_pct**, **waterfall** flag.

---

## 3. RabbitMQ handoff

| Piece | Value |
|--------|--------|
| Exchange | `ge.campaigns` (topic) |
| Routing key | `campaigns.outbound.v1` |
| Queue | `ge.campaigns.outbound` (bound to that routing key) |

Each published payload is one **player** × one **campaign outbound** job (bulk scheduling loops and publishes many messages).

---

## 4. channel-delivery: queue → channels

```mermaid
flowchart TD
  Q[ge.campaigns.outbound] --> C[CampaignConsumerService.dispatch]
  C --> CG{is_control_group?}
  CG -->|yes| SKIP[Log + skip real delivery]
  CG -->|no| T[SendThrottleService]
  T -->|blocked| SKIP2[Return — throttled]
  T -->|ok| CONTACT[PlayerProfileClient getContact]
  CONTACT --> REND[TemplateService.renderAll]
  REND --> MODE{waterfall?}
  MODE -->|yes| WF[Try channels in order — first success wins]
  MODE -->|no| CC[Send all channels concurrently]
  WF --> SC[sendChannel per channel]
  CC --> SC
  SC --> EMAIL[EmailService]
  SC --> SMS[SmsService]
  SC --> PUSH[PushService]
  SC --> WP[WebPushService]
  SC --> POP[SSE popup]
  SC --> WA[WhatsAppService]
```

**Per-channel behavior (simplified):**

- **email** — needs contact email, `allow_email`, HTML rendered + tracking + unsubscribe link → `EmailService.send`.
- **sms** — phone + `allow_sms` → `SmsService.send`.
- **push** — device tokens + `allow_push` → `PushService.send` (per token).
- **web_push** — subscriptions from registry → `WebPushService.send`.
- **popup** — `popup_html` → SSE bus to connected clients.
- **whatsapp** — phone → `WhatsAppService.send`.

Before sending, **channel-delivery** applies **suppression**, **contact policy / frequency caps**, and **send throttle** (daily cap, quiet hours). Failures can trigger **retry** / DLQ patterns via shared Rabbit helpers.

---

## 5. End-to-end (compact sequence)

```mermaid
sequenceDiagram
  participant Cron as Cron / timer
  participant SCH as SchedulerService
  participant PP as player-profile
  participant MQ as RabbitMQ
  participant CD as channel-delivery

  Cron->>SCH: executeSchedule(id)
  SCH->>PP: bulk players for brand + segment_filter mapping
  PP-->>SCH: players[]
  loop Each player
    SCH->>MQ: publish CampaignOutboundMessage
  end
  MQ->>CD: consume ge.campaigns.outbound
  CD->>CD: throttle, contact, templates
  CD->>CD: email / sms / push / …
```

---

## Related files (for developers)

| Area | Location |
|------|-----------|
| Schedule CRUD + cron registration | `services/campaign-engine/src/scheduler/scheduler.service.ts` |
| HTTP API | `services/campaign-engine/src/scheduler/scheduler.controller.ts` |
| Entity | `services/campaign-engine/src/scheduler/scheduled-campaign.entity.ts` |
| Player bulk HTTP client | `services/campaign-engine/src/scheduler/player-profile.client.ts` |
| Queue consumer + channel switch | `services/channel-delivery/src/consumer/campaign-consumer.service.ts` |
| Admin schedule UI | `admin-ui/src/pages/schedules/` |

---

*Generated for the GammaEngage repo; behavior follows code as of the doc date — verify `segment_filter` mapping and player-profile bulk API if you extend targeting.*
