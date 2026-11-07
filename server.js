const path = require('node:path');
const express = require('express');
const {
  getConfig,
  updateConfig,
  recordPollResult,
  getHistoricalSeries,
  getTimeOfDayProfile,
  getTopReturningListeners,
  getAggregatedStats,
  getIpHistory,
  logCustomEvent,
} = require('./src/db');
const { parseUserAgent, parseIcecastClientsPayload } = require('./src/parser');
const { lookupIp } = require('./src/geoip');
const { stepSimulation, kickSimulatedClient } = require('./src/simulator');
const { fetchLiveIcecastTelemetry, kickLiveIcecastClient } = require('./src/icecastClient');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Runtime telemetry state
let latestState = {
  lastUpdatedTs: 0,
  activeSourceMode: 'simulation', // 'live' | 'simulation' | 'imported'
  configuredMode: 'auto',
  connectionStatus: 'initializing', // 'connected' | 'proxy_blocked' | 'unreachable' | 'simulated' | 'imported'
  lastConnectionError: null,
  lastProbeLatencyMs: null,
  endpointUrl: 'https://live.ozone.fm:8443/admin/listclients.xsl?mount=/listen',
  mount: '/listen',
  listeners: [],
  reportedCount: 0,
  sourceMeta: {
    serverName: 'OZONE.FM — Live Broadcast',
    serverDescription: 'Ozone.FM 8443 Stream',
    contentType: 'audio/aacp',
    bitrate: 320,
    samplerate: 48000,
    channels: 2,
    title: 'Loading stream telemetry...',
    genre: 'Electronic / Radio',
    listenerPeak: 0,
    maxListeners: 500,
    listenUrl: 'https://live.ozone.fm:8443/listen',
    serverId: 'Icecast 2.4.4',
  },
};

let lastTrackSeen = '';
let pollTimer = null;
let isPolling = false;

/**
 * Enriches raw listener entries with User-Agent classification, GeoIP lookup,
 * and per-IP connection counts.
 */
function enrichListeners(rawListeners, mount = '/listen') {
  const ipCounts = new Map();
  for (const item of rawListeners) {
    ipCounts.set(item.ip, (ipCounts.get(item.ip) || 0) + 1);
  }

  return rawListeners
    .map((item, idx) => {
      const ua = parseUserAgent(item.userAgent);
      const geo = lookupIp(item.ip);
      return {
        clientId: String(item.clientId || `${item.ip}-${idx}`),
        ip: geo.ip,
        connectedSeconds: Number(item.connectedSeconds) || 0,
        userAgent: item.userAgent,
        mount: item.mount || mount,
        lag: item.lag || 0,
        connectionsFromIp: ipCounts.get(item.ip) || 1,
        ua,
        geo,
      };
    })
    .sort((a, b) => b.connectedSeconds - a.connectedSeconds);
}

/**
 * Computes comprehensive breakdowns (Countries, Cities, Players, Categories, OS, Duration buckets)
 */
