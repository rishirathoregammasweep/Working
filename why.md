
**Audience:** engineering and product leadership deciding whether to collapse GammaEngage-style services into a single deployable.

**Context in this repo:** Ingestion, campaign logic, channel delivery, player profile, and **AI scoring** are separate processes connected by **queues** (e.g. RabbitMQ) and HTTP. **`ai-engine` is Python (FastAPI-style)**; most customer-facing and admin APIs are **NestJS (TypeScript)**.

---

## 1. The load is multiplicative, not additive

For one tenant, assume **~50,000 active users** in scope and **20–30 live campaigns** (triggers, segments, schedules, channel sends). Work is not “one campaign” at a time in the abstract—it is **per user × per campaign × per event (or per tick)** in the worst case.

- **Illustration (order of magnitude, not a promise of exact product math):** If something must consider **each user against each campaign** on a schedule or event burst, you are in **O(users × campaigns)** territory for that phase. With 50k users and 25 campaigns, that is **1.25M candidate evaluations** for a single full sweep—not counting retries, channel fan-out, or ML calls.
- **Bursts:** One tenant’s **scheduled send** or **big behavioural spike** can enqueue a large slice of that space in minutes. If that shares **one process** with **global event ingestion**, you risk **CPU and GC contention**, **thread pool starvation**, and **tail latency** on unrelated brands.
- **Queues exist to absorb bursts:** A merged service removes the natural **backpressure boundary** (consumer lag on `ge.campaigns.outbound`, DLQ, scale-out of workers only). Everything becomes one heap and one release.

**Takeaway for planning:** Merging does not remove the multiplication—it **hides** it until the whole system falls over together.

---

## 2. Why 20–30 campaigns can “bombard” a unified stack

If campaign evaluation, delivery, ingestion, and optional **per-player ML** all run in **one binary**:

- **No isolation:** A runaway segment refresh or a bad template loop ties up the same event loop / thread pool that serves **`POST /events`** and health checks.
- **Cascading timeouts:** Slow **SMS/email providers** or **webhooks** block workers that you might have reused for “everything” in a monolith.
- **Memory pressure:** Holding large in-memory structures for “all campaigns for all users” in one process is riskier than **sharding workers** by queue or by service.
- **One deploy rolls the dice for everyone:** A campaign feature regression can take down **ingestion** for **all tenants**—unacceptable for a multi-tenant CRM.

Separate services let you **scale campaign-engine and channel-delivery** independently from **event-ingestion**, and throttle at **RabbitMQ + worker count** instead of at “hope the monolith survives.”

---

## 3. Python AI engine vs NestJS: keep them separate on purpose

| Factor | Implication |
|--------|-------------|
| **Runtime** | **Python** (`ai-engine`: scoring, feature extraction from ClickHouse/Postgres) vs **Node/NestJS** (ingestion, campaigns, delivery). Different **GC**, **concurrency model**, and **dependency trees**. |
| **CPU / latency** | ML and batch scoring are often **CPU-bound** or **I/O-heavy to analytics stores**; mixing them into NestJS either **blocks the Node event loop** or forces awkward **worker thread / subprocess** bridges—you already have a dedicated Python service. |
| **Shipping** | **Separate container** = smaller Nest images, **independent** Python version and **numpy/scipy** stack without bloating every API pod. |
| **Scaling** | Scale **`ai-engine`** replicas for scoring load without scaling **every** Nest service. |

Merging “everything” would mean either **dropping** the dedicated Python stack (reimplementing ML in TS—high cost) or **embedding** Python in Node (operational complexity, not simplification).

---

## 4. What we recommend instead of a monolith

- **Keep message boundaries** between facts (`ge.events.raw.v1`) and actions (`ge.campaigns`, `ge.campaigns.outbound`) so bursts **queue** instead of **blocking** ingest.
- **Cap and schedule** heavy tenant work (per-brand limits, staggered segment runs, DLQ alerts)—easier when **delivery** and **evaluation** are observable separate services.
- **Scale horizontally** the tier that is hot (e.g. more `channel-delivery` consumers vs more `event-ingestion` replicas) using metrics that are already **per service**.
- **Treat `ai-engine` as an optional, scaled sidecar** to Nest services via HTTP + API key—not inline in the request path of raw ingestion unless you explicitly design async scoring.

---

## 5. Related reading

- [player-traffic-vs-campaign-architecture.md](./player-traffic-vs-campaign-architecture.md) — short bullet map of services and queues.
- Root [README.md](../README.md) — rate limiting, module isolation.

---

*Figures (50k users, 20–30 campaigns) are planning examples; tune with production metrics (queue depth, p95 latency, cost per evaluation).*
