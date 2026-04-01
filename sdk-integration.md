# Third-party casino integration with GammaEngage

This document describes how an **external iGaming site** (third-party casino or sportsbook) connects to GammaEngage for CRM event tracking, real-time campaigns, and preference management. The reference implementation in this repo is the static demo under `demo-ui/casino/`.

## What gets integrated

| Piece | Role |
|--------|------|
| **GammaEngage Web SDK** (`gammaengage-sdk.js`) | Loaded in the casino’s web pages; sends structured events to GammaEngage. |
| **Event Ingestion API** | HTTP service (e.g. `POST /events`) that validates, stores, and routes events. |

The SDK is designed for a **drop-in** experience: one script tag (or a single `init` call), then your product code calls methods when users navigate, register, log in, deposit, play games, etc.

## High-level flow

1. The casino page loads the SDK (same origin or CDN URL you host).
2. `init` configures **brand (tenant)**, **API credentials**, and the **ingestion base URL** (must end with `/events` for the default event path).
3. The SDK maintains a **persistent visitor ID** (`localStorage`) and an optional **player ID** after login/registration.
4. Each tracked action becomes a **JSON envelope** `POST`ed to Event Ingestion, with `X-Tenant-API-Key` when a tenant token is configured.
5. After **login** or **registration**, the SDK can open an **SSE** connection for real-time campaign HTML (pop-ups) scoped to the brand and player.

## Prerequisites from GammaEngage

- **Tenant / brand ID** (`tenantId`) — identifies the operator brand in GammaEngage.
- **Tenant API token** (`tenantToken`) — sent as `X-Tenant-API-Key` on event requests. Obtain from your GammaEngage onboarding or admin process; do not expose in public repos for production.
- **Event Ingestion URL** — HTTPS endpoint for production; for local development, something like `http://localhost:3001/events` if Event Ingestion runs with default settings.

## Script load → `window.gammaengageSDK` → `init` → `API`

1. **Import the SDK** with a `<script>` tag (same-origin path or CDN URL).
2. When the file runs, it **attaches the SDK to `window`**: `window.gammaengageSDK` (and alias `window.optimoveSDK`).
3. Call **`gammaengageSDK.init({ ... })`** once to set `tenantId`, `tenantToken`, and `endpoint` (your ingestion URL, usually ending in `/events`).
4. Call methods on **`window.gammaengageSDK.API`** — for example `reportEvent`, `setPageVisit`, `login`. The namespace is **`API`** (uppercase); `window.gammaengageSDK.api` is not valid.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Casino</title>
  <!-- 1) Load the SDK; when it executes, window.gammaengageSDK is defined -->
  <script src="https://your-cdn.example/gammaengage-sdk.js"></script>
</head>
<body>
  <script>
    // 2) Configure tenant + API key + Event Ingestion endpoint
    window.gammaengageSDK.init({
      tenantId: 'YOUR_TENANT_ID',
      tenantToken: 'YOUR_TENANT_TOKEN',
      endpoint: 'https://your-ingestion-host/events',
      debug: false,
    });

    // 3) Use window.gammaengageSDK.API.<method>(...)
    window.gammaengageSDK.API.setPageVisit(
      window.location.href,
      document.title,
      'lobby',
    );

    window.gammaengageSDK.API.reportEvent('deposit_completed', {
      amount: 100,
      currency: 'USD',
    });
  </script>
</body>
</html>
```

## Loading the SDK

### Option A: Script tag with data attributes

```html
<script src="our_deployed_url"
        data-tenant-id="YOUR_TENANT_ID"
        data-tenant-token="YOUR_TENANT_TOKEN"
        data-endpoint="https://your-ingestion-host/events"
        data-debug="false"></script>
```

The SDK auto-initializes on `DOMContentLoaded`.

### Option B: Programmatic init

```html
<script src="gammaengage-sdk.js"></script>
<script>
  window.gammaengageSDK.init({
    tenantId: 'YOUR_TENANT_ID',
    tenantToken: 'YOUR_TENANT_TOKEN',
    endpoint: 'https://your-ingestion-host/events',
    // autoPageVisit: true,  // default: fire set_page_visit shortly after init
    // debug: true,
  });