function computeBreakdowns(listeners) {
  const total = listeners.length || 1;

  // 1. Countries & Cities
  const countryMap = new Map();
  const cityMap = new Map();
  // 2. Players, Categories, OS
  const playerMap = new Map();
  const categoryMap = new Map();
  const osMap = new Map();

  // 3. Duration buckets
  const durationBuckets = [
    { id: 'u5m', label: '< 5 min', min: 0, max: 300, count: 0 },
    { id: '5to15m', label: '5 – 15 min', min: 300, max: 900, count: 0 },
    { id: '15to30m', label: '15 – 30 min', min: 900, max: 1800, count: 0 },
    { id: '30to60m', label: '30 – 60 min', min: 1800, max: 3600, count: 0 },
    { id: '1to2h', label: '1 – 2 hrs', min: 3600, max: 7200, count: 0 },
    { id: 'over2h', label: '2+ hrs', min: 7200, max: Infinity, count: 0 },
  ];

  let totalDurationSec = 0;

  for (const l of listeners) {
    const sec = l.connectedSeconds || 0;
    totalDurationSec += sec;

    for (const b of durationBuckets) {
      if (sec >= b.min && sec < b.max) {
        b.count++;
        break;
      }
    }

    // Country aggregation
    const cc = l.geo.countryCode || 'UN';
    if (!countryMap.has(cc)) {
      countryMap.set(cc, {
        countryCode: cc,
        countryName: l.geo.countryName || cc,
        count: 0,
        totalDurationSec: 0,
        lat: l.geo.lat,
        lon: l.geo.lon,
      });
    }
    const cEntry = countryMap.get(cc);
    cEntry.count++;
    cEntry.totalDurationSec += sec;

    // City aggregation
    const cityKey = `${l.geo.city}, ${cc}`;
    if (!cityMap.has(cityKey)) {
      cityMap.set(cityKey, {
        city: l.geo.city,
        countryCode: cc,
        countryName: l.geo.countryName,
        lat: l.geo.lat,
        lon: l.geo.lon,
        count: 0,
        totalDurationSec: 0,
      });
    }
    const cityEntry = cityMap.get(cityKey);
    cityEntry.count++;
    cityEntry.totalDurationSec += sec;

    // Player aggregation
    const pName = l.ua.player;
    playerMap.set(pName, (playerMap.get(pName) || 0) + 1);

    // Category aggregation
    const catName = l.ua.category;
    categoryMap.set(catName, (categoryMap.get(catName) || 0) + 1);

    // OS aggregation
    const osName = l.ua.os;
    osMap.set(osName, (osMap.get(osName) || 0) + 1);
  }

  const countries = Array.from(countryMap.values())
    .map(c => ({
      ...c,
      sharePct: Number(((c.count / total) * 100).toFixed(1)),
      avgDurationSec: Math.round(c.totalDurationSec / c.count),
    }))
    .sort((a, b) => b.count - a.count);

  const cities = Array.from(cityMap.values())
    .map(c => ({
      ...c,
      sharePct: Number(((c.count / total) * 100).toFixed(1)),
      avgDurationSec: Math.round(c.totalDurationSec / c.count),
    }))
    .sort((a, b) => b.count - a.count);

  const toSortedDist = mapObj =>
    Array.from(mapObj.entries())
      .map(([name, count]) => ({
        name,
        count,
        sharePct: Number(((count / total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.count - a.count);

  const uniqueIps = new Set(listeners.map(l => l.ip)).size;
  const sortedDurations = listeners.map(l => l.connectedSeconds || 0).sort((a, b) => a - b);
  const avgSessionDurationSec = listeners.length > 0 ? Math.round(totalDurationSec / listeners.length) : 0;
  const medianSessionDurationSec =
    sortedDurations.length > 0 ? sortedDurations[Math.floor(sortedDurations.length / 2)] : 0;
  const p90SessionDurationSec =
    sortedDurations.length > 0 ? sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * 0.9))] : 0;
  const longestSessionSec = sortedDurations.length > 0 ? sortedDurations[sortedDurations.length - 1] : 0;
  const shortestSessionSec = sortedDurations.length > 0 ? sortedDurations[0] : 0;

  return {
    uniqueIps,
    duplicateConnections: Math.max(0, listeners.length - uniqueIps),
    avgSessionDurationSec,
    medianSessionDurationSec,
    p90SessionDurationSec,
    longestSessionSec,
    shortestSessionSec,
    totalActiveListeningHours: Number((totalDurationSec / 3600).toFixed(2)),
    countries,
    cities,
    players: toSortedDist(playerMap),
    categories: toSortedDist(categoryMap),
    platforms: toSortedDist(osMap),
    durationBuckets: durationBuckets.map(b => ({
      ...b,
      max: b.max === Infinity ? null : b.max,
      sharePct: listeners.length > 0 ? Number(((b.count / total) * 100).toFixed(1)) : 0,
    })),
  };
}

/**
 * Executes a single poll cycle according to current config.
 */
async function executePollCycle(forceLiveAttempt = false) {
  if (isPolling) return latestState;
  isPolling = true;

  try {
    const config = getConfig();
    const baseUrl = String(config.baseUrl || 'https://live.ozone.fm:8443').replace(/\/+$/, '');
    const mount = config.mount?.startsWith('/') ? config.mount : `/${config.mount || 'listen'}`;
    const endpointUrl = `${baseUrl}/admin/listclients.xsl?mount=${encodeURIComponent(mount)}`;

    let rawResult = null;
    let activeMode = 'live';
    let connectionStatus = 'connected';
    let lastError = null;
    let probeLatencyMs = null;

    if (config.sourceMode === 'simulation' && !forceLiveAttempt) {
      rawResult = stepSimulation(mount);
      activeMode = 'simulation';
      connectionStatus = 'simulated';
    } else {
      // Try live Icecast server first ('live' or 'auto' mode)
      const t0 = Date.now();
      try {
        rawResult = await fetchLiveIcecastTelemetry(config);
        probeLatencyMs = Date.now() - t0;
        activeMode = 'live';
        connectionStatus = 'connected';
        lastError = null;
      } catch (err) {
        probeLatencyMs = Date.now() - t0;
        lastError = err.message || 'Connection failed';
        const isProxyBlock = lastError.includes('403') || lastError.includes('Proxy');

        if (config.sourceMode === 'auto') {
          rawResult = stepSimulation(mount);
          activeMode = 'simulation';
          connectionStatus = isProxyBlock ? 'proxy_blocked' : 'unreachable';
        } else {
          // Strict 'live' mode: keep previous listeners or empty, surface error
          activeMode = 'live';
          connectionStatus = isProxyBlock ? 'proxy_blocked' : 'unreachable';
          rawResult = {
            listeners: latestState.activeSourceMode === 'live' ? latestState.listeners : [],
            reportedCount: 0,
            sourceMeta: latestState.sourceMeta,
          };
        }
      }
    }

    const enriched = enrichListeners(rawResult.listeners || [], mount);
    const currentTrack = rawResult.sourceMeta?.title || '';

    recordPollResult({
      mount,
      enrichedListeners: enriched,
      reportedPeak: rawResult.sourceMeta?.listenerPeak || enriched.length,
      currentTrack,
      bitrate: rawResult.sourceMeta?.bitrate || 320,
      sourceMode: activeMode,
      lastTrack: lastTrackSeen,
    });

    if (currentTrack) {
      lastTrackSeen = currentTrack;
    }

    latestState = {
      lastUpdatedTs: Date.now(),
      activeSourceMode: activeMode,
      configuredMode: config.sourceMode,
      connectionStatus,
      lastConnectionError: lastError,
      lastProbeLatencyMs: probeLatencyMs,
      endpointUrl,
      baseUrl,
      mount,
      listeners: enriched,
      reportedCount: rawResult.reportedCount ?? enriched.length,
      sourceMeta: {
        ...latestState.sourceMeta,
        ...(rawResult.sourceMeta || {}),
      },
    };
  } finally {
    isPolling = false;
  }

  return latestState;
}

function schedulePoller() {
  if (pollTimer) clearInterval(pollTimer);
  const cfg = getConfig();
  const intervalMs = Math.max(3, Number(cfg.pollIntervalSec) || 10) * 1000;
  pollTimer = setInterval(() => {
    executePollCycle().catch(err => console.error('Poll error:', err.message));
  }, intervalMs);
}

// API: Full Dashboard Telemetry Payload
app.get('/api/dashboard', async (req, res) => {
  if (latestState.lastUpdatedTs === 0) {
    await executePollCycle();
  }
  const rangeMinutes = Math.min(10080, Math.max(5, parseInt(req.query.rangeMinutes || '60', 10) || 60));
  const modeForHistory = latestState.activeSourceMode === 'imported' ? 'live' : latestState.activeSourceMode;
  const breakdowns = computeBreakdowns(latestState.listeners);
  const history = getHistoricalSeries(rangeMinutes, modeForHistory);
  const timeOfDay = getTimeOfDayProfile(modeForHistory);
  const topReturningListeners = getTopReturningListeners(5, modeForHistory);
  const stats24h = getAggregatedStats(modeForHistory);
  const config = getConfig();

  res.json({
    ok: true,
    timestamp: latestState.lastUpdatedTs,
    connection: {
      activeSourceMode: latestState.activeSourceMode,
      configuredMode: latestState.configuredMode,
      status: latestState.connectionStatus,
      error: latestState.lastConnectionError,
      latencyMs: latestState.lastProbeLatencyMs,
      endpointUrl: latestState.endpointUrl,
      baseUrl: latestState.baseUrl,
      mount: latestState.mount,
      pollIntervalSec: config.pollIntervalSec,
    },
    stream: latestState.sourceMeta,
    kpis: {
      currentListeners: latestState.listeners.length,
      reportedListeners: latestState.reportedCount,
      uniqueIps: breakdowns.uniqueIps,
      duplicateConnections: breakdowns.duplicateConnections,
      avgSessionDurationSec: breakdowns.avgSessionDurationSec,
      medianSessionDurationSec: breakdowns.medianSessionDurationSec,
      p90SessionDurationSec: breakdowns.p90SessionDurationSec,
      longestSessionSec: breakdowns.longestSessionSec,
      shortestSessionSec: breakdowns.shortestSessionSec,
      totalActiveListeningHours: breakdowns.totalActiveListeningHours,
      peak24h: Math.max(stats24h.peak24h, latestState.listeners.length, latestState.sourceMeta.listenerPeak || 0),
      peak24hTs: stats24h.peak24hTs,
      allTimePeak: Math.max(stats24h.allTimePeak, latestState.listeners.length, latestState.sourceMeta.listenerPeak || 0),
      totalSessions24h: stats24h.totalSessions24h,
      uniqueIps24h: Math.max(stats24h.uniqueIps24h, breakdowns.uniqueIps),
      uniqueCountries24h: Math.max(stats24h.uniqueCountries24h, breakdowns.countries.length),
      totalListeningHours24h: Math.max(stats24h.totalListeningHours24h, breakdowns.totalActiveListeningHours),
      returningListenerCount: stats24h.returningListenerCount,
      maxCapacity: latestState.sourceMeta.maxListeners || config.maxListenersCapacity || 500,
    },
    listeners: latestState.listeners,
    breakdowns: {
      countries: breakdowns.countries,
      cities: breakdowns.cities,
      players: breakdowns.players,
      categories: breakdowns.categories,
      platforms: breakdowns.platforms,
      durationBuckets: breakdowns.durationBuckets,
    },
    timeOfDay,
    topReturningListeners,
    history,
    recentEvents: stats24h.recentEvents,
  });
});

// API: Force immediate poll
app.post('/api/poll', async (req, res) => {
  await executePollCycle(Boolean(req.body?.forceLive));
  res.json({ ok: true, status: latestState.connectionStatus, count: latestState.listeners.length });
});

// API: IP session history & geolocation lookup
app.get('/api/ip/:ip', (req, res) => {
  const ip = req.params.ip;
  const geo = lookupIp(ip);
  const history = getIpHistory(geo.ip);
  const activeMatches = latestState.listeners.filter(l => l.ip === geo.ip);
  res.json({
    ok: true,
    ip: geo.ip,
    geo,
    activeConnections: activeMatches,
    history,
  });
});

// API: Kick client
app.post('/api/kick', async (req, res) => {
  const { clientId, ip, mount } = req.body || {};
  if (!clientId) {
    return res.status(400).json({ ok: false, error: 'clientId is required' });
  }

  const config = getConfig();
  try {
    if (latestState.activeSourceMode === 'live') {
      await kickLiveIcecastClient(config, clientId, mount || config.mount);
      logCustomEvent('kick', `Kicked client #${clientId} (${ip || 'unknown IP'}) from live server`, ip, mount || config.mount);
      await executePollCycle(true);
      return res.json({ ok: true, mode: 'live', message: `Client #${clientId} disconnected from Icecast` });
    } else {
      const simRes = kickSimulatedClient(clientId);
      latestState.listeners = latestState.listeners.filter(l => String(l.clientId) !== String(clientId));
      logCustomEvent('kick', `Kicked client #${clientId} (${ip || simRes.client?.ip || ''})`, ip || simRes.client?.ip || '', mount || config.mount);
      return res.json({ ok: true, mode: latestState.activeSourceMode, message: `Client #${clientId} disconnected` });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Import raw listclients.xsl HTML or XML payload
app.post('/api/import-snapshot', (req, res) => {
  const { payload, mount } = req.body || {};
  if (!payload || typeof payload !== 'string') {
    return res.status(400).json({ ok: false, error: 'Paste the HTML or XML content from listclients.xsl' });
  }

  const targetMount = mount || latestState.mount || '/listen';
  const parsed = parseIcecastClientsPayload(payload, targetMount);
  if (parsed.listeners.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'No valid listener rows (IP, Connected Seconds, User-Agent) found in the provided XSL/XML payload.',
    });
  }

  const enriched = enrichListeners(parsed.listeners, targetMount);
  recordPollResult({
    mount: targetMount,
    enrichedListeners: enriched,
    reportedPeak: Math.max(parsed.reportedCount, enriched.length),
    currentTrack: parsed.sourceMeta?.title || latestState.sourceMeta.title,
    bitrate: parsed.sourceMeta?.bitrate || latestState.sourceMeta.bitrate,
    sourceMode: 'live',
    lastTrack: lastTrackSeen,
  });

  latestState = {
    ...latestState,
    lastUpdatedTs: Date.now(),
    activeSourceMode: 'imported',
    connectionStatus: 'imported',
    lastConnectionError: null,
    listeners: enriched,
    reportedCount: parsed.reportedCount,
  };

  logCustomEvent('import', `Imported ${enriched.length} listeners from raw ${parsed.format.toUpperCase()} snapshot`, '', targetMount);

  res.json({
    ok: true,
    importedCount: enriched.length,
    format: parsed.format,
  });
});

// API: Get & Update Server Connection Config
app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    ok: true,
    config: cfg,
  });
});

