# Third-party casino integration: Web SDK and event API

This document describes how an external casino integrates with GammaEngage using the **browser Web SDK**, the **event ingestion HTTP API**, and how **API keys** fit into each flow.

For a shorter, non-technical overview, see [casino-integration-guide.md](./casino-integration-guide.md).

---

## 1. Architecture at a glance

| Integration | Where it runs | Typical use |
|-------------|----------------|-------------|
| **Web SDK** | Player’s browser | Page visits, login/registration signals, consent, lightweight custom events |
| **Event API** (`POST /events`, `POST /events/batch`) | Your **servers** (wallet, CRM worker, etc.) | Deposits, withdrawals, bets, bulk or sensitive events |

Both paths deliver **event envelopes** to the **event-ingestion** service. Events are validated, deduplicated, stored, and processed downstream (campaigns, analytics, etc.).

**Base URL:** Your deployment’s event-ingestion origin (example: `https://events.your-gammaengage-domain.com`). Paths below are relative to that origin.

---

## 2. API keys: two different concepts

GammaEngage uses **two separate key types**. Confusing them is the most common integration mistake.

### 2.1 Tenant API key (casino → event-ingestion)

**Purpose:** Identifies **which brand (casino)** is sending traffic and authorizes calls to **public ingestion endpoints** (`POST /events`, `POST /events/batch`, and related public routes protected by the same auth layer).

**How it is sent**

- HTTP header: **`X-Tenant-API-Key`**
- The service looks up the key in the `api_keys` table (hashed at rest), resolves the **brand**, and records usage (e.g. `last_used_at` for operational visibility).

**How you obtain it**

- Created per brand through your **Admin UI** (API Keys) or through **tenant-admin** APIs that your platform operators call. The **plaintext secret is shown only once** at creation; store it in your secrets manager.

**Security notes**

- Treat this secret like a password. Anyone with the key can send events as your brand (within rate limits and validation rules).
- **Do not** commit tenant API keys to source control.
- For **browser** usage, exposing the tenant API key in JavaScript is often **undesirable**; prefer sending sensitive events from your **backend** using the same header + signing (section 4), or use a **small backend proxy** that adds the key and signature.

### 2.2 Internal API key (`INTERNAL_API_KEY`, platform → internal services)

**Purpose:** Authenticates **server-to-server** calls to **internal/admin** HTTP APIs (for example **tenant-admin** routes protected by `ApiKeyGuard`), **not** player-facing event ingestion.

**How it is sent**

- HTTP header: **`X-API-Key`**
- Value: the environment variable **`INTERNAL_API_KEY`** configured on the receiving service.

**Who uses it**

- Your **platform** automation, other microservices, or ops tools that call protected admin-style endpoints.

**Important:** This is **not** the key casinos paste into client-side scripts for `POST /events`. Casinos use the **tenant API key** in **`X-Tenant-API-Key`** as described in section 2.1.

---

## 3. Request signing (HMAC) on event endpoints

Public ingestion is protected so that knowing only the URL is not enough: requests must present a **valid tenant API key** and, in production, a **valid HMAC** over the request body.

**Headers (GammaEngage native)**

| Header | Value |
|--------|--------|
| `X-Tenant-API-Key` | Your tenant API key (plaintext) |
| `x-gammaengage-signature-version` | `1` |
| `x-gammaengage-signature-content` | Hex-encoded **HMAC-SHA256** of the **minified JSON** body, using the shared **`HMAC_SECRET`** configured on event-ingestion |

**Compatibility:** The service also accepts Optimove-style header names for the signature (`x-optimove-signature-version` / `x-optimove-signature-content`).

**Algorithm (conceptual)**

1. Serialize the JSON body to a **single minified string** (same logical content as `JSON.stringify` after `JSON.parse` — the server recomputes this for verification).
2. `HMAC_SHA256(HMAC_SECRET, bodyUtf8)` → hex string → send as `x-gammaengage-signature-content`.

**Development:** If `HMAC_SECRET` is not set and the environment is development-oriented, the service may allow unsigned requests for local testing. **Production** must use signing.

