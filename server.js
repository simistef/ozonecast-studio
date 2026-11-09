const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const express = require('express');
const {
  getConfig,
  updateConfig,
  recordPollResult,
  getHistoricalSeries,
  getHistoricalTrackChanges,
  getHistoricalBreakdowns,
  getTimeOfDayProfile,
  getTopReturningListeners,
  getAggregatedStats,
  getIpHistory,
  getIpAliasesMap,
  setIpAlias,
  getBotIpsSet,
  isBotIp,
  setBotIp,
  getBotActivity,
  logCustomEvent,
  getDetractorSongs,
  getDetractorSummary,
} = require('./src/db');
const { parseUserAgent, parseIcecastClientsPayload, deduplicateListenersByDevice } = require('./src/parser');
const { lookupIp, resolveIpHighAccuracy } = require('./src/geoip');
const { stepSimulation, kickSimulatedClient } = require('./src/simulator');
const { fetchLiveIcecastTelemetry, kickLiveIcecastClient } = require('./src/icecastClient');

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10) || 3443;

function safeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Docker healthcheck endpoint (unauthenticated)
app.get(['/api/health', '/api/healthz'], (_req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

// Protect dashboard & API with the same username and password as Icecast Admin
app.use((req, res, next) => {
  const cfg = getConfig();
  if (cfg.requireDashboardAuth === false) return next();

  const expectedUser = cfg.username || 'admin';
  const expectedPass = cfg.password || 'Wo10vn57zomq?';

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    if (sepIdx !== -1) {
      const user = decoded.slice(0, sepIdx);
      const pass = decoded.slice(sepIdx + 1);
      if (safeStringEqual(user, expectedUser) && safeStringEqual(pass, expectedPass)) {
        return next();
      }
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="OzoneCast Studio - OZONE.FM Admin"');
  return res.status(401).send('Authentication required: Enter your Icecast Admin username and password.');
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

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
let trackStartTs = Date.now();
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
  const botIps = getBotIpsSet();

  return rawListeners
    .map((item, idx) => {
      let ua = parseUserAgent(item.userAgent);
      const isManualBot = botIps.has(item.ip);
      const isBot = isManualBot || ua.isRipper || ua.category === 'Bot / Ripper';
      if (isManualBot) {
        ua = {
          ...ua,
          category: 'Bot / Ripper',
          isRipper: true,
          isManualBot: true,
        };
      }
      const geo = lookupIp(item.ip);
      return {
        clientId: String(item.clientId || `${item.ip}-${idx}`),
        ip: geo.ip,
        connectedSeconds: Number(item.connectedSeconds) || 0,
        userAgent: item.userAgent,
        mount: item.mount || mount,
        lag: item.lag || 0,
        connectionsFromIp: ipCounts.get(item.ip) || 1,
        isBot,
        isManualBot,
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
        uniqueIps: new Set(),
      });
    }
    const cEntry = countryMap.get(cc);
    cEntry.count++;
    cEntry.totalDurationSec += sec;
    cEntry.uniqueIps.add(l.ip);

    // City aggregation
    const cName = l.geo.countryName || cc;
    const rawCity = (l.geo.city || '').trim();
    const hasCity = Boolean(l.geo.hasCity && rawCity && rawCity !== cName);
    const displayCity = hasCity ? rawCity : `Unresolved City (${cName})`;
    const cityKey = hasCity ? `${rawCity}::${cc}` : `unresolved::${cc}`;
    if (!cityMap.has(cityKey)) {
      cityMap.set(cityKey, {
        city: displayCity,
        hasCity,
        countryCode: cc,
        countryName: cName,
        lat: l.geo.lat,
        lon: l.geo.lon,
        count: 0,
        totalDurationSec: 0,
        uniqueIps: new Set(),
      });
    }
    const cityEntry = cityMap.get(cityKey);
    cityEntry.count++;
    cityEntry.totalDurationSec += sec;
    cityEntry.uniqueIps.add(l.ip);

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
      countryCode: c.countryCode,
      countryName: c.countryName,
      count: c.count,
      totalDurationSec: c.totalDurationSec,
      lat: c.lat,
      lon: c.lon,
      uniqueIps: c.uniqueIps ? c.uniqueIps.size : 1,
      sharePct: Number(((c.count / total) * 100).toFixed(1)),
      avgDurationSec: Math.round(c.totalDurationSec / c.count),
    }))
    .sort((a, b) => b.count - a.count);

  const cities = Array.from(cityMap.values())
    .map(c => ({
      city: c.city,
      hasCity: c.hasCity,
      countryCode: c.countryCode,
      countryName: c.countryName,
      lat: c.lat,
      lon: c.lon,
      count: c.count,
      totalDurationSec: c.totalDurationSec,
      uniqueIps: c.uniqueIps ? c.uniqueIps.size : 1,
      sharePct: Number(((c.count / total) * 100).toFixed(1)),
      avgDurationSec: Math.round(c.totalDurationSec / c.count),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.hasCity !== b.hasCity) return a.hasCity ? -1 : 1;
      return a.city.localeCompare(b.city);
    });

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

    if (currentTrack && currentTrack !== lastTrackSeen) {
      trackStartTs = Date.now();
    }
    const trackProgressSec = currentTrack ? Math.max(0, Math.floor((Date.now() - trackStartTs) / 1000)) : 0;

    recordPollResult({
      mount,
      enrichedListeners: enriched,
      reportedPeak: rawResult.sourceMeta?.listenerPeak || enriched.length,
      currentTrack,
      trackProgressSec,
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
  try {
    if (latestState.lastUpdatedTs === 0) {
      await executePollCycle();
    }
    const rangeMinutes = Math.min(10080, Math.max(5, parseInt(req.query.rangeMinutes || '60', 10) || 60));
    const excludeBots = req.query.excludeBots === '1' || req.query.excludeBots === 'true';
    const modeForHistory = latestState.activeSourceMode === 'imported' ? 'live' : latestState.activeSourceMode;
    const config = getConfig();
    const ipAliases = getIpAliasesMap();

    const allListeners = latestState.listeners || [];
    const humanListeners = allListeners.filter(l => !l.isBot);
    const botListeners = allListeners.filter(l => l.isBot);

    // Deduplicate human listeners by device/player:
    // Same IP and player/user-agent count as 1 listener,
    // unless under the same IP there are two separate players or agents.
    const deduplicatedHuman = deduplicateListenersByDevice(humanListeners);

    // All dashboard analytics, historical charts, geographic distributions, world map pins,
    // top-line KPIs, and time-of-day stats ALWAYS measure genuine human listeners only.
    const breakdownsLive = computeBreakdowns(deduplicatedHuman);
    const breakdowns24h = getHistoricalBreakdowns(1440, modeForHistory, true);
    const breakdowns7d = getHistoricalBreakdowns(10080, modeForHistory, true);
    const breakdownsAll = getHistoricalBreakdowns(0, modeForHistory, true);

    const breakdownsByPeriod = {
      live: {
        ...breakdownsLive,
        mapLocations: deduplicatedHuman.map(l => ({
          ip: l.ip,
          lat: l.geo?.lat ?? l.lat,
          lon: l.geo?.lon ?? l.lon,
          city: l.geo?.city || l.city || '',
          countryCode: l.geo?.countryCode || l.countryCode || 'UN',
          countryName: l.geo?.countryName || l.countryName || '',
          player: l.ua?.player || l.player || 'Other',
          category: l.ua?.category || l.category || 'Other',
          os: l.ua?.os || l.os || 'Other',
          connectedSeconds: l.connectedSeconds,
          isBot: false,
          activeStreams: l.streamCount || 1,
          friendlyName: ipAliases[l.ip]?.friendlyName || '',
          geo: l.geo || {
            lat: l.lat,
            lon: l.lon,
            city: l.city,
            countryCode: l.countryCode,
            countryName: l.countryName,
            hasCity: Boolean(l.city),
          },
          ua: l.ua || {
            player: l.player,
            category: l.category,
            os: l.os,
            isRipper: false,
          },
        })),
        detractorSongs: breakdowns24h.detractorSongs,
        detractorSummary: breakdowns24h.detractorSummary,
      },
      '24h': breakdowns24h,
      '7d': breakdowns7d,
      all: breakdownsAll,
    };

    const history = getHistoricalSeries(rangeMinutes, modeForHistory, true);
    const trackChanges = getHistoricalTrackChanges(rangeMinutes, modeForHistory);
    const timeOfDay = getTimeOfDayProfile(modeForHistory, true);
    const topReturningListeners = getTopReturningListeners(5, modeForHistory);
    const stats24h = getAggregatedStats(modeForHistory, true);

    // Collect bot activity for dedicated bottom bot card
    const botActivity = getBotActivity(1440, modeForHistory);
    const activeBotIps = new Set(botListeners.map(b => b.ip));
    botActivity.activeCount = Math.max(botActivity.activeCount, botListeners.length);
    for (const b of botActivity.bots) {
      if (activeBotIps.has(b.ip)) {
        b.isActive = true;
      }
    }
    for (const bl of botListeners) {
      if (!botActivity.bots.some(b => b.ip === bl.ip)) {
        botActivity.bots.unshift({
          ip: bl.ip,
          friendlyName: ipAliases[bl.ip]?.friendlyName || '',
          countryCode: bl.geo?.countryCode || 'UN',
          countryName: bl.geo?.countryName || 'Unknown',
          city: bl.geo?.city || '',
          isp: bl.geo?.isp || '',
          userAgent: bl.userAgent || bl.ua?.raw || '',
          player: bl.ua?.player || 'Bot / Ripper',
          reason: 'Active Live Stream Connection',
          isExplicitBot: Boolean(bl.isManualBot),
          isActive: true,
          sessionCount: 1,
          totalDurationSeconds: bl.connectedSeconds || 0,
          firstSeen: Date.now() - (bl.connectedSeconds * 1000),
          lastSeen: Date.now(),
        });
      }
    }
    botActivity.total24hCount = botActivity.bots.length;

    const listenersWithAliases = allListeners.map(l => ({
      ...l,
      friendlyName: ipAliases[l.ip]?.friendlyName || '',
      notes: ipAliases[l.ip]?.notes || '',
    }));

    res.json({
      ok: true,
      timestamp: latestState.lastUpdatedTs,
      excludeBots: true,
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
        currentListeners: deduplicatedHuman.length,
        totalListenersRaw: allListeners.length,
        humanListenersCount: deduplicatedHuman.length,
        humanStreamsCount: humanListeners.length,
        totalStreams: humanListeners.length,
        botListenersCount: botListeners.length,
        excludeBots: true,
        reportedListeners: deduplicatedHuman.length,
        uniqueIps: breakdownsLive.uniqueIps,
        duplicateConnections: Math.max(0, humanListeners.length - deduplicatedHuman.length),
        avgSessionDurationSec: breakdownsLive.avgSessionDurationSec,
        medianSessionDurationSec: breakdownsLive.medianSessionDurationSec,
        p90SessionDurationSec: breakdownsLive.p90SessionDurationSec,
        longestSessionSec: breakdownsLive.longestSessionSec,
        shortestSessionSec: breakdownsLive.shortestSessionSec,
        totalActiveListeningHours: breakdownsLive.totalActiveListeningHours,
        peak24h: Math.max(stats24h.peak24h, deduplicatedHuman.length),
        peak24hTs: stats24h.peak24hTs,
        allTimePeak: Math.max(stats24h.allTimePeak, deduplicatedHuman.length),
        totalSessions24h: stats24h.totalSessions24h,
        uniqueIps24h: Math.max(stats24h.uniqueIps24h, breakdownsLive.uniqueIps),
        uniqueCountries24h: Math.max(stats24h.uniqueCountries24h, breakdownsLive.countries.length),
        totalListeningHours24h: Math.max(stats24h.totalListeningHours24h, breakdownsLive.totalActiveListeningHours),
        returningListenerCount: stats24h.returningListenerCount,
        returningMinAvgSec: config.returningMinAvgSec ?? 60,
        returningExcludeBots: true,
        maxCapacity: latestState.sourceMeta.maxListeners || config.maxListenersCapacity || 500,
      },
      listeners: listenersWithAliases,
      ipAliases,
      botActivity,
      breakdowns: {
        countries: breakdownsLive.countries,
        cities: breakdownsLive.cities,
        players: breakdownsLive.players,
        categories: breakdownsLive.categories,
        platforms: breakdownsLive.platforms,
        durationBuckets: breakdownsLive.durationBuckets,
      },
      breakdownsByPeriod,
      detractorSongs: breakdowns24h.detractorSongs || getDetractorSongs(1440, modeForHistory, true, 10),
      detractorSummary: breakdowns24h.detractorSummary || getDetractorSummary(1440, modeForHistory, true),
      timeOfDay,
      topReturningListeners,
      history,
      trackChanges,
      recentEvents: stats24h.recentEvents,
    });
  } catch (err) {
    console.error('Error in /api/dashboard handler:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Detractor Songs (Tune-Outs & Drop-offs)
app.get('/api/detractor-songs', (req, res) => {
  const rangeMinutes = req.query.rangeMinutes !== undefined ? parseInt(req.query.rangeMinutes, 10) : 1440;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
  const mode = latestState.activeSourceMode === 'imported' ? 'live' : latestState.activeSourceMode;
  const songs = getDetractorSongs(rangeMinutes, mode, true, limit);
  const summary = getDetractorSummary(rangeMinutes, mode, true);
  res.json({ ok: true, rangeMinutes, excludeBots: true, songs, summary });
});

// API: Time-of-Day Audience Profile & Day-of-Week Breakdown
app.get('/api/time-of-day', (req, res) => {
  const day = req.query.day || 'all';
  const mode = latestState.activeSourceMode === 'imported' ? 'live' : latestState.activeSourceMode;
  const profile = getTimeOfDayProfile(mode, true, day);
  res.json({ ok: true, excludeBots: true, activeDay: day, profile });
});

// API: Force immediate poll
app.post('/api/poll', async (req, res) => {
  await executePollCycle(Boolean(req.body?.forceLive));
  res.json({ ok: true, status: latestState.connectionStatus, count: latestState.listeners.length });
});

// API: IP session history & geolocation lookup
app.get('/api/ip/:ip', async (req, res) => {
  try {
    const rawIp = req.params.ip;
    const geo = await resolveIpHighAccuracy(rawIp, 1500);
    const history = getIpHistory(geo.ip);
    const activeMatches = (latestState.listeners || []).filter(l => l.ip === geo.ip);
    const currentTrackProgressSec = latestState.sourceMeta?.title
      ? Math.max(0, Math.floor((Date.now() - trackStartTs) / 1000))
      : 0;

    res.json({
      ok: true,
      ip: geo.ip,
      friendlyName: history?.friendlyName || '',
      notes: history?.notes || '',
      geo,
      activeConnections: activeMatches,
      currentTrack: latestState.sourceMeta?.title || '',
      currentTrackProgressSec,
      history: history || { summary: {}, sessions: [] },
    });
  } catch (err) {
    console.error('Error in /api/ip/:ip handler:', err.message);
    const fallbackGeo = lookupIp(req.params.ip);
    res.json({
      ok: true,
      ip: fallbackGeo.ip,
      friendlyName: '',
      notes: '',
      geo: fallbackGeo,
      activeConnections: [],
      currentTrack: latestState.sourceMeta?.title || '',
      currentTrackProgressSec: 0,
      history: { summary: {}, sessions: [] },
    });
  }
});

// API: Save or clear friendly name / alias for an IP address
app.post('/api/ip/:ip/alias', (req, res) => {
  try {
    const geo = lookupIp(req.params.ip);
    const { friendlyName, notes } = req.body || {};
    const saved = setIpAlias(geo.ip, friendlyName, notes);
    res.json({ ok: true, alias: saved });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// API: Flag or unflag an IP as Bot / Ripper
app.post('/api/ip/:ip/bot', (req, res) => {
  try {
    const geo = lookupIp(req.params.ip);
    const { isBot, reason } = req.body || {};
    const updatedStatus = setBotIp(geo.ip, Boolean(isBot), reason || '');

    // Instantly update active listeners in latestState
    const botIps = getBotIpsSet();
    for (const l of latestState.listeners) {
      if (l.ip === geo.ip) {
        l.isBot = updatedStatus;
        l.isManualBot = updatedStatus;
        if (updatedStatus) {
          l.ua.category = 'Bot / Ripper';
          l.ua.isRipper = true;
        } else {
          const parsed = parseUserAgent(l.userAgent);
          l.ua.category = parsed.category;
          l.ua.isRipper = parsed.isRipper;
        }
      }
    }

    res.json({ ok: true, ip: geo.ip, isBot: updatedStatus });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// API: Kick client(s)
app.post('/api/kick', async (req, res) => {
  const { clientId, clientIds, ip, mount } = req.body || {};
  const idsToKick = Array.isArray(clientIds) && clientIds.length > 0
    ? clientIds.map(String)
    : (clientId ? [String(clientId)] : []);

  if (idsToKick.length === 0 && !ip) {
    return res.status(400).json({ ok: false, error: 'clientId, clientIds, or ip is required' });
  }

  const config = getConfig();
  try {
    if (latestState.activeSourceMode === 'live') {
      let targetIds = [...idsToKick];
      if (targetIds.length === 0 && ip) {
        targetIds = (latestState.listeners || []).filter(l => l.ip === ip).map(l => String(l.clientId));
      }

      const kicked = [];
      for (const cid of targetIds) {
        try {
          await kickLiveIcecastClient(config, cid, mount || config.mount);
          kicked.push(cid);
        } catch (e) {
          console.warn(`Kick attempt failed for client #${cid}:`, e.message);
        }
      }
      logCustomEvent('kick', `Kicked listener ${ip || ''} (${kicked.length} stream(s): #${kicked.join(', #')}) from live server`, ip, mount || config.mount);
      await executePollCycle(true);
      return res.json({ ok: true, mode: 'live', message: `Disconnected ${kicked.length || 1} connection(s)` });
    } else {
      let targetIds = [...idsToKick];
      if (targetIds.length === 0 && ip) {
        targetIds = (latestState.listeners || []).filter(l => l.ip === ip).map(l => String(l.clientId));
      }
      for (const cid of targetIds) {
        kickSimulatedClient(cid);
      }
      latestState.listeners = latestState.listeners.filter(l => !targetIds.includes(String(l.clientId)));
      logCustomEvent('kick', `Kicked listener ${ip || ''} (${targetIds.length} stream(s))`, ip, mount || config.mount);
      return res.json({ ok: true, mode: latestState.activeSourceMode, message: `Disconnected ${targetIds.length} connection(s)` });
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
  if (body.returningMinAvgSec !== undefined) {
    allowed.returningMinAvgSec = Math.max(0, parseInt(body.returningMinAvgSec, 10) || 0);
  }
  if (typeof body.returningExcludeBots === 'boolean') {
    allowed.returningExcludeBots = body.returningExcludeBots;
  }
  if (typeof body.requireDashboardAuth === 'boolean') {
    allowed.requireDashboardAuth = body.requireDashboardAuth;
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

// Built-in 10-year self-signed TLS certificate & key fallback so HTTPS (port 3443)
// works out-of-the-box inside slim Docker containers even without /usr/bin/openssl installed.
const BUILTIN_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDnzCCAoegAwIBAgIUf5hH1lpr4uzD9aHYpjODs256zqEwDQYJKoZIhvcNAQEL
BQAwXzELMAkGA1UEBhMCUk8xEDAOBgNVBAgMB1ByYWhvdmExETAPBgNVBAcMCFBs
b2llc3RpMREwDwYDVQQKDAhPWk9ORS5GTTEYMBYGA1UEAwwPb3pvbmVjYXN0Lmxv
Y2FsMB4XDTI2MTEwNzE4MjkxMVoXDTM2MTEwNDE4MjkxMVowXzELMAkGA1UEBhMC
Uk8xEDAOBgNVBAgMB1ByYWhvdmExETAPBgNVBAcMCFBsb2llc3RpMREwDwYDVQQK
DAhPWk9ORS5GTTEYMBYGA1UEAwwPb3pvbmVjYXN0LmxvY2FsMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjEuZPDBM5O8K4jIVdxPbbDEp8PpdVQjcQGVa
KYAncEl6YqLqdF0e42rE1HA6BxoFnSgj+tVUv2kE3VA+czIPIkzrtXZx/9Bd9auW
wgUWtKCicdl0ybKrzbRfblwtPmwN37BowUBxC5QQjTtAiqH/lP2apIrj4QjK8FnN
W8w7OHJ/dTA3WPvz6JcTLwaPG2/eeCDhNYbFkSeFLBdBFMrV67hJfJWsJIT5g5Q8
RKs+X/2MDvQpp7NmALg2kfRLCMgi3pJU3KOqENCLV3ABSCeb/RfVKw3P4fHfmuoM
z6CfPQ8kX/tOtkYZzOfCeklzpdXB8XJKBuc5FitXdX5jgkxvOwIDAQABo1MwUTAd
BgNVHQ4EFgQUwTsnjr/iS8Q8e9Qpb784Oxv5tOEwHwYDVR0jBBgwFoAUwTsnjr/i
S8Q8e9Qpb784Oxv5tOEwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAS/rinptksg+dLjRLnoIUQR3byL4Bz+qM1/NKrPmzay9mN65WShhjTaBOwQ6c
w9ZKgF7GbcjQ/nxk97Ey4uNxnZ/WmLzv2J83eEnbjTdLfjF7YO8A8kj6xJgl+1uF
RzQMe+JtYfOBLJW2xvvSfpGXzsVL3yauHeANxxMFX2wJQPqIgltbQbSAoWv9STbX
cqpzb3WLo7jE0uAwa37BlcTaHXwW2XLsj0N2dQsqVZgO/omdM5D+tBC4cDNsAY+B
k+vEI8bfoBxQGGZDOxGGROWFFIFCBcIcn2DtjDcPbl/XwHTbsZQw6BMkYNi2VsmA
yv5sANoCaYYWUicVbHycBdHAFw==
-----END CERTIFICATE-----`;

const BUILTIN_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCMS5k8MEzk7wri
MhV3E9tsMSnw+l1VCNxAZVopgCdwSXpioup0XR7jasTUcDoHGgWdKCP61VS/aQTd
UD5zMg8iTOu1dnH/0F31q5bCBRa0oKJx2XTJsqvNtF9uXC0+bA3fsGjBQHELlBCN
O0CKof+U/ZqkiuPhCMrwWc1bzDs4cn91MDdY+/PolxMvBo8bb954IOE1hsWRJ4Us
F0EUytXruEl8lawkhPmDlDxEqz5f/YwO9Cmns2YAuDaR9EsIyCLeklTco6oQ0ItX
cAFIJ5v9F9UrDc/h8d+a6gzPoJ89DyRf+062RhnM58J6SXOl1cHxckoG5zkWK1d1
fmOCTG87AgMBAAECggEADI0iNz4eUFL0dyUXl4YkGMtTNGxprNcJ7AxFOIuZu6l5
31jc6dkqOhqjY7AV+OxX4+X4m2hk2GpbADkSxTfiyQ+hp3k3x1+gWv9lZuk79/VG
YzIbCS/IwAgANlLdIgWvvhCTEUr5x26RMS7Ds5i8/AWDmsSUO4iPrgNoDxY37BuW
+Pb9SChXcvec0DT9zhgFGcRGdnF0blvKffc/kgEbCd14l4OoKZuwEpS3bd2BB83k
s7F9p2sfJ7EThalO0qMXHaWTpVo0TrhRyTuHf8vcUmeT/Jnr5KtCAPt5OUtidZRD
qHz2nf27/jbkVVvnAxc0CTBdlJGyPSgVqhYTClXWrQKBgQDEUIYgqiUojRaZPdXp
qQm94gWx8i2fwLxsMhLwmkMQNe45tEhke3heVJ90yCwqQUAKSzNjXLMWCWUCdO7i
Vdrb6/H9LemW3aOxMiJhFM9XrDe3EQ12F9VYZ7QiM4yPjPb7et3/Z4pdox1qSqod
kgmhJLfapFoS58nN7viEbwVYlQKBgQC28wHiCMN/iemNX124TEvr3bQStn80enHT
/kzBiegJ7TfjmMHX8/sAmXcccUkNCIbVgWCzvYt38nuiBeqlBV2Dz2HinLVFvhEr
fmlmRoLtWcPfbHKBoKPd5VUY0mlYP8U0kihq0vqNJfmXpycLbfGOS5JmQyr30XBP
aR7UcK8kjwKBgBaDlZ5RZQmNhLX2XX36oN9h+H075PeZRwKxi3KEfoRxauy7PEIp
1tgapF7kRgxih1Gm5jHTA8bXNPpfJrZWWk82c/4xMcTXjlpYAZFYrZ7EZW9dSUnt
2c3VttblSo18ASc+JA+SdE/g0RLLlU7m3KvaZitxBdN9OaugaGfnw5kxAoGAKSFt
FPI/cZcB6QS9v0d38ik/6M0awCOfH7gWbZShlEm+vO6E9hYmIjZebwiREdsO5UVX
BlHg3zCm1wBZhow0QAQJz7bHkkxu88ZRz+qeWNpLjRmGjNoevS5n+VKk2HBN18nc
SFfyeHVHLe8oegtXuVQIL/F94YU2qMPLaJuE5MUCgYABY5Q14+X+PBA45ageRBp5
6G4YBxNt9MdHufGYBN53MvlimpIgacFJTERm09rQCAQhewbECWAh9squYvnnSh1J
7WxHiymL78YghXBSi86j8rs6YI6rEJQad9FVr3t3z67zvSLWX+t17ccl3E2TBwVH
rzoJmLcBNELSgBqJT2NMFg==
-----END PRIVATE KEY-----`;

function ensureTlsCertificates() {
  const dataDir = path.join(__dirname, 'data');
  const certPath = process.env.TLS_CERT_PATH || path.join(dataDir, 'tls-cert.pem');
  const keyPath = process.env.TLS_KEY_PATH || path.join(dataDir, 'tls-key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    } catch (_) {}
  }

  try {
    fs.writeFileSync(certPath, BUILTIN_TLS_CERT, 'utf8');
    fs.writeFileSync(keyPath, BUILTIN_TLS_KEY, 'utf8');
  } catch (_) {}

  return {
    key: BUILTIN_TLS_KEY,
    cert: BUILTIN_TLS_CERT,
  };
}

// Graceful shutdown handlers so Synology Container Manager does not log exit 143 as an unexpected crash
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});
process.on('uncaughtException', err => {
  console.error('Uncaught exception (kept alive):', err);
});
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection (kept alive):', err);
});

// Start HTTP + HTTPS servers immediately so container ports & healthcheck are ready without waiting on external poll
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OzoneCast Telemetry Server (HTTP)  running on http://0.0.0.0:${PORT}`);
});

try {
  const tlsCreds = ensureTlsCertificates();
  https.createServer(tlsCreds, app).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`OzoneCast Telemetry Server (HTTPS) running on https://0.0.0.0:${HTTPS_PORT}`);
  });
} catch (err) {
  console.error('HTTPS server error:', err.message);
}

executePollCycle()
  .catch(err => console.error('Initial poll failed:', err.message))
  .finally(() => {
    schedulePoller();
  });
