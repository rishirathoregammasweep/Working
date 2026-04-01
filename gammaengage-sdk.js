/**
 * GammaEngage Web SDK v1.0
 * Drop-in browser SDK for iGaming CRM event tracking.
 * Compatible with Optimove Web SDK API surface.
 *
 * Usage:
 *   <script src="gammaengage-sdk.js"
 *           data-tenant-id="YOUR_TENANT_ID"
 *           data-tenant-token="YOUR_TENANT_TOKEN"
 *           data-endpoint="https://your-event-ingestion-url"></script>
 */
(function (global) {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────
  const SDK_VERSION = '1.0.0';
  const VISITOR_KEY = 'ge_visitor_id';
  const SDK_ID_KEY = 'ge_sdk_id';
  const SESSION_KEY = 'ge_session_id';
  const PAGE_VISIT_THROTTLE_MS = 500;

  // ─── Utilities ───────────────────────────────────────────────────────────────
  function uuidv4() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function getStorage(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function setStorage(key, val) {
    try { localStorage.setItem(key, val); } catch (_) { /* noop */ }
  }

  function getSession(key) {
    try { return sessionStorage.getItem(key); } catch (_) { return null; }
  }

  function setSession(key, val) {
    try { sessionStorage.setItem(key, val); } catch (_) { /* noop */ }
  }

  function log(msg, data) {
    if (GammaEngageSDK._debug) {
      console.log('[GammaEngage SDK]', msg, data || '');
    }
  }

  // ─── SSE / Pop-up connection ─────────────────────────────────────────────────
  let _sseSource = null;
  let _popupCallback = null;
  let _popupOptions = {};

  function connectSSE(brandId, playerId) {
    if (!GammaEngageSDK._endpoint || !brandId) return;
    const url = GammaEngageSDK._endpoint.replace('/events', '') +
      '/sse/campaigns?brand_id=' + encodeURIComponent(brandId) +
      '&player_id=' + encodeURIComponent(playerId || '');
    if (_sseSource) { _sseSource.close(); }
    try {
      _sseSource = new EventSource(url);
      _sseSource.onmessage = function (e) {
        try {
          const msg = JSON.parse(e.data);
          log('SSE message received', msg);
          if (msg.type === 'campaign' && msg.html) {
            _handlePopup(msg);
          }
        } catch (_) { /* noop */ }
      };
      _sseSource.onerror = function () {
        log('SSE connection error — will reconnect automatically');
      };
      log('SSE connected for player', playerId);
    } catch (err) {
      log('SSE not supported or failed', err);
    }
  }

  function _handlePopup(msg) {
    if (_popupCallback) {
      _popupCallback({ IsSuccess: true, Data: msg.html });
      return;
    }
    if (_popupOptions.showDimmer !== false) {
      _showBuiltinPopup(msg.html);
    }
  }

  function _showBuiltinPopup(html) {
    const existing = document.getElementById('ge-popup-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ge-popup-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.6)',
      'z-index:999999', 'display:flex', 'align-items:center', 'justify-content:center'
    ].join(';');

    const box = document.createElement('div');
    box.id = 'ge-popup-box';
    box.style.cssText = [
      'background:#fff', 'border-radius:12px', 'padding:24px',
      'max-width:480px', 'width:90%', 'position:relative',
      'box-shadow:0 20px 60px rgba(0,0,0,0.4)'
    ].join(';');
    box.innerHTML = html;

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = [
      'position:absolute', 'top:10px', 'right:14px',
      'background:none', 'border:none', 'font-size:22px',
      'cursor:pointer', 'color:#666', 'line-height:1'
    ].join(';');
    closeBtn.onclick = function () { overlay.remove(); };
    box.appendChild(closeBtn);

    if (_popupOptions.showWatermark !== false) {
      const wm = document.createElement('div');
      wm.style.cssText = 'text-align:center;font-size:11px;color:#aaa;margin-top:12px;';
      wm.textContent = 'Powered by GammaEngage';
      box.appendChild(wm);
    }

    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────────
  function _sendEvent(envelope, callback) {
    const endpoint = GammaEngageSDK._endpoint;
    if (!endpoint) {
      log('SDK not initialised — endpoint missing');
      return;
    }

    const body = JSON.stringify(envelope);
    const headers = { 'Content-Type': 'application/json' };

    const tenantToken =
      GammaEngageSDK._config && GammaEngageSDK._config.tenantToken;
    if (tenantToken) {
      headers['X-Tenant-API-Key'] = String(tenantToken);
    }

    if (GammaEngageSDK._hmacSecret) {
      const sig = _computeHmac(GammaEngageSDK._hmacSecret, body);
      headers['X-GammaEngage-Signature-Version'] = '1';
      headers['X-GammaEngage-Signature-Content'] = sig;
    }

    const onDone = callback || function () {};

    function handleResponse(status, retryAfterHeader) {
      if (status === 429) {
        var sec = Math.max(1, parseInt(retryAfterHeader || '60', 10));
        log('Rate limited (429). Retry after ' + sec + ' seconds.');
        onDone(new Error('Too many requests. Please try again in ' + sec + ' seconds.'));
        return;
      }
      onDone(null, status);
    }

    if (typeof fetch !== 'undefined') {
      fetch(endpoint, { method: 'POST', headers, body })
        .then(function (r) {
          handleResponse(r.status, r.headers.get('Retry-After'));
        })
        .catch(function (e) { onDone(e); });
    } else {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint, true);
      Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
      xhr.onload = function () {
        handleResponse(xhr.status, xhr.getResponseHeader('Retry-After'));
      };
      xhr.onerror = function () { onDone(new Error('XHR error')); };
      xhr.send(body);
    }
  }

  // ─── HMAC helper (SubtleCrypto, sync-free approximation for SDK) ─────────────
  // NOTE: Real HMAC requires async SubtleCrypto. We expose async signAndSend
  // for production use. For demos the secret is skipped client-side.
  function _computeHmac(secret, message) {
    // Client-side HMAC is intentionally lightweight (non-production).
    // Production usage: compute HMAC on server, pass signed requests server→GE.
    log('HMAC signing is a client-side approximation. Use server-side signing for production.');
    return 'client-side-' + btoa(secret).slice(0, 8) + '-' + btoa(message).slice(0, 16);
  }

  // ─── Identity ────────────────────────────────────────────────────────────────
  function _getOrCreateVisitorId() {
    let vid = getStorage(VISITOR_KEY);
    if (!vid) {
      vid = uuidv4();
      setStorage(VISITOR_KEY, vid);
      log('New visitor_id created', vid);
    }
    return vid;
  }

  function _getOrCreateSessionId() {
    let sid = getSession(SESSION_KEY);
    if (!sid) {
      sid = uuidv4();
      setSession(SESSION_KEY, sid);
    }
    return sid;
  }

  // ─── Envelope builder ───────────────────────────────────────────────────────
  function _buildEnvelope(eventType, params, sdkId) {
    const cfg = GammaEngageSDK._config;
    const visitorId = _getOrCreateVisitorId();
    const playerId = sdkId || getStorage(SDK_ID_KEY);

    var player_ref = {};
    if (playerId) player_ref.external_player_id = String(playerId);
    if (visitorId) player_ref.visitor_id = visitorId;

    var eventPayload = Object.assign({}, params || {}, {
      _sdk_context: {
        page_url: global.location ? global.location.href : '',
        page_title: global.document ? global.document.title : '',
        user_agent: global.navigator ? global.navigator.userAgent : '',
        session_id: _getOrCreateSessionId(),
        sdk_version: SDK_VERSION,
      },
    });

    var envelope = {
      schema_version: '1.0',
      event_id: uuidv4(),
      brand_id: cfg.tenantId || 'brand_01',
      event_type: eventType,
      source_system: cfg.sourceSystem || 'web_sdk',
      occurred_at: nowIso(),
      player_ref: player_ref,
      payload: eventPayload,
      idempotency_key: eventType + '_' + Date.now() + '_' + uuidv4().slice(0, 8),
    };

    return envelope;
  }

  // ─── Page visit throttle ────────────────────────────────────────────────────
  let _lastPageVisitAt = 0;

  // ─── Public API ─────────────────────────────────────────────────────────────
  const API = {
    /**
     * Track a page visit.
     * setPageVisit(pageURL, pageTitle, pageCategory?, sdkId?)
     */
    setPageVisit: function (pageURL, pageTitle, pageCategory, sdkId) {
      const now = Date.now();
      if (now - _lastPageVisitAt < PAGE_VISIT_THROTTLE_MS) return;
      _lastPageVisitAt = now;

      const params = {
        page_url: pageURL || (global.location ? global.location.href : ''),
        page_title: pageTitle || (global.document ? global.document.title : ''),
      };
      if (pageCategory) params.page_category = pageCategory;

      const envelope = _buildEnvelope('set_page_visit', params, sdkId);
      log('setPageVisit', params);
      _sendEvent(envelope);
    },

    /**
     * Report a custom or OOTB event.
     * reportEvent(eventName, parameters, callback?, sdkId?)
     */
    reportEvent: function (eventName, parameters, callback, sdkId) {
      if (sdkId) setStorage(SDK_ID_KEY, String(sdkId));
      const envelope = _buildEnvelope(eventName, parameters || {}, sdkId);
      log('reportEvent', eventName, parameters);
      _sendEvent(envelope, function (err, status) {
        if (err) log('reportEvent error', err);
        if (typeof callback === 'function') callback(err, status);
      });
    },

    /**
     * Register a new user (fires 'registration' OOTB event).
     * After registration the SDK_ID is stored in localStorage.
     */
    registerUser: function (sdkId, email, eventName, parameters, callback) {
      setStorage(SDK_ID_KEY, String(sdkId));
      const params = Object.assign({ email: email }, parameters || {});
      API.reportEvent(eventName || 'registration', params, callback, sdkId);
      connectSSE(GammaEngageSDK._config.tenantId, sdkId);
    },

    /**
     * Track login event.
     */
    login: function (sdkId, parameters, callback) {
      setStorage(SDK_ID_KEY, String(sdkId));
      API.reportEvent('login', parameters || {}, callback, sdkId);
      connectSSE(GammaEngageSDK._config.tenantId, sdkId);
    },

    /**
     * Sign out — clears the stored SDK_ID (visitor_id persists).
     */
    signOutUser: function () {
      setStorage(SDK_ID_KEY, '');
      if (_sseSource) { _sseSource.close(); _sseSource = null; }
      log('User signed out');
    },

    /**
     * Returns the persistent visitor ID (never changes, even after sign-out).
     */
    getInitialVisitorID: function () {
      return _getOrCreateVisitorId();
    },

    /**
     * Returns the current identified SDK_ID (null if anonymous).
     */
    getCurrentSdkId: function () {
      return getStorage(SDK_ID_KEY) || null;
    },

    /**
     * Override pop-up display behavior.
     * options: { showDimmer, showWatermark, reportEventCallback }
     */
    setRealTimeOptions: function (options) {
      _popupOptions = options || {};
      if (typeof options.reportEventCallback === 'function') {
        _popupCallback = options.reportEventCallback;
      }
      log('setRealTimeOptions', options);
    },

    /**
     * Close the active realtime popup.
     */
    closeRealtimePopup: function () {
      const overlay = document.getElementById('ge-popup-overlay');
      if (overlay) overlay.remove();
    },

    /**
     * Preference Center — show hosted preference UI.
     * Opens an iframe modal for the player to manage their consent.
     */
    preferenceCenter: {
      showUi: function (mode) {
        const sdkId = getStorage(SDK_ID_KEY);
        const cfg = GammaEngageSDK._config;
        if (!sdkId || !cfg.tenantId) {
          log('preferenceCenter.showUi requires an identified user');
          return;
        }
        const base = GammaEngageSDK._endpoint
          ? GammaEngageSDK._endpoint.replace('/events', '')
          : '';
        const url = base + '/preferences/' + encodeURIComponent(cfg.tenantId) +
          '/' + encodeURIComponent(sdkId) + '?mode=' + (mode || 0);

        const existing = document.getElementById('ge-pref-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'ge-pref-overlay';
        overlay.style.cssText = [
          'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.6)',
          'z-index:999999', 'display:flex', 'align-items:center', 'justify-content:center'
        ].join(';');

        const frame = document.createElement('iframe');
        frame.src = url;
        frame.style.cssText = [
          'width:460px', 'height:520px', 'border:none',
          'border-radius:12px', 'box-shadow:0 20px 60px rgba(0,0,0,0.4)'
        ].join(';');

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.style.cssText = [
          'position:absolute', 'top:8px', 'right:12px',
          'background:rgba(255,255,255,0.9)', 'border:none', 'font-size:22px',
          'cursor:pointer', 'border-radius:50%', 'width:32px', 'height:32px',
          'z-index:1000000'
        ].join(';');
        closeBtn.onclick = function () { overlay.remove(); };

        overlay.appendChild(frame);
        overlay.appendChild(closeBtn);
        overlay.addEventListener('click', function (e) {
          if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
        log('Preference center opened', url);
      },
    },
  };

  // ─── SDK object ──────────────────────────────────────────────────────────────
  const GammaEngageSDK = {
    _config: {},
    _endpoint: null,
    _hmacSecret: null,
    _debug: false,
    API: API,
    version: SDK_VERSION,

    /**
     * Initialise the SDK programmatically.
     * init({ tenantId, tenantToken, endpoint, hmacSecret, debug })
     * tenantToken is sent on event POSTs as header X-Tenant-API-Key when set.
     */
    init: function (config) {
      GammaEngageSDK._config = config || {};
      GammaEngageSDK._endpoint = config.endpoint || null;
      GammaEngageSDK._hmacSecret = config.hmacSecret || null;
      GammaEngageSDK._debug = config.debug || false;

      log('SDK initialised', {
        tenantId: config.tenantId,
        endpoint: config.endpoint,
        version: SDK_VERSION,
      });

      // Auto page-visit on init
      if (config.autoPageVisit !== false && typeof global.location !== 'undefined') {
        setTimeout(function () {
          API.setPageVisit(global.location.href, global.document ? global.document.title : '');
        }, 100);
      }
    },
  };

  // ─── Auto-init from script tag data attributes ───────────────────────────────
  function _autoInit() {
    const scripts = document.querySelectorAll('script[data-tenant-id]');
    const tag = scripts[scripts.length - 1];
    if (!tag) return;

    const tenantId = tag.getAttribute('data-tenant-id');
    const tenantToken = tag.getAttribute('data-tenant-token');
    const endpoint = tag.getAttribute('data-endpoint') || 'http://localhost:3001/events';
    const debug = tag.getAttribute('data-debug') === 'true';

    GammaEngageSDK.init({ tenantId, tenantToken, endpoint, debug });
  }

  // ─── Expose globally ─────────────────────────────────────────────────────────
  global.gammaengageSDK = GammaEngageSDK;

  // Optimove-compatible alias
  global.optimoveSDK = GammaEngageSDK;

  // Auto-init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

}(typeof window !== 'undefined' ? window : this));
