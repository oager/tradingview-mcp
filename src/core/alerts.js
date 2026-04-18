/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// Map common condition aliases to TradingView's canonical types.
const CONDITION_MAP = {
  'crossing': 'cross', 'cross': 'cross',
  'crossing_up': 'cross_up', 'cross_up': 'cross_up', 'greater_than': 'cross_up', 'above': 'cross_up',
  'crossing_down': 'cross_down', 'cross_down': 'cross_down', 'less_than': 'cross_down', 'below': 'cross_down',
  'greater': 'greater', 'less': 'less',
};

/**
 * Create a TradingView price alert by POSTing directly to the pricealerts REST API.
 * Bypasses DOM automation (brittle) and isolated-world CORS restrictions (blocked).
 * Uses session cookies pulled via CDP.
 */
export async function create({ condition, price, message }) {
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum)) {
    return { success: false, error: `price must be a finite number, got: ${price}` };
  }
  const conditionType = CONDITION_MAP[condition] || condition;

  // 1. Pull current symbol name from the chart.
  // NOTE: We deliberately do NOT pull session/currency-id from symbolInfo —
  // those fields return TradingView-internal formats (e.g. session: "0000-0000:1234567",
  // currency_code: "USDT") that the pricealerts API rejects. The server fills in
  // canonical defaults (session:"regular", adjustment:"splits", currency-id:"XTVCUSDT")
  // automatically when we send just the symbol string. Keep it minimal.
  const symCtx = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { symbol: chart.symbol() };
    })()
  `);

  if (!symCtx || !symCtx.symbol) {
    return { success: false, error: 'Could not read current chart symbol' };
  }

  // 2. Grab session cookies via CDP Network domain
  const client = await getClient();
  try { await client.Network.enable(); } catch {}
  const { cookies } = await client.Network.getCookies({
    urls: ['https://www.tradingview.com', 'https://pricealerts.tradingview.com'],
  });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // 3. Build the TradingView-expected symbol string (JSON prefixed with '=').
  // Keep minimal — server auto-fills session/adjustment/currency-id with canonical values.
  const symJson = { symbol: symCtx.symbol, session: 'regular' };

  const autoMessage = `${symCtx.symbol.split(':').pop()} ${conditionType.replace('_', ' ')} ${priceNum}`;
  const alertName = message || autoMessage;

  const payload = {
    payload: {
      symbol: '=' + JSON.stringify(symJson),
      resolution: '1',
      message: message || autoMessage,
      sound_file: 'alert/3_notes_reverb',
      sound_duration: 5,
      popup: true,
      expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      auto_deactivate: true,
      email: false,
      sms_over_email: false,
      mobile_push: true,
      web_hook: null,
      name: alertName,
      conditions: [{
        type: conditionType,
        frequency: 'on_first_fire',
        series: [{ type: 'barset' }, { type: 'value', value: priceNum }],
        resolution: '1',
      }],
      active: true,
      ignore_warnings: true,
    },
  };

  // 4. POST from Node (no CORS restrictions)
  let resp, text;
  try {
    resp = await fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/chart/',
        'User-Agent': 'Mozilla/5.0 (TradingView-MCP)',
        'Cookie': cookieHeader,
      },
      body: JSON.stringify(payload),
    });
    text = await resp.text();
  } catch (err) {
    return { success: false, error: `Network error: ${err.message}`, source: 'rest_api' };
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}

  const ok = resp.ok && parsed && parsed.s === 'ok';
  return {
    success: ok,
    status: resp.status,
    alert_id: parsed?.r?.alert_id || null,
    symbol: symCtx.symbol,
    price: priceNum,
    condition: conditionType,
    message: payload.payload.message,
    error: ok ? null : (parsed?.errmsg || text.slice(0, 300)),
    source: 'rest_api',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

/**
 * Delete one or more alerts via the pricealerts REST API.
 * Pass { alert_ids: [id, id, ...] } to delete specific alerts,
 * or { delete_all: true } to delete every active alert (fetches list first).
 */
export async function deleteAlerts({ delete_all, alert_ids }) {
  let ids = Array.isArray(alert_ids) ? alert_ids.slice() : [];
  if (delete_all) {
    const all = await list();
    for (const a of all.alerts || []) {
      if (a.alert_id != null) ids.push(a.alert_id);
    }
  }
  if (ids.length === 0) {
    return { success: false, error: 'No alert_ids given and delete_all was not set' };
  }

  // Get session cookies via CDP for Node-side POST
  const client = await getClient();
  try { await client.Network.enable(); } catch {}
  const { cookies } = await client.Network.getCookies({
    urls: ['https://www.tradingview.com', 'https://pricealerts.tradingview.com'],
  });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  let resp, text;
  try {
    resp = await fetch('https://pricealerts.tradingview.com/delete_alerts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/chart/',
        'User-Agent': 'Mozilla/5.0 (TradingView-MCP)',
        'Cookie': cookieHeader,
      },
      body: JSON.stringify({ payload: { alert_ids: ids } }),
    });
    text = await resp.text();
  } catch (err) {
    return { success: false, error: `Network error: ${err.message}`, source: 'rest_api' };
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const ok = resp.ok && parsed && parsed.s === 'ok';
  return {
    success: ok,
    status: resp.status,
    deleted_ids: ids,
    count: ids.length,
    error: ok ? null : (parsed?.errmsg || text.slice(0, 300)),
    source: 'rest_api',
  };
}