</script>
```

See `demo-ui/casino/index.html` for a minimal programmatic example.

## Identity model

- **Visitor ID** — Created on first visit, stored in `localStorage`, stable across sessions until cleared. Used for anonymous journeys and stitching before login.
- **Player / SDK ID** — Set when you call `reportEvent` with a player id, or via `login` / `registerUser`. Stored as the identified user for subsequent events (`external_player_id` in the envelope).

After **sign-out**, the SDK clears the stored player id but keeps the visitor id.

## API surface (casino-relevant)

The global is **`window.gammaengageSDK`** (alias: **`window.optimoveSDK`**). All tracking methods live under **`window.gammaengageSDK.API`** (capital `API`).

| Method | When to use |
|--------|-------------|
| `API.setPageVisit(url, title, category?, sdkId?)` | Route or SPA screen changes; internally throttled to avoid noise. |
| `API.reportEvent(name, params, callback?, sdkId?)` | Custom or standard events (e.g. game rounds, deposits, KYC). |
| `API.login(sdkId, params?, callback?)` | Successful authentication; also connects SSE for campaigns. |
| `API.registerUser(sdkId, email, eventName?, params?, callback?)` | New account; fires a registration-style event and connects SSE. |
| `API.signOutUser()` | Clears player id and closes SSE. |
| `API.getInitialVisitorID()` / `API.getCurrentSdkId()` | Read current ids for debugging or server handoff. |
| `API.setRealTimeOptions({ showDimmer, showWatermark, reportEventCallback })` | Customize campaign pop-up behavior. |
| `API.preferenceCenter.showUi(mode)` | Opens hosted preference UI (requires logged-in `sdkId`). |

**Example events** your casino might send via `reportEvent`:

- Navigation / content: e.g. `page_view` with `page_url`, `page_title`, `page_category`.
- Payments: e.g. `deposit_initiated`, `deposit_completed`, `deposit_failed` with `amount`, `currency`.
- Extend with any **event name** and **payload** your CRM schema expects; the server validates the envelope shape.

Event payloads automatically include `_sdk_context` (page URL, title, user agent, session id, SDK version).

## Event envelope (what the SDK sends)

Single events are `POST`ed to `{endpoint}` with JSON roughly matching:

- `schema_version`, `event_id`, `brand_id`, `event_type`, `source_system`, `occurred_at`
- `player_ref`: `visitor_id`, optional `external_player_id`
- `payload`: your parameters plus `_sdk_context`
- `idempotency_key`

The Event Ingestion service validates this with `EventEnvelopeInputSchema` and applies **HMAC guard**, **per-brand rate limiting**, idempotency, and downstream processing (see `services/event-ingestion/`).

## Security and production notes

- **Tenant token**: Required for authenticated ingestion; sent as `X-Tenant-API-Key`.
- **HMAC**: The SDK can attach signature headers when `hmacSecret` is set; **production signing should be server-side** — the bundled client HMAC helper is for demos only (see comments in `gammaengage-sdk.js`).
- **CORS**: Event Ingestion allows browser `POST`s with the headers the SDK uses; production should use HTTPS and locked-down origins as configured for your deployment.
- **Rate limits**: Responses may return `429` with `Retry-After`; the SDK logs rate-limit cases.

## Real-time campaigns (SSE)

After `login` or `registerUser`, the SDK opens **Server-Sent Events** to a URL derived from the ingestion host: base URL with `/events` removed, then `/sse/campaigns?brand_id=...&player_id=...`. Incoming messages with campaign HTML can show the built-in overlay or your callback via `setRealTimeOptions`.

## Backend reference

- **POST `/events`** — Primary single-event ingest (used by the Web SDK).
- **POST `/events/batch`** — Batch ingest (up to 10 events per request).
- **POST `/events/ootb/...`** — Optimove-compatible OOTB endpoints (`set-email`, `consent`, page visit variants), if you integrate those paths instead of the generic envelope.

Details: `services/event-ingestion/README.md`.

## Local testing

1. Run Event Ingestion (e.g. `npm run dev:event-ingestion` from the repo, per project scripts).
2. Serve `demo-ui/casino/` over HTTP (any static server).
3. Align `endpoint` in `index.html` with your local ingestion URL and use a valid tenant token for your environment.

## File map

| Path | Purpose |
|------|---------|
| `demo-ui/casino/index.html` | Minimal integration smoke test |
| `demo-ui/casino/gammaengage-sdk.js` | Copy or sync of the browser SDK |
| `demo-ui/sdk/gammaengage-sdk.js` | Canonical SDK location in the repo (keep in sync if you maintain both) |

---

*For schema details of the envelope and OOTB payloads, refer to `@gammaengage/shared` types and `services/event-ingestion` controllers.*