app.post('/api/config', async (req, res) => {
  const body = req.body || {};
  const allowed = {};
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
    allowed.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof body.mount === 'string' && body.mount.trim()) {
    allowed.mount = body.mount.trim().startsWith('/') ? body.mount.trim() : `/${body.mount.trim()}`;
  }
  if (typeof body.username === 'string') {
    allowed.username = body.username.trim();
  }
  if (typeof body.password === 'string' && body.password.length > 0) {
    allowed.password = body.password;
  }
  if (body.pollIntervalSec !== undefined) {
    allowed.pollIntervalSec = Math.max(3, Math.min(300, parseInt(body.pollIntervalSec, 10) || 10));
  }
  if (typeof body.ignoreTlsErrors === 'boolean') {
    allowed.ignoreTlsErrors = body.ignoreTlsErrors;
  }
  if (['auto', 'live', 'simulation'].includes(body.sourceMode)) {
    allowed.sourceMode = body.sourceMode;
  }
  if (typeof body.stationName === 'string' && body.stationName.trim()) {
    allowed.stationName = body.stationName.trim();
  }
  if (body.maxListenersCapacity !== undefined) {
    allowed.maxListenersCapacity = Math.max(10, parseInt(body.maxListenersCapacity, 10) || 500);
  }

  const updated = updateConfig(allowed);
  schedulePoller();
  await executePollCycle(allowed.sourceMode === 'live');

  res.json({
    ok: true,
    config: updated,
    connectionStatus: latestState.connectionStatus,
    activeSourceMode: latestState.activeSourceMode,
    error: latestState.lastConnectionError,
  });
});

// API: Test direct connection to Icecast endpoint
app.post('/api/test-connection', async (req, res) => {
  const current = getConfig();
  const testCfg = {
    ...current,
    ...(req.body || {}),
  };
  const t0 = Date.now();
  try {
    const result = await fetchLiveIcecastTelemetry(testCfg);
    res.json({
      ok: true,
      latencyMs: Date.now() - t0,
      listenerCount: result.listeners.length,
      format: result.format,
      endpointUsed: result.endpointUsed,
      sourceMeta: result.sourceMeta,
    });
  } catch (err) {
    res.json({
      ok: false,
      latencyMs: Date.now() - t0,
      error: err.message,
    });
  }
});

// Start initial poll & server
executePollCycle()
  .catch(err => console.error('Initial poll failed:', err.message))
  .finally(() => {
    schedulePoller();
    app.listen(PORT, () => {
      console.log(`OzoneCast Telemetry Server running on http://localhost:${PORT}`);
    });
  });