Reference implementation and tests live in `services/event-ingestion` (for example `hmac.guard.ts`).

---

## 4. Event HTTP API

### 4.1 Single event

```http
POST /events
Content-Type: application/json
X-Tenant-API-Key: <tenant-api-key>
x-gammaengage-signature-version: 1
x-gammaengage-signature-content: <hmac-hex>
```

Body: one **event envelope** (schema validated by event-ingestion). Fields include `schema_version`, `event_id`, `event_type`, `brand_id`, `source_system`, `occurred_at`, `player_ref`, `payload`, `idempotency_key`, etc. See the root [README.md](../README.md) and `@gammaengage/shared` validation for the canonical shape.

**Typical response:** `202 Accepted` with ingest metadata; duplicates may be reported with a dedicated status (idempotency is enforced via Redis).

### 4.2 Batch

```http
POST /events/batch
```

Same auth headers as `POST /events`. Body: **array of 1–10** event envelopes (batched flush pattern for high volume).

### 4.3 Rate limiting

Public endpoints are rate-limited **per brand** (Redis-backed). On exceed, expect **429** and honor **`Retry-After`**. Defaults are documented in `services/event-ingestion/README.md`.

### 4.4 Health

```http
GET /health
```

Unauthenticated health check (not subject to the same limits as ingestion).

---

## 5. Web SDK

### 5.1 Serving the script

Event-ingestion can serve the bundled file:

```http
GET /sdk/gammaengage-sdk.js
```

Use your deployment’s base URL, for example:

```html
<script src="https://your-event-ingestion-host/sdk/gammaengage-sdk.js" …></script>
```

### 5.2 Configuration

The NPM package and script-tag flows are documented in [sdk/README.md](../sdk/README.md). Typical settings include:

- **Tenant / brand id** — must match `brand_id` in envelopes.
- **Endpoint** — origin of event-ingestion (SDK builds URLs such as `{endpoint}/events` and `{endpoint}/events/batch`).

**Production alignment:** Event-ingestion expects **`X-Tenant-API-Key`** plus the HMAC headers named in **section 3** (`x-gammaengage-signature-version` / `x-gammaengage-signature-content`). If you use the TypeScript SDK from `sdk/`, extend or wrap the HTTP client so every request includes those headers and the same HMAC algorithm as your backend tests. Many teams use the SDK for **structure and envelope shape** but send events from a **backend proxy** that holds the tenant key and secret, or they use **server-only** `POST /events` for all production traffic.

### 5.3 Capabilities (browser)

The SDK supports visitor identity, batched sends, retries, consent helpers, and custom `reportEvent` calls — see [sdk/README.md](../sdk/README.md).

---

## 6. Operational checks

- **My Integration / health:** The Admin UI can surface ingestion health (recent events, synthetic tests, last API key usage). Details are described in [integration-health-contract.md](./integration-health-contract.md) and [integration-health-runbook.md](./integration-health-runbook.md).
- **Idempotency:** Reusing the same logical `idempotency_key` is intentional deduplication; change keys if you need a new accepted event.

---

## 7. Quick checklist for go-live

1. Obtain **`brand_id`** and issue a **tenant API key**; store the secret securely.
2. Confirm **`HMAC_SECRET`** is set on event-ingestion in production and that your signing code uses the **same** secret.
3. Point **`POST /events`** (or `/events/batch`) to the correct host; send **`X-Tenant-API-Key`** and HMAC headers on every request.
4. Run a **test event** from your backend and verify it appears in Admin UI / health dashboards.
5. Add the **Web SDK** only where browser tracking is appropriate; keep payment and compliance-sensitive events on the **server API**.

---

## Related documents

| Document | Topic |
|----------|--------|
| [casino-integration-guide.md](./casino-integration-guide.md) | High-level onboarding (SDK, server API, CSV) |
| [sdk/README.md](../sdk/README.md) | Web SDK API and build |
| [services/event-ingestion/README.md](../services/event-ingestion/README.md) | Service behavior, rate limits, troubleshooting |
| [integration-health-contract.md](./integration-health-contract.md) | Health payloads and sources |
