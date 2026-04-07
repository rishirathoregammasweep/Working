# Why we should not merge all backend services into one (tech lead brief)

**Who this is for:** Anyone deciding whether to ship one big “all-in-one” backend instead of separate services.

**How this project is built today:** Different jobs run as **different programs**. They talk through **message queues** (RabbitMQ) and sometimes HTTP. Most APIs are **NestJS (TypeScript)**. **Scoring / AI** lives in **`ai-engine`, which is Python**—on purpose.

---

## 1. One tenant can create a lot of work (it multiplies)

Picture **one casino (tenant)** with about **50,000 players** and **20–30 live campaigns** (emails, triggers, segments, schedules).

- The work is rarely “one small task.” In the heavy cases you must think about **many players** and **many campaigns** at the same time—roughly **players × campaigns** worth of checks when you run a full sweep or a big wave of events.
- **Simple number example:** 50,000 × 25 ≈ **1.25 million** “did this player match this campaign?” style steps in one full pass. That is before retries, sending to multiple channels, or calling ML. (Real product logic may skip work—this is still useful for **capacity planning**.)
- **Spikes:** A scheduled send or a sudden burst of player activity can create **a lot of work in a short time**. If that work runs in the **same process** as “receive events from every customer,” one busy tenant can **slow down or starve** everyone else.
- **Queues help:** Work waits in a line (e.g. `ge.campaigns.outbound`) instead of piling into one program’s memory. If you merge everything, you **lose that cushion**—problems show up as **one big crash** instead of **a growing queue** you can watch and scale.

**In one sentence:** Merging does not make the math smaller; it only **hides** it until the whole app struggles at once.

---

## 2. Why many campaigns can “bombard” a single combined app

If **ingestion**, **campaign rules**, **sending email/SMS**, and **optional AI scoring** all lived in **one deployment**:

- **Same workers do everything:** A bug, a slow loop, or a huge segment refresh can tie up the same threads that should answer **`POST /events`** and health checks.
- **Slow outsiders become your problem:** Email and SMS providers and webhooks can be **slow or flaky**. In a monolith, waiting on them can **block** other work that should stay fast.
- **Memory:** Keeping “all campaigns × all users” style state in **one** process is riskier than splitting work across **workers** or **services** that you can scale separately.
- **One bad deploy hurts everyone:** A mistake in campaign code could take down **event ingestion for all tenants**—hard to justify in a multi-tenant product.

**Separate services** let you add more **campaign** or **delivery** capacity without blindly scaling **ingestion**, and you throttle using **queues and worker counts** instead of hoping one server survives.

---

## 3. Python (`ai-engine`) vs NestJS—why not one box?

- **Different languages, different strengths:** Python fits **data / ML / scoring** (reading ClickHouse, Postgres, running models). NestJS fits **APIs and real-time glue** for the rest of the platform.
- **Heavy CPU work:** Scoring can burn CPU and time. Packing that into the same Node process either **slows every API** or forces **complicated workarounds** (extra processes, threads). You already have a **dedicated Python service**—use it.
- **Smaller, simpler deploys:** Nest images stay lean; Python keeps its own **scientific libraries** without bloating every API container.
- **Scale what is hot:** When scoring spikes, scale **`ai-engine`** replicas—not every Nest service at once.

Putting “everything” in one app usually means **rebuilding ML in TypeScript** (expensive) or **running Python inside Node** (hard to operate). Neither is simpler than **two clear services**.

---

## 4. What to do instead of a monolith

- **Keep the pipeline split:** Raw events flow in (e.g. `ge.events.raw.v1`); outbound sends go out on their own queues (e.g. `ge.campaigns` / `ge.campaigns.outbound`). Bursts **wait in the queue** instead of **blocking** ingestion.
- **Limit and stagger heavy jobs:** Per-brand caps, staggered runs, and alerts on dead-letter queues are easier when **delivery** and **rules** are **separate** and **observable**.
- **Scale the tier that is busy:** More workers for sends vs more for ingestion—each service has its own metrics.
- **Call AI when it makes sense:** Use **`ai-engine` over HTTP** (with auth) for scoring; do not force every raw event through ML unless you design that **async** on purpose.

---

## 5. Related reading

- [player-traffic-vs-campaign-architecture.md](./player-traffic-vs-campaign-architecture.md) — short map of services and queues.
- Root [README.md](../README.md) — rate limits and module isolation.

---

*The 50k users and 20–30 campaign numbers are **examples for planning**. Replace them with real production metrics (queue depth, latency, cost per run) when you size infrastructure.*
