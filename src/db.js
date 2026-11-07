const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'ozonecast.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    mount TEXT NOT NULL,
    listener_count INTEGER NOT NULL,
    unique_ips INTEGER NOT NULL,
    peak_reported INTEGER DEFAULT 0,
    current_track TEXT DEFAULT '',
    bitrate INTEGER DEFAULT 128,
    source_mode TEXT DEFAULT 'live'
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);

  CREATE TABLE IF NOT EXISTS listener_sessions (
    session_key TEXT PRIMARY KEY,
    client_id TEXT,
    ip TEXT NOT NULL,
    mount TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    player TEXT NOT NULL,
    category TEXT NOT NULL,
    os TEXT NOT NULL,
    country_code TEXT NOT NULL,
    country_name TEXT NOT NULL,
    city TEXT NOT NULL,
    lat REAL DEFAULT 0,
    lon REAL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    source_mode TEXT DEFAULT 'live'
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_ip ON listener_sessions(ip);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON listener_sessions(last_seen);
  CREATE INDEX IF NOT EXISTS idx_sessions_active ON listener_sessions(is_active);

  CREATE TABLE IF NOT EXISTS events_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    ip TEXT DEFAULT '',
    country_code TEXT DEFAULT '',
    city TEXT DEFAULT '',
    player TEXT DEFAULT '',
    duration_seconds INTEGER DEFAULT 0,
    details TEXT DEFAULT '',
    mount TEXT DEFAULT '/listen'
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events_log(ts DESC);
`);

const DEFAULT_CONFIG = {
  baseUrl: process.env.ICECAST_URL || 'https://live.ozone.fm:8443',
  mount: process.env.ICECAST_MOUNT || '/listen',
  username: process.env.ICECAST_USER || 'admin',
  password: process.env.ICECAST_PASS || 'Wo10vn57zomq?',
  pollIntervalSec: parseInt(process.env.POLL_INTERVAL_SEC || '10', 10) || 10,
  ignoreTlsErrors: process.env.IGNORE_TLS_ERRORS !== 'false',
  sourceMode: process.env.SOURCE_MODE || 'auto', // 'auto' | 'live' | 'simulation'
  stationName: process.env.STATION_NAME || 'OZONE.FM',
  maxListenersCapacity: parseInt(process.env.MAX_LISTENERS || '500', 10) || 500,
};

function getConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const cfg = { ...DEFAULT_CONFIG };
  for (const r of rows) {
    try {
      cfg[r.key] = JSON.parse(r.value);
    } catch (_) {
      cfg[r.key] = r.value;
    }
  }
  return cfg;
}

function updateConfig(partial) {
  const upsert = db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const current = getConfig();
  const next = { ...current, ...partial };
  for (const [k, v] of Object.entries(partial)) {
    if (k in DEFAULT_CONFIG) {
      upsert.run(k, JSON.stringify(v));
    }
  }
  return next;
}

const insertSnapshotStmt = db.prepare(`
  INSERT INTO snapshots (ts, mount, listener_count, unique_ips, peak_reported, current_track, bitrate, source_mode)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertEventStmt = db.prepare(`
  INSERT INTO events_log (ts, event_type, ip, country_code, city, player, duration_seconds, details, mount)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Clean up any stale rows where Role ('anonymous') was previously stored as user_agent
try {
  db.exec(`DELETE FROM listener_sessions WHERE LOWER(user_agent) = 'anonymous' OR LOWER(player) = 'anonymous';`);
  db.exec(`DELETE FROM events_log WHERE LOWER(player) = 'anonymous';`);
} catch (_) {}

const upsertSessionStmt = db.prepare(`
  INSERT INTO listener_sessions (
    session_key, client_id, ip, mount, user_agent, player, category, os,
    country_code, country_name, city, lat, lon,
    first_seen, last_seen, duration_seconds, is_active, source_mode
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(session_key) DO UPDATE SET
    client_id = excluded.client_id,
    user_agent = excluded.user_agent,
    player = excluded.player,
    category = excluded.category,
    os = excluded.os,
    first_seen = MIN(listener_sessions.first_seen, excluded.first_seen),
    last_seen = excluded.last_seen,
    duration_seconds = MAX(listener_sessions.duration_seconds, excluded.duration_seconds),
    is_active = 1
`);

function recordPollResult({
  mount,
  enrichedListeners,
  reportedPeak,
  currentTrack,
  bitrate,
  sourceMode,
  lastTrack,
}) {
  const now = Date.now();
  const uniqueIps = new Set(enrichedListeners.map(l => l.ip)).size;

  insertSnapshotStmt.run(
    now,
    mount,
    enrichedListeners.length,
    uniqueIps,
    reportedPeak || enrichedListeners.length,
    currentTrack || '',
    bitrate || 128,
    sourceMode
  );

  if (currentTrack && lastTrack && currentTrack !== lastTrack) {
    insertEventStmt.run(
      now,
      'track',
      '',
      '',
      '',
      '',
      0,
      `Now Playing: ${currentTrack}`,
      mount
    );
  }

  const prevActiveRows = db
    .prepare('SELECT session_key, ip, country_code, city, player, duration_seconds FROM listener_sessions WHERE is_active = 1 AND source_mode = ?')
    .all(sourceMode);
  const prevMap = new Map(prevActiveRows.map(r => [r.session_key, r]));
  const currentKeys = new Set();

  for (const client of enrichedListeners) {
    const approxStartSec = Math.floor((now / 1000 - client.connectedSeconds) / 60);
    const sessionKey = `${sourceMode}:${client.ip}:${client.clientId || approxStartSec}`;
    currentKeys.add(sessionKey);

    const firstSeen = now - client.connectedSeconds * 1000;
    upsertSessionStmt.run(
      sessionKey,
      String(client.clientId),
      client.ip,
      mount,
      client.userAgent,
      client.ua.player,
      client.ua.category,
      client.ua.os,
      client.geo.countryCode,
      client.geo.countryName,
      client.geo.city,
      client.geo.lat,
      client.geo.lon,
      firstSeen,
      now,
      client.connectedSeconds,
      sourceMode
    );

    if (!prevMap.has(sessionKey) && prevActiveRows.length > 0) {
      insertEventStmt.run(
        now,
        'join',
        client.ip,
        client.geo.countryCode,
        client.geo.city,
        client.ua.player,
        client.connectedSeconds,
        `Connected on ${mount}`,
        mount
      );
    }
  }

  const markInactiveStmt = db.prepare('UPDATE listener_sessions SET is_active = 0, last_seen = ? WHERE session_key = ?');
  for (const [key, prev] of prevMap.entries()) {
    if (!currentKeys.has(key)) {
      markInactiveStmt.run(now, key);
      insertEventStmt.run(
        now,
        'leave',
        prev.ip,
        prev.country_code,
        prev.city,
        prev.player,
        prev.duration_seconds,
        `Disconnected after ${formatDurationShort(prev.duration_seconds)}`,
        mount
      );
    }
  }

  if (Math.random() < 0.05) {
    const fourteenDaysAgo = now - 14 * 24 * 3600 * 1000;
    db.prepare('DELETE FROM snapshots WHERE ts < ?').run(fourteenDaysAgo);
    db.prepare('DELETE FROM events_log WHERE id NOT IN (SELECT id FROM events_log ORDER BY ts DESC LIMIT 500)').run();
  }
}

function formatDurationShort(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

function getHistoricalSeries(rangeMinutes = 60, sourceMode = null) {
  const since = Date.now() - rangeMinutes * 60 * 1000;
  let rows;
  if (sourceMode) {
    rows = db
      .prepare('SELECT ts, listener_count, unique_ips, peak_reported, current_track FROM snapshots WHERE ts >= ? AND source_mode = ? ORDER BY ts ASC')
      .all(since, sourceMode);
  } else {
    rows = db
      .prepare('SELECT ts, listener_count, unique_ips, peak_reported, current_track FROM snapshots WHERE ts >= ? ORDER BY ts ASC')
      .all(since);
  }

  if (rows.length <= 180) return rows;
  const step = Math.ceil(rows.length / 180);
  const sampled = [];
  for (let i = 0; i < rows.length; i += step) {
    const slice = rows.slice(i, i + step);
    const maxListeners = Math.max(...slice.map(r => r.listener_count));
    const avgListeners = Math.round(slice.reduce((a, b) => a + b.listener_count, 0) / slice.length);
    const last = slice[slice.length - 1];
    sampled.push({
      ts: last.ts,
      listener_count: avgListeners,
      max_in_bucket: maxListeners,
      unique_ips: last.unique_ips,
      peak_reported: last.peak_reported,
      current_track: last.current_track,
    });
  }
  return sampled;
}

/**
 * Computes 24-Hour Time-of-Day Listener Profile (00:00 to 23:00)
 * so the station owner can see when listeners usually tune in across the day,
 * plus daypart averages (Morning Drive, Midday Work, Evening Prime, Late Night).
 */
function getTimeOfDayProfile(sourceMode = 'live') {
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const rows = db
    .prepare('SELECT ts, listener_count, unique_ips FROM snapshots WHERE ts >= ? AND source_mode = ?')
    .all(sevenDaysAgo, sourceMode);

  const buckets = Array.from({ length: 24 }, (_, hour) => {
    let daypart = 'Late Night';
    if (hour >= 6 && hour < 11) daypart = 'Morning Drive';
    else if (hour >= 11 && hour < 17) daypart = 'Midday / Work';
    else if (hour >= 17 && hour < 23) daypart = 'Evening Prime';

    return {
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      daypart,
      sumListeners: 0,
      maxListeners: 0,
      samples: 0,
    };
  });

  for (const r of rows) {
    const d = new Date(r.ts);
    const h = d.getHours();
    const b = buckets[h];
    if (b) {
      b.sumListeners += r.listener_count || 0;
      if ((r.listener_count || 0) > b.maxListeners) {
        b.maxListeners = r.listener_count;
      }
      b.samples++;
    }
  }

  const hourly = buckets.map(b => ({
    hour: b.hour,
    label: b.label,
    daypart: b.daypart,
    avgListeners: b.samples > 0 ? Math.round(b.sumListeners / b.samples) : 0,
    peakListeners: b.maxListeners,
    samples: b.samples,
  }));

  // Compute daypart summaries
  const dayparts = [
    { id: 'morning', name: 'Morning Drive', hours: '06:00 – 11:00', filter: h => h >= 6 && h < 11 },
    { id: 'midday', name: 'Midday / Workday', hours: '11:00 – 17:00', filter: h => h >= 11 && h < 17 },
    { id: 'evening', name: 'Evening Prime Time', hours: '17:00 – 23:00', filter: h => h >= 17 && h < 23 },
    { id: 'night', name: 'Late Night / Overnight', hours: '23:00 – 06:00', filter: h => h >= 23 || h < 6 },
  ].map(dp => {
    const matching = hourly.filter(h => dp.filter(h.hour) && h.samples > 0);
    const avg = matching.length > 0
      ? Math.round(matching.reduce((s, x) => s + x.avgListeners, 0) / matching.length)
      : 0;
    const peak = matching.length > 0
      ? Math.max(...matching.map(x => x.peakListeners))
      : 0;
    return {
      id: dp.id,
      name: dp.name,
      hours: dp.hours,
      avgListeners: avg,
      peakListeners: peak,
    };
  });

  const bestHour = [...hourly].sort((a, b) => b.avgListeners - a.avgListeners || b.peakListeners - a.peakListeners)[0] || hourly[20];
  const bestDaypart = [...dayparts].sort((a, b) => b.avgListeners - a.avgListeners)[0] || dayparts[2];

  return {
    hourly,
    dayparts,
    bestHourLabel: bestHour ? `${bestHour.label} – ${String((bestHour.hour + 1) % 24).padStart(2, '0')}:00` : '20:00 – 21:00',
    bestHourAvg: bestHour?.avgListeners || 0,
    bestHourPeak: bestHour?.peakListeners || 0,
    bestDaypartName: bestDaypart?.name || 'Evening Prime Time',
  };
}

/**
 * Returns the Top N Returning Listeners ranked by distinct session visits & cumulative connected time.
 */
function getTopReturningListeners(limit = 5, sourceMode = 'live') {
  const rows = db
    .prepare(`
      SELECT
        ip,
        COUNT(*) as session_count,
        SUM(duration_seconds) as total_duration_seconds,
        ROUND(AVG(duration_seconds)) as avg_duration_seconds,
        MAX(duration_seconds) as longest_session_seconds,
        MIN(first_seen) as first_seen,
        MAX(last_seen) as last_seen,
        MAX(is_active) as is_active,
        MAX(player) as player,
        MAX(category) as category,
        MAX(os) as os,
        MAX(city) as city,
        MAX(country_code) as country_code,
        MAX(country_name) as country_name
      FROM listener_sessions
      WHERE source_mode = ?
      GROUP BY ip
      ORDER BY session_count DESC, total_duration_seconds DESC
      LIMIT ?
    `)
    .all(sourceMode, limit);

  return rows.map((r, idx) => ({
    rank: idx + 1,
    ip: r.ip,
    sessionCount: Number(r.session_count) || 1,
    totalDurationSeconds: Number(r.total_duration_seconds) || 0,
    avgDurationSeconds: Number(r.avg_duration_seconds) || 0,
    longestSessionSeconds: Number(r.longest_session_seconds) || 0,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    isActive: Number(r.is_active) === 1,
    player: r.player || 'Audio Client',
    category: r.category || 'Client',
    os: r.os || 'Unknown',
    city: r.city || 'Unknown',
    countryCode: r.country_code || 'RO',
    countryName: r.country_name || 'Romania',
  }));
}

function getAggregatedStats(sourceMode = 'live') {
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;

  const peak24hRow = db
    .prepare('SELECT listener_count, ts, peak_reported FROM snapshots WHERE ts >= ? AND source_mode = ? ORDER BY listener_count DESC LIMIT 1')
    .get(dayAgo, sourceMode);

  const allTimePeakRow = db
    .prepare('SELECT MAX( MAX(listener_count), MAX(peak_reported) ) as peak, ts FROM snapshots WHERE source_mode = ?')
    .get(sourceMode);

  const sessionStats24h = db
    .prepare(`
      SELECT
        COUNT(*) as total_sessions,
        COUNT(DISTINCT ip) as unique_ips_24h,
        COUNT(DISTINCT country_code) as unique_countries_24h,
        AVG(duration_seconds) as avg_duration_sec,
        SUM(duration_seconds) as total_listening_sec
      FROM listener_sessions
      WHERE last_seen >= ? AND source_mode = ?
    `)
    .get(dayAgo, sourceMode);

  const returningCountRow = db
    .prepare(`
      SELECT COUNT(*) as returning_ips
      FROM (
        SELECT ip FROM listener_sessions WHERE source_mode = ? GROUP BY ip HAVING COUNT(*) > 1
      )
    `)
    .get(sourceMode);

  const recentEvents = db
    .prepare('SELECT * FROM events_log ORDER BY ts DESC LIMIT 60')
    .all();

  return {
    peak24h: peak24hRow ? Math.max(peak24hRow.listener_count, peak24hRow.peak_reported || 0) : 0,
    peak24hTs: peak24hRow ? peak24hRow.ts : now,
    allTimePeak: allTimePeakRow?.peak || 0,
    totalSessions24h: sessionStats24h?.total_sessions || 0,
    uniqueIps24h: sessionStats24h?.unique_ips_24h || 0,
    uniqueCountries24h: sessionStats24h?.unique_countries_24h || 0,
    avgDuration24hSec: Math.round(sessionStats24h?.avg_duration_sec || 0),
    totalListeningHours24h: Number(((sessionStats24h?.total_listening_sec || 0) / 3600).toFixed(2)),
    returningListenerCount: returningCountRow?.returning_ips || 0,
    recentEvents,
  };
}

function getIpHistory(ip) {
  const sessions = db
    .prepare('SELECT * FROM listener_sessions WHERE ip = ? ORDER BY last_seen DESC LIMIT 50')
    .all(ip);
  const summary = db
    .prepare(`
      SELECT
        COUNT(*) as session_count,
        SUM(duration_seconds) as total_seconds,
        MAX(duration_seconds) as longest_session,
        MIN(first_seen) as first_ever_seen,
        MAX(last_seen) as last_ever_seen
      FROM listener_sessions
      WHERE ip = ?
    `)
    .get(ip);
  return { ip, summary, sessions };
}

function logCustomEvent(type, details, ip = '', mount = '/listen') {
  insertEventStmt.run(Date.now(), type, ip, '', '', '', 0, details, mount);
}

module.exports = {
  db,
  getConfig,
  updateConfig,
  recordPollResult,
  getHistoricalSeries,
  getTimeOfDayProfile,
  getTopReturningListeners,
  getAggregatedStats,
  getIpHistory,
  logCustomEvent,
};
