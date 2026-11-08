const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { parseUserAgent, deduplicateListenersByDevice } = require('./parser');

function openDatabaseWithFallback() {
  const primaryDir = path.join(__dirname, '..', 'data');
  const fallbackDir = '/tmp/ozonecast-data';

  for (const dir of [primaryDir, fallbackDir]) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const dbPath = path.join(dir, 'ozonecast.sqlite');
      const instance = new DatabaseSync(dbPath);
      try {
        instance.exec('PRAGMA journal_mode = WAL;');
      } catch (_) {
        instance.exec('PRAGMA journal_mode = DELETE;');
      }
      instance.exec('PRAGMA synchronous = NORMAL;');
      console.log(`SQLite initialized at ${dbPath}`);
      return instance;
    } catch (err) {
      console.warn(`Could not open SQLite in ${dir}: ${err.message}`);
    }
  }
  return new DatabaseSync(':memory:');
}

const db = openDatabaseWithFallback();

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
    source_mode TEXT DEFAULT 'live',
    human_count INTEGER DEFAULT NULL,
    human_unique_ips INTEGER DEFAULT NULL
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

  CREATE TABLE IF NOT EXISTS ip_aliases (
    ip TEXT PRIMARY KEY,
    friendly_name TEXT NOT NULL,
    notes TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bot_ips (
    ip TEXT PRIMARY KEY,
    reason TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ip_geo_cache (
    ip TEXT PRIMARY KEY,
    country_code TEXT NOT NULL,
    country_name TEXT NOT NULL,
    region TEXT DEFAULT '',
    city TEXT DEFAULT '',
    has_city INTEGER DEFAULT 0,
    lat REAL DEFAULT 0,
    lon REAL DEFAULT 0,
    timezone TEXT DEFAULT 'UTC',
    isp TEXT DEFAULT '',
    as_org TEXT DEFAULT '',
    source TEXT DEFAULT 'ip-api',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_geo_cache_ip ON ip_geo_cache(ip);
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
  returningMinAvgSec: parseInt(process.env.RETURNING_MIN_AVG_SEC || '60', 10) >= 0
    ? parseInt(process.env.RETURNING_MIN_AVG_SEC || '60', 10)
    : 60,
  returningExcludeBots: process.env.RETURNING_EXCLUDE_BOTS !== 'false',
  requireDashboardAuth: process.env.REQUIRE_DASHBOARD_AUTH !== 'false',
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

// Ensure human_count and human_unique_ips columns exist on existing databases
try {
  db.exec('ALTER TABLE snapshots ADD COLUMN human_count INTEGER DEFAULT NULL;');
} catch (_) {}
try {
  db.exec('ALTER TABLE snapshots ADD COLUMN human_unique_ips INTEGER DEFAULT NULL;');
} catch (_) {}
try {
  db.exec('UPDATE snapshots SET human_count = listener_count, human_unique_ips = unique_ips WHERE human_count IS NULL;');
} catch (_) {}
try {
  db.exec("ALTER TABLE listener_sessions ADD COLUMN last_track TEXT DEFAULT '';");
} catch (_) {}
try {
  db.exec("ALTER TABLE listener_sessions ADD COLUMN last_track_progress_sec INTEGER DEFAULT 0;");
} catch (_) {}

const insertSnapshotStmt = db.prepare(`
  INSERT INTO snapshots (ts, mount, listener_count, unique_ips, peak_reported, current_track, bitrate, source_mode, human_count, human_unique_ips)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertEventStmt = db.prepare(`
  INSERT INTO events_log (ts, event_type, ip, country_code, city, player, duration_seconds, details, mount)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Clean up any stale rows where Role ('anonymous') was previously stored as user_agent,
// and ensure any historical bot/crawler sessions are tagged as 'Bot / Ripper'.
try {
  db.exec(`DELETE FROM listener_sessions WHERE LOWER(user_agent) = 'anonymous' OR LOWER(player) = 'anonymous';`);
  db.exec(`DELETE FROM events_log WHERE LOWER(player) = 'anonymous';`);
  db.exec(`
    UPDATE listener_sessions
    SET category = 'Bot / Ripper'
    WHERE LOWER(user_agent) LIKE '%bot%'
       OR LOWER(user_agent) LIKE '%onlineradiobox%'
       OR LOWER(user_agent) LIKE '%crawler%'
       OR LOWER(user_agent) LIKE '%spider%'
       OR LOWER(user_agent) LIKE '%streamripper%';
  `);
} catch (_) {}

try {
  db.exec(`
    UPDATE listener_sessions
    SET last_track = CASE (ABS(RANDOM()) % 6)
      WHEN 0 THEN 'Peggy Gou - (It Goes Like) Nanana'
      WHEN 1 THEN 'Fred again.. & Swedish House Mafia - Turn On The Lights again..'
      WHEN 2 THEN 'RÜFÜS DU SOL - On My Knees (Live Broadcast Mix)'
      WHEN 3 THEN 'Bonobo & Jacques Greene - Fold'
      WHEN 4 THEN 'Disclosure - Higher Than Ever Before'
      ELSE 'Bicep - Apricots (Ozone.FM Club Edit)'
    END,
    last_track_progress_sec = CASE (ABS(RANDOM()) % 5)
      WHEN 0 THEN 18 + (ABS(RANDOM()) % 12)  -- 18-30s (Intro skip)
      WHEN 1 THEN 45 + (ABS(RANDOM()) % 40)  -- 45-85s (Early mid)
      WHEN 2 THEN 80 + (ABS(RANDOM()) % 40)  -- 80-120s (Mid)
      WHEN 3 THEN 130 + (ABS(RANDOM()) % 45) -- 130-175s (Late)
      ELSE 180 + (ABS(RANDOM()) % 60)        -- 180-240s (Outro)
    END
    WHERE source_mode = 'simulation';
  `);
} catch (_) {}


const upsertSessionStmt = db.prepare(`
  INSERT INTO listener_sessions (
    session_key, client_id, ip, mount, user_agent, player, category, os,
    country_code, country_name, city, lat, lon,
    first_seen, last_seen, duration_seconds, is_active, source_mode, last_track, last_track_progress_sec
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT(session_key) DO UPDATE SET
    client_id = excluded.client_id,
    user_agent = excluded.user_agent,
    player = excluded.player,
    category = excluded.category,
    os = excluded.os,
    first_seen = MIN(listener_sessions.first_seen, excluded.first_seen),
    last_seen = excluded.last_seen,
    duration_seconds = MAX(listener_sessions.duration_seconds, excluded.duration_seconds),
    is_active = 1,
    last_track = CASE WHEN excluded.last_track != '' THEN excluded.last_track ELSE listener_sessions.last_track END,
    last_track_progress_sec = excluded.last_track_progress_sec
`);

function recordPollResult({
  mount,
  enrichedListeners,
  reportedPeak,
  currentTrack,
  trackProgressSec = 0,
  bitrate,
  sourceMode,
  lastTrack,
}) {
  const now = Date.now();
  const uniqueIps = new Set(enrichedListeners.map(l => l.ip)).size;
  const humanListeners = enrichedListeners.filter(l => !l.isBot);

  // Deduplicate listeners by (IP + Player / User-Agent):
  // Same IP and player/agent count as 1 listener, unless separate players/agents.
  const deduplicatedListeners = deduplicateListenersByDevice(enrichedListeners);
  const deduplicatedHumanListeners = deduplicateListenersByDevice(humanListeners);

  const listenerCount = deduplicatedListeners.length;
  const humanCount = deduplicatedHumanListeners.length;
  const humanUniqueIps = new Set(humanListeners.map(l => l.ip)).size;

  insertSnapshotStmt.run(
    now,
    mount,
    listenerCount,
    uniqueIps,
    reportedPeak || listenerCount,
    currentTrack || '',
    bitrate || 128,
    sourceMode,
    humanCount,
    humanUniqueIps
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
      sourceMode,
      currentTrack || '',
      trackProgressSec || 0
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

  const markInactiveStmt = db.prepare(`
    UPDATE listener_sessions
    SET is_active = 0,
        last_seen = ?,
        last_track = CASE WHEN ? != '' THEN ? ELSE last_track END,
        last_track_progress_sec = CASE WHEN ? > 0 THEN ? ELSE last_track_progress_sec END
    WHERE session_key = ?
  `);
  for (const [key, prev] of prevMap.entries()) {
    if (!currentKeys.has(key)) {
      const exitTrack = currentTrack || lastTrack || '';
      markInactiveStmt.run(now, exitTrack, exitTrack, trackProgressSec || 0, trackProgressSec || 0, key);
      const progressLabel = trackProgressSec > 0 ? ` at ${formatDurationClock(trackProgressSec)}` : '';
      insertEventStmt.run(
        now,
        'leave',
        prev.ip,
        prev.country_code,
        prev.city,
        prev.player,
        prev.duration_seconds,
        `Disconnected after ${formatDurationShort(prev.duration_seconds)}${exitTrack ? ` (Track: ${exitTrack}${progressLabel})` : ''}`,
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

function formatDurationClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
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

function getHistoricalSeries(rangeMinutes = 60, sourceMode = null, excludeBots = false) {
  const since = Date.now() - rangeMinutes * 60 * 1000;
  const countCol = excludeBots ? 'COALESCE(human_count, listener_count)' : 'listener_count';
  const ipCol = excludeBots ? 'COALESCE(human_unique_ips, unique_ips)' : 'unique_ips';

  let rows;
  if (sourceMode) {
    rows = db
      .prepare(`SELECT ts, ${countCol} as listener_count, ${ipCol} as unique_ips, peak_reported, current_track FROM snapshots WHERE ts >= ? AND source_mode = ? ORDER BY ts ASC`)
      .all(since, sourceMode);
  } else {
    rows = db
      .prepare(`SELECT ts, ${countCol} as listener_count, ${ipCol} as unique_ips, peak_reported, current_track FROM snapshots WHERE ts >= ? ORDER BY ts ASC`)
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
 * Retrieves track change events within the requested historical window (rangeMinutes).
 * Combines event_log ('track' events) and snapshots transitions where current_track changed.
 */
function getHistoricalTrackChanges(rangeMinutes = 60, sourceMode = null) {
  const since = Date.now() - rangeMinutes * 60 * 1000;

  // 1. Query track change events from events_log
  const eventRows = db
    .prepare("SELECT ts, details FROM events_log WHERE event_type = 'track' AND ts >= ? ORDER BY ts ASC")
    .all(since);

  // 2. Query snapshots for track transitions
  let snapRows;
  if (sourceMode) {
    snapRows = db
      .prepare("SELECT ts, current_track, listener_count FROM snapshots WHERE ts >= ? AND source_mode = ? AND current_track IS NOT NULL AND current_track != '' ORDER BY ts ASC")
      .all(since, sourceMode);
  } else {
    snapRows = db
      .prepare("SELECT ts, current_track, listener_count FROM snapshots WHERE ts >= ? AND current_track IS NOT NULL AND current_track != '' ORDER BY ts ASC")
      .all(since);
  }

  const transitions = [];
  let lastTrack = '';
  for (const s of snapRows) {
    if (s.current_track && s.current_track !== lastTrack) {
      lastTrack = s.current_track;
      transitions.push({
        ts: s.ts,
        track: s.current_track,
        listener_count: s.listener_count || 0,
      });
    }
  }

  // Merge events_log if any event occurred that wasn't in snapshots
  for (const ev of eventRows) {
    const track = (ev.details || '').replace(/^Now Playing:\s*/i, '').trim();
    if (!track) continue;
    const existing = transitions.find(t => t.track === track && Math.abs(t.ts - ev.ts) < 45000);
    if (!existing) {
      transitions.push({
        ts: ev.ts,
        track,
        listener_count: 0,
      });
    }
  }

  transitions.sort((a, b) => a.ts - b.ts);
  return transitions;
}

/**
 * Computes 24-Hour Time-of-Day Listener Profile (00:00 to 23:00)
 * so the station owner can see when listeners usually tune in across the day,
 * plus daypart averages (Morning Drive, Midday Work, Evening Prime, Late Night).
 */
/**
 * Computes 24-Hour Time-of-Day Listener Profile (00:00 to 23:00)
 * so the station owner can see when listeners usually tune in across the day,
 * per day of the week (All Days, Weekdays, Weekend, Mon–Sun),
 * plus daypart averages (Morning Drive, Midday Work, Evening Prime, Late Night).
 */
function getTimeOfDayProfile(sourceMode = 'live', excludeBots = false, dayFilter = 'all') {
  const historyWindowMs = 14 * 24 * 3600 * 1000;
  const since = Date.now() - historyWindowMs;
  const countCol = excludeBots ? 'COALESCE(human_count, listener_count)' : 'listener_count';
  const ipCol = excludeBots ? 'COALESCE(human_unique_ips, unique_ips)' : 'unique_ips';

  let rows;
  if (sourceMode) {
    rows = db
      .prepare(`SELECT ts, ${countCol} as listener_count, ${ipCol} as unique_ips FROM snapshots WHERE ts >= ? AND source_mode = ?`)
      .all(since, sourceMode);
  } else {
    rows = db
      .prepare(`SELECT ts, ${countCol} as listener_count, ${ipCol} as unique_ips FROM snapshots WHERE ts >= ?`)
      .all(since);
  }

  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DAY_DEFS = [
    { key: 'mon', name: 'Monday', shortName: 'Mon', dayIndex: 1 },
    { key: 'tue', name: 'Tuesday', shortName: 'Tue', dayIndex: 2 },
    { key: 'wed', name: 'Wednesday', shortName: 'Wed', dayIndex: 3 },
    { key: 'thu', name: 'Thursday', shortName: 'Thu', dayIndex: 4 },
    { key: 'fri', name: 'Friday', shortName: 'Fri', dayIndex: 5 },
    { key: 'sat', name: 'Saturday', shortName: 'Sat', dayIndex: 6 },
    { key: 'sun', name: 'Sunday', shortName: 'Sun', dayIndex: 0 },
  ];

  const profileKeys = ['all', 'weekdays', 'weekend', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  function createBuckets() {
    return Array.from({ length: 24 }, (_, hour) => {
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
  }

  const bucketMap = {};
  for (const k of profileKeys) {
    bucketMap[k] = createBuckets();
  }

  for (const r of rows) {
    const d = new Date(r.ts);
    const h = d.getHours();
    const dayIdx = d.getDay();
    const dayKey = DAY_KEYS[dayIdx];
    const count = r.listener_count || 0;

    const record = (bList) => {
      const b = bList[h];
      if (b) {
        b.sumListeners += count;
        if (count > b.maxListeners) {
          b.maxListeners = count;
        }
        b.samples++;
      }
    };

    record(bucketMap.all);
    if (dayIdx >= 1 && dayIdx <= 5) {
      record(bucketMap.weekdays);
    } else {
      record(bucketMap.weekend);
    }
    if (bucketMap[dayKey]) {
      record(bucketMap[dayKey]);
    }
  }

  // Collect session duration stats per day
  const sessionDurations = {};
  for (const k of profileKeys) {
    sessionDurations[k] = [];
  }

  try {
    let sessionQuery = `
      SELECT last_seen, duration_seconds
      FROM listener_sessions
      WHERE last_seen >= ?
    `;
    const params = [since];
    if (sourceMode) {
      sessionQuery += ' AND source_mode = ?';
      params.push(sourceMode);
    }
    if (excludeBots) {
      sessionQuery += `
        AND category != 'Bot / Ripper'
        AND ip NOT IN (SELECT ip FROM bot_ips)
        AND LOWER(user_agent) NOT LIKE '%bot%'
        AND LOWER(user_agent) NOT LIKE '%onlineradiobox%'
        AND LOWER(user_agent) NOT LIKE '%crawler%'
        AND LOWER(user_agent) NOT LIKE '%spider%'
        AND LOWER(user_agent) NOT LIKE '%streamripper%'
      `;
    }
    const sRows = db.prepare(sessionQuery).all(...params);
    for (const s of sRows) {
      const dur = s.duration_seconds || 0;
      const d = new Date(s.last_seen);
      const dayIdx = d.getDay();
      const dayKey = DAY_KEYS[dayIdx];

      sessionDurations.all.push(dur);
      if (dayIdx >= 1 && dayIdx <= 5) {
        sessionDurations.weekdays.push(dur);
      } else {
        sessionDurations.weekend.push(dur);
      }
      if (sessionDurations[dayKey]) {
        sessionDurations[dayKey].push(dur);
      }
    }
  } catch (err) {
    console.warn('Error querying session durations for time-of-day profile:', err.message);
  }

  function computeDurationMetrics(durations) {
    if (!durations || durations.length === 0) {
      return {
        avgSessionDurationSec: 0,
        medianSessionDurationSec: 0,
        p90SessionDurationSec: 0,
        longestSessionSec: 0,
        sessionCount: 0,
      };
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const total = sorted.reduce((sum, v) => sum + v, 0);
    return {
      avgSessionDurationSec: Math.round(total / sorted.length),
      medianSessionDurationSec: sorted[Math.floor(sorted.length / 2)] || 0,
      p90SessionDurationSec: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] || 0,
      longestSessionSec: sorted[sorted.length - 1] || 0,
      sessionCount: sorted.length,
    };
  }

  // Build each profile
  const profiles = {};
  for (const k of profileKeys) {
    const buckets = bucketMap[k];
    const hourly = buckets.map(b => ({
      hour: b.hour,
      label: b.label,
      daypart: b.daypart,
      avgListeners: b.samples > 0 ? Math.round(b.sumListeners / b.samples) : 0,
      peakListeners: b.maxListeners,
      samples: b.samples,
    }));

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
    const totalSamples = hourly.reduce((sum, h) => sum + h.samples, 0);
    const totalSum = hourly.reduce((sum, h) => sum + (h.samples * h.avgListeners), 0);
    const overallAvg = totalSamples > 0 ? Math.round(totalSum / totalSamples) : 0;
    const overallPeak = Math.max(0, ...hourly.map(h => h.peakListeners));
    const connectedTime = computeDurationMetrics(sessionDurations[k]);

    profiles[k] = {
      hourly,
      dayparts,
      bestHourLabel: bestHour ? `${bestHour.label} – ${String((bestHour.hour + 1) % 24).padStart(2, '0')}:00` : '20:00 – 21:00',
      bestHourAvg: bestHour?.avgListeners || 0,
      bestHourPeak: bestHour?.peakListeners || 0,
      bestDaypartName: bestDaypart?.name || 'Evening Prime Time',
      overallAvg,
      overallPeak,
      totalSamples,
      connectedTime,
    };
  }

  const todayDayIndex = new Date().getDay();
  const daysOfWeek = DAY_DEFS.map(d => {
    const p = profiles[d.key];
    return {
      key: d.key,
      name: d.name,
      shortName: d.shortName,
      dayIndex: d.dayIndex,
      isToday: d.dayIndex === todayDayIndex,
      avgListeners: p.overallAvg,
      peakListeners: p.overallPeak,
      bestHourLabel: p.bestHourLabel,
      bestHourAvg: p.bestHourAvg,
      bestDaypartName: p.bestDaypartName,
      samples: p.totalSamples,
    };
  });

  const sortedDays = [...daysOfWeek].filter(d => d.samples > 0).sort((a, b) => b.avgListeners - a.avgListeners || b.peakListeners - a.peakListeners);
  const bestDay = sortedDays[0] || daysOfWeek[0];

  const selectedKey = (dayFilter && profiles[dayFilter]) ? dayFilter : 'all';
  const selectedProfile = profiles[selectedKey] || profiles.all;

  return {
    hourly: selectedProfile.hourly,
    dayparts: selectedProfile.dayparts,
    bestHourLabel: selectedProfile.bestHourLabel,
    bestHourAvg: selectedProfile.bestHourAvg,
    bestHourPeak: selectedProfile.bestHourPeak,
    bestDaypartName: selectedProfile.bestDaypartName,
    overallAvg: selectedProfile.overallAvg,
    overallPeak: selectedProfile.overallPeak,
    connectedTime: selectedProfile.connectedTime,
    activeDay: selectedKey,
    profiles,
    daysOfWeek,
    bestDayName: bestDay ? bestDay.name : 'All Days',
    bestDayKey: bestDay ? bestDay.key : 'all',
    bestDayAvg: bestDay ? bestDay.avgListeners : 0,
  };
}

/**
 * Computes comprehensive aggregated breakdowns (Countries, Cities, Players, Categories, OS, Duration cohorts)
 * from recorded listener_sessions in SQLite over a specified historical range (e.g. 1440 = 24h, 10080 = 7d, 0 = All-Time).
 */
function getHistoricalBreakdowns(rangeMinutes = 1440, sourceMode = null, excludeBots = false) {
  const since = rangeMinutes > 0 ? Date.now() - rangeMinutes * 60 * 1000 : 0;
  const excludeFlag = excludeBots ? 1 : 0;

  const query = `
    SELECT
      ip,
      country_code,
      country_name,
      city,
      lat,
      lon,
      player,
      category,
      os,
      duration_seconds,
      is_active
    FROM listener_sessions
    WHERE (last_seen >= ? OR ? = 0)
      AND (? IS NULL OR source_mode = ?)
      AND (? = 0 OR (
        category != 'Bot / Ripper'
        AND ip NOT IN (SELECT ip FROM bot_ips)
        AND LOWER(user_agent) NOT LIKE '%bot%'
        AND LOWER(user_agent) NOT LIKE '%crawler%'
        AND LOWER(user_agent) NOT LIKE '%spider%'
        AND LOWER(user_agent) NOT LIKE '%streamripper%'
        AND LOWER(user_agent) NOT LIKE '%onlineradiobox%'
        AND LOWER(user_agent) NOT LIKE '%uptime%'
        AND LOWER(user_agent) NOT LIKE '%robot%'
        AND LOWER(user_agent) NOT LIKE '%pingdom%'
        AND LOWER(user_agent) NOT LIKE '%statuscake%'
        AND LOWER(user_agent) NOT LIKE '%zabbix%'
        AND LOWER(user_agent) NOT LIKE '%prometheus%'
        AND LOWER(user_agent) NOT LIKE '%nagios%'
        AND LOWER(user_agent) NOT LIKE '%probe%'
        AND LOWER(user_agent) NOT LIKE '%monitor%'
        AND LOWER(user_agent) NOT LIKE '%radio-browser%'
        AND LOWER(user_agent) NOT LIKE '%streamcheck%'
        AND LOWER(user_agent) NOT LIKE '%curl%'
        AND LOWER(user_agent) NOT LIKE '%python%'
        AND LOWER(user_agent) NOT LIKE '%go-http%'
        AND LOWER(user_agent) NOT LIKE '%okhttp%'
        AND LOWER(user_agent) NOT LIKE '%aiohttp%'
        AND LOWER(user_agent) NOT LIKE '%node-fetch%'
        AND LOWER(user_agent) NOT LIKE '%axios%'
        AND duration_seconds >= 15
      ))
  `;

  const rows = db.prepare(query).all(since, since, sourceMode, sourceMode, excludeFlag);

  const total = rows.length || 1;
  const countryMap = new Map();
  const cityMap = new Map();
  const playerMap = new Map();
  const categoryMap = new Map();
  const osMap = new Map();
  const uniqueIpSet = new Set();
  const mapLocations = [];

  const durationBuckets = [
    { id: 'u5m', label: '< 5 min', min: 0, max: 300, count: 0 },
    { id: '5to15m', label: '5 – 15 min', min: 300, max: 900, count: 0 },
    { id: '15to30m', label: '15 – 30 min', min: 900, max: 1800, count: 0 },
    { id: '30to60m', label: '30 – 60 min', min: 1800, max: 3600, count: 0 },
    { id: '1to2h', label: '1 – 2 hrs', min: 3600, max: 7200, count: 0 },
    { id: 'over2h', label: '2+ hrs', min: 7200, max: Infinity, count: 0 },
  ];

  let totalDurationSec = 0;
  const seenMapIps = new Set();

  for (const r of rows) {
    const sec = r.duration_seconds || 0;
    totalDurationSec += sec;
    uniqueIpSet.add(r.ip);

    // Duration cohorts
    for (const b of durationBuckets) {
      if (sec >= b.min && sec < b.max) {
        b.count++;
        break;
      }
    }

    // Country aggregation
    const cc = r.country_code || 'UN';
    const cName = r.country_name || cc;
    if (!countryMap.has(cc)) {
      countryMap.set(cc, {
        countryCode: cc,
        countryName: cName,
        count: 0,
        totalDurationSec: 0,
        uniqueIps: new Set(),
      });
    }
    const cEntry = countryMap.get(cc);
    cEntry.count++;
    cEntry.totalDurationSec += sec;
    cEntry.uniqueIps.add(r.ip);

    // City aggregation
    const rawCity = (r.city || '').trim();
    const hasCity = Boolean(rawCity && rawCity !== cName && rawCity !== 'Unknown');
    const displayCity = hasCity ? rawCity : `Unresolved City (${cName})`;
    const cityKey = hasCity ? `${rawCity}::${cc}` : `unresolved::${cc}`;
    if (!cityMap.has(cityKey)) {
      cityMap.set(cityKey, {
        city: displayCity,
        hasCity,
        countryCode: cc,
        countryName: cName,
        count: 0,
        totalDurationSec: 0,
        uniqueIps: new Set(),
      });
    }
    const cityEntry = cityMap.get(cityKey);
    cityEntry.count++;
    cityEntry.totalDurationSec += sec;
    cityEntry.uniqueIps.add(r.ip);

    // Player, Category, OS
    const pName = r.player || 'Other';
    playerMap.set(pName, (playerMap.get(pName) || 0) + 1);

    const catName = r.category || 'Other';
    categoryMap.set(catName, (categoryMap.get(catName) || 0) + 1);

    const osName = r.os || 'Other';
    osMap.set(osName, (osMap.get(osName) || 0) + 1);

    // Map location pins
    if (!seenMapIps.has(r.ip) && (r.lat || r.lon)) {
      seenMapIps.add(r.ip);
      mapLocations.push({
        ip: r.ip,
        lat: r.lat,
        lon: r.lon,
        city: r.city,
        countryCode: r.country_code,
        countryName: r.country_name,
        player: r.player,
        category: r.category,
        os: r.os,
        connectedSeconds: sec,
        isBot: r.category === 'Bot / Ripper',
      });
    }
  }

  const toSortedDist = map =>
    Array.from(map.entries())
      .map(([name, count]) => ({
        name,
        count,
        sharePct: Number(((count / total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.count - a.count);

  const countries = Array.from(countryMap.values())
    .map(c => ({
      countryCode: c.countryCode,
      countryName: c.countryName,
      count: c.count,
      totalDurationSec: c.totalDurationSec,
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
      count: c.count,
      totalDurationSec: c.totalDurationSec,
      uniqueIps: c.uniqueIps ? c.uniqueIps.size : 1,
      sharePct: Number(((c.count / total) * 100).toFixed(1)),
      avgDurationSec: Math.round(c.totalDurationSec / c.count),
    }))
    .sort((a, b) => b.count - a.count);

  const sortedDurations = rows.map(r => r.duration_seconds || 0).sort((a, b) => a - b);
  const avgSessionDurationSec = rows.length > 0 ? Math.round(totalDurationSec / rows.length) : 0;
  const medianSessionDurationSec = sortedDurations.length > 0 ? sortedDurations[Math.floor(sortedDurations.length / 2)] : 0;
  const p90SessionDurationSec = sortedDurations.length > 0 ? sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * 0.9))] : 0;
  const longestSessionSec = sortedDurations.length > 0 ? sortedDurations[sortedDurations.length - 1] : 0;

  return {
    totalSessions: rows.length,
    uniqueIps: uniqueIpSet.size,
    avgSessionDurationSec,
    medianSessionDurationSec,
    p90SessionDurationSec,
    longestSessionSec,
    totalListeningHours: Number((totalDurationSec / 3600).toFixed(2)),
    countries,
    cities,
    players: toSortedDist(playerMap),
    categories: toSortedDist(categoryMap),
    platforms: toSortedDist(osMap),
    durationBuckets: durationBuckets.map(b => ({
      ...b,
      sharePct: Number(((b.count / total) * 100).toFixed(1)),
    })),
    mapLocations,
    detractorSongs: getDetractorSongs(rangeMinutes, sourceMode, excludeBots, 10),
    detractorSummary: getDetractorSummary(rangeMinutes, sourceMode, excludeBots),
  };
}

/**
 * Query Detractor Songs — songs with highest listener drop-offs.
 * Measures on UNIQUE listener IPs only (each unique listener IP counts as 1 drop-off).
 * ALWAYS excludes:
 *   1. Bots, crawlers, rippers, and bot_ips.
 *   2. Station Admin IPs marked with "Me" (friendly_name is 'Me' or begins with 'Me').
 */
function getDetractorSongs(rangeMinutes = 1440, sourceMode = null, excludeBots = true, limit = 10) {
  const now = Date.now();
  const since = rangeMinutes > 0 ? now - rangeMinutes * 60 * 1000 : 0;

  const modeFilter = sourceMode ? 'AND source_mode = ?' : '';
  const params = [];
  if (since > 0) params.push(since);
  if (sourceMode) params.push(sourceMode);
  params.push(limit);

  const sql = `
    WITH unique_ip_drops AS (
      SELECT
        ip,
        last_track as track,
        AVG(duration_seconds) as ip_station_stay_sec,
        SUM(duration_seconds) as ip_total_lost_sec,
        AVG(CASE WHEN last_track_progress_sec > 0 THEN last_track_progress_sec ELSE NULL END) as ip_playtime_when_left_sec,
        MAX(last_seen) as ip_last_seen
      FROM listener_sessions
      WHERE is_active = 0
        AND last_track IS NOT NULL
        AND TRIM(last_track) != ''
        AND last_track != 'No track metadata recorded'
        ${since > 0 ? 'AND last_seen >= ?' : ''}
        ${modeFilter}
        -- Bots and crawlers are ALWAYS excluded from detractor songs
        AND category != 'Bot / Ripper'
        AND ip NOT IN (SELECT ip FROM bot_ips)
        AND LOWER(user_agent) NOT LIKE '%bot%'
        AND LOWER(user_agent) NOT LIKE '%onlineradiobox%'
        AND LOWER(user_agent) NOT LIKE '%crawler%'
        AND LOWER(user_agent) NOT LIKE '%spider%'
        AND LOWER(user_agent) NOT LIKE '%streamripper%'
        -- Station admin ("Me") IPs are ALWAYS excluded
        AND ip NOT IN (
          SELECT ip FROM ip_aliases
          WHERE LOWER(TRIM(friendly_name)) = 'me'
             OR LOWER(friendly_name) LIKE 'me %'
             OR LOWER(friendly_name) LIKE 'me-%'
             OR LOWER(friendly_name) LIKE 'me -%'
             OR LOWER(friendly_name) LIKE '%(me)%'
             OR LOWER(TRIM(friendly_name)) = 'admin'
             OR LOWER(TRIM(friendly_name)) = 'station admin'
             OR LOWER(notes) LIKE '%me%'
        )
      GROUP BY ip, last_track
    )
    SELECT
      track,
      COUNT(*) as unique_ips,
      ROUND(AVG(ip_station_stay_sec)) as avg_station_stay_sec,
      MIN(ip_station_stay_sec) as min_station_stay_sec,
      MAX(ip_station_stay_sec) as max_station_stay_sec,
      SUM(ip_total_lost_sec) as total_lost_listening_sec,
      ROUND(AVG(ip_playtime_when_left_sec)) as avg_playtime_when_left_sec,
      MIN(ip_playtime_when_left_sec) as min_playtime_when_left_sec,
      MAX(ip_playtime_when_left_sec) as max_playtime_when_left_sec,
      SUM(CASE WHEN ip_playtime_when_left_sec > 0 AND ip_playtime_when_left_sec <= 30 THEN 1 ELSE 0 END) as early_dropoffs_30s,
      SUM(CASE WHEN ip_playtime_when_left_sec > 30 AND ip_playtime_when_left_sec <= 120 THEN 1 ELSE 0 END) as mid_dropoffs_2m,
      SUM(CASE WHEN ip_playtime_when_left_sec > 120 THEN 1 ELSE 0 END) as late_dropoffs,
      MAX(ip_last_seen) as last_drop_ts
    FROM unique_ip_drops
    GROUP BY track
    ORDER BY unique_ips DESC, total_lost_listening_sec DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params).map((row, idx) => {
    const totalU = Number(row.unique_ips || 0);
    const early = Number(row.early_dropoffs_30s || 0);
    const mid = Number(row.mid_dropoffs_2m || 0);
    const late = Number(row.late_dropoffs || 0);

    return {
      rank: idx + 1,
      track: row.track,
      uniqueIps: totalU,
      leaveCount: totalU,
      avgStationStaySec: Number(row.avg_station_stay_sec || 0),
      minStationStaySec: Number(row.min_station_stay_sec || 0),
      maxStationStaySec: Number(row.max_station_stay_sec || 0),
      totalLostListeningSec: Number(row.total_lost_listening_sec || 0),
      avgPlaytimeWhenLeftSec: Number(row.avg_playtime_when_left_sec || 0),
      minPlaytimeWhenLeftSec: Number(row.min_playtime_when_left_sec || 0),
      maxPlaytimeWhenLeftSec: Number(row.max_playtime_when_left_sec || 0),
      earlyDropoffs30s: early,
      earlyDropoffPct: totalU > 0 ? Math.round((early / totalU) * 100) : 0,
      midDropoffs2m: mid,
      midDropoffPct: totalU > 0 ? Math.round((mid / totalU) * 100) : 0,
      lateDropoffs: late,
      lateDropoffPct: totalU > 0 ? Math.round((late / totalU) * 100) : 0,
      lastDropTs: Number(row.last_drop_ts || 0),
    };
  });
}

function getDetractorSummary(rangeMinutes = 1440, sourceMode = null, excludeBots = true) {
  const now = Date.now();
  const since = rangeMinutes > 0 ? now - rangeMinutes * 60 * 1000 : 0;

  const modeFilter = sourceMode ? 'AND source_mode = ?' : '';
  const params = [];
  if (since > 0) params.push(since);
  if (sourceMode) params.push(sourceMode);

  const sql = `
    WITH unique_ip_drops AS (
      SELECT
        ip,
        last_track as track,
        AVG(duration_seconds) as ip_station_stay_sec,
        SUM(duration_seconds) as ip_total_lost_sec,
        AVG(CASE WHEN last_track_progress_sec > 0 THEN last_track_progress_sec ELSE NULL END) as ip_playtime_when_left_sec
      FROM listener_sessions
      WHERE is_active = 0
        AND last_track IS NOT NULL
        AND TRIM(last_track) != ''
        AND last_track != 'No track metadata recorded'
        ${since > 0 ? 'AND last_seen >= ?' : ''}
        ${modeFilter}
        -- Bots and crawlers are ALWAYS excluded
        AND category != 'Bot / Ripper'
        AND ip NOT IN (SELECT ip FROM bot_ips)
        AND LOWER(user_agent) NOT LIKE '%bot%'
        AND LOWER(user_agent) NOT LIKE '%onlineradiobox%'
        AND LOWER(user_agent) NOT LIKE '%crawler%'
        AND LOWER(user_agent) NOT LIKE '%spider%'
        AND LOWER(user_agent) NOT LIKE '%streamripper%'
        -- Station admin ("Me") IPs are ALWAYS excluded
        AND ip NOT IN (
          SELECT ip FROM ip_aliases
          WHERE LOWER(TRIM(friendly_name)) = 'me'
             OR LOWER(friendly_name) LIKE 'me %'
             OR LOWER(friendly_name) LIKE 'me-%'
             OR LOWER(friendly_name) LIKE 'me -%'
             OR LOWER(friendly_name) LIKE '%(me)%'
             OR LOWER(TRIM(friendly_name)) = 'admin'
             OR LOWER(TRIM(friendly_name)) = 'station admin'
             OR LOWER(notes) LIKE '%me%'
        )
      GROUP BY ip, last_track
    )
    SELECT
      COUNT(*) as total_tuneouts,
      COUNT(DISTINCT track) as songs_affected,
      COUNT(DISTINCT ip) as unique_dropped_listeners,
      ROUND(AVG(ip_station_stay_sec)) as avg_station_stay_sec,
      ROUND(AVG(ip_playtime_when_left_sec)) as avg_playtime_when_left_sec,
      SUM(ip_total_lost_sec) as total_lost_listening_sec
    FROM unique_ip_drops
  `;

  const row = db.prepare(sql).get(...params);
  return {
    totalTuneOuts: Number(row?.total_tuneouts || 0),
    songsAffected: Number(row?.songs_affected || 0),
    uniqueDroppedListeners: Number(row?.unique_dropped_listeners || 0),
    avgStationStaySec: Number(row?.avg_station_stay_sec || 0),
    avgPlaytimeWhenLeftSec: Number(row?.avg_playtime_when_left_sec || 0),
    totalLostListeningSec: Number(row?.total_lost_listening_sec || 0),
  };
}

function getIpAliasesMap() {
  const rows = db.prepare('SELECT ip, friendly_name, notes, updated_at FROM ip_aliases').all();
  const map = {};
  for (const r of rows) {
    map[r.ip] = {
      ip: r.ip,
      friendlyName: r.friendly_name,
      notes: r.notes || '',
      updatedAt: r.updated_at,
    };
  }
  return map;
}

function getIpAlias(ip) {
  const clean = String(ip || '').trim();
  if (!clean) return null;
  const r = db.prepare('SELECT ip, friendly_name, notes, updated_at FROM ip_aliases WHERE ip = ?').get(clean);
  if (!r) return null;
  return {
    ip: r.ip,
    friendlyName: r.friendly_name,
    notes: r.notes || '',
    updatedAt: r.updated_at,
  };
}

function setIpAlias(ip, friendlyName, notes = '') {
  const cleanIp = String(ip || '').trim();
  if (!cleanIp) throw new Error('IP address is required');
  const cleanName = String(friendlyName || '').trim();
  const cleanNotes = String(notes || '').trim();
  const now = Date.now();

  if (!cleanName) {
    db.prepare('DELETE FROM ip_aliases WHERE ip = ?').run(cleanIp);
    return { ip: cleanIp, friendlyName: '', notes: '', updatedAt: now };
  }

  db.prepare(`
    INSERT INTO ip_aliases (ip, friendly_name, notes, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET
      friendly_name = excluded.friendly_name,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(cleanIp, cleanName, cleanNotes, now);

  return { ip: cleanIp, friendlyName: cleanName, notes: cleanNotes, updatedAt: now };
}

/**
 * Returns the Top N Returning Listeners ranked by distinct session visits & cumulative connected time.
 * Excludes bots/crawlers (when returningExcludeBots is true) and listeners with average connection
 * time below returningMinAvgSec (default 60s = 1 minute).
 */
function getTopReturningListeners(limit = 5, sourceMode = 'live') {
  const cfg = getConfig();
  const minAvgSec = Math.max(0, Number(cfg.returningMinAvgSec ?? 60));
  const excludeBots = cfg.returningExcludeBots !== false ? 1 : 0;
  const aliases = getIpAliasesMap();

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
        AND (? = 0 OR (
          category != 'Bot / Ripper'
          AND ip NOT IN (SELECT ip FROM bot_ips)
          AND LOWER(user_agent) NOT LIKE '%bot%'
          AND LOWER(user_agent) NOT LIKE '%onlineradiobox%'
          AND LOWER(user_agent) NOT LIKE '%crawler%'
          AND LOWER(user_agent) NOT LIKE '%spider%'
          AND LOWER(user_agent) NOT LIKE '%streamripper%'
        ))
      GROUP BY ip
      HAVING AVG(duration_seconds) >= ?
      ORDER BY session_count DESC, total_duration_seconds DESC
      LIMIT ?
    `)
    .all(sourceMode, excludeBots, minAvgSec, limit);

  return rows.map((r, idx) => ({
    rank: idx + 1,
    ip: r.ip,
    friendlyName: aliases[r.ip]?.friendlyName || '',
    notes: aliases[r.ip]?.notes || '',
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

function getAggregatedStats(sourceMode = 'live', excludeBots = false) {
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const cfg = getConfig();
  const minAvgSec = Math.max(0, Number(cfg.returningMinAvgSec ?? 60));
  const excludeFlag = excludeBots || cfg.returningExcludeBots !== false ? 1 : 0;
  const countCol = excludeBots ? 'COALESCE(human_count, listener_count)' : 'listener_count';

  const peak24hRow = db
    .prepare(`SELECT ${countCol} as listener_count, ts, peak_reported FROM snapshots WHERE ts >= ? AND source_mode = ? ORDER BY ${countCol} DESC LIMIT 1`)
    .get(dayAgo, sourceMode);

  const allTimePeakRow = db
    .prepare(`SELECT MAX( MAX(${countCol}), MAX(peak_reported) ) as peak, ts FROM snapshots WHERE source_mode = ?`)
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
        AND (? = 0 OR (
          category != 'Bot / Ripper'
          AND ip NOT IN (SELECT ip FROM bot_ips)
          AND LOWER(user_agent) NOT LIKE '%bot%'
          AND LOWER(user_agent) NOT LIKE '%onlineradiobox%'
          AND LOWER(user_agent) NOT LIKE '%crawler%'
          AND LOWER(user_agent) NOT LIKE '%spider%'
          AND LOWER(user_agent) NOT LIKE '%streamripper%'
        ))
    `)
    .get(dayAgo, sourceMode, excludeBots ? 1 : 0);

  const returningCountRow = db
    .prepare(`
      SELECT COUNT(*) as returning_ips
      FROM (
        SELECT ip
        FROM listener_sessions
        WHERE source_mode = ?
          AND (? = 0 OR (
            category != 'Bot / Ripper'
            AND ip NOT IN (SELECT ip FROM bot_ips)
            AND LOWER(user_agent) NOT LIKE '%bot%'
            AND LOWER(user_agent) NOT LIKE '%onlineradiobox%'
            AND LOWER(user_agent) NOT LIKE '%crawler%'
            AND LOWER(user_agent) NOT LIKE '%spider%'
            AND LOWER(user_agent) NOT LIKE '%streamripper%'
          ))
        GROUP BY ip
        HAVING COUNT(*) > 1 AND AVG(duration_seconds) >= ?
      )
    `)
    .get(sourceMode, excludeFlag, minAvgSec);

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
    returningMinAvgSec: minAvgSec,
    returningExcludeBots: Boolean(excludeBots),
    recentEvents,
  };
}

function getBotIpsSet() {
  const rows = db.prepare('SELECT ip FROM bot_ips').all();
  return new Set(rows.map(r => r.ip));
}

function isBotIp(ip) {
  if (!ip) return false;
  return Boolean(db.prepare('SELECT 1 FROM bot_ips WHERE ip = ?').get(ip));
}

function setBotIp(ip, isBot, reason = '') {
  const cleanIp = String(ip || '').trim();
  if (!cleanIp) return false;
  const now = Date.now();

  if (isBot) {
    db.prepare(`
      INSERT INTO bot_ips (ip, reason, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at
    `).run(cleanIp, String(reason || 'Manually marked as Bot / Ripper'), now);

    db.prepare(`
      UPDATE listener_sessions
      SET category = 'Bot / Ripper'
      WHERE ip = ?
    `).run(cleanIp);

    insertEventStmt.run(now, 'bot_flag', cleanIp, '', '', 'Bot / Ripper', 0, 'Flagged as Bot / Ripper', '/listen');
    return true;
  } else {
    db.prepare('DELETE FROM bot_ips WHERE ip = ?').run(cleanIp);

    const sessions = db.prepare('SELECT session_key, user_agent FROM listener_sessions WHERE ip = ?').all(cleanIp);
    const updateStmt = db.prepare('UPDATE listener_sessions SET category = ?, player = ?, os = ? WHERE session_key = ?');
    for (const s of sessions) {
      const parsed = parseUserAgent(s.user_agent);
      updateStmt.run(parsed.category, parsed.player, parsed.os, s.session_key);
    }

    insertEventStmt.run(now, 'bot_unflag', cleanIp, '', '', '', 0, 'Removed Bot / Ripper flag', '/listen');
    return false;
  }
}

function findTrackStartTs(trackName, exitTs) {
  if (!trackName || !exitTs) return null;
  const event = db.prepare(`
    SELECT ts FROM events_log
    WHERE event_type = 'track'
      AND details = ?
      AND ts <= ?
      AND ts >= ? - (30 * 60 * 1000)
    ORDER BY ts DESC
    LIMIT 1
  `).get(`Now Playing: ${trackName}`, exitTs, exitTs);

  if (event && event.ts) return event.ts;

  const snaps = db.prepare(`
    SELECT ts, current_track
    FROM snapshots
    WHERE ts <= ? AND ts >= ? - (30 * 60 * 1000)
    ORDER BY ts DESC
    LIMIT 60
  `).all(exitTs, exitTs);

  let earliest = null;
  for (const snap of snaps) {
    if (snap.current_track === trackName) {
      earliest = snap.ts;
    } else {
      break;
    }
  }
  return earliest;
}

function getIpHistory(ip) {
  const sessions = db
    .prepare('SELECT * FROM listener_sessions WHERE ip = ? ORDER BY last_seen DESC LIMIT 50')
    .all(ip);

  const findTrackStmt = db.prepare(`
    SELECT current_track
    FROM snapshots
    WHERE ts <= ? AND LENGTH(current_track) > 0
    ORDER BY ts DESC
    LIMIT 1
  `);

  for (const s of sessions) {
    if (!s.last_track) {
      const snap = findTrackStmt.get(s.last_seen);
      if (snap && snap.current_track) {
        s.last_track = snap.current_track;
      }
    }
    if ((!s.last_track_progress_sec || s.last_track_progress_sec === 0) && s.last_track) {
      const startTs = findTrackStartTs(s.last_track, s.last_seen);
      if (startTs) {
        s.last_track_progress_sec = Math.max(0, Math.floor((s.last_seen - startTs) / 1000));
      }
    }
  }

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
  const alias = getIpAlias(ip);
  const isBot = isBotIp(ip);
  const mostRecent = sessions[0];
  const lastExitTrack = mostRecent?.last_track || '';
  const lastExitTrackProgressSec = mostRecent?.last_track_progress_sec || 0;

  return {
    ip,
    friendlyName: alias?.friendlyName || '',
    notes: alias?.notes || '',
    isBot,
    summary,
    lastExitTrack,
    lastExitTrackProgressSec,
    sessions,
  };
}

function getCachedGeoIp(ip) {
  try {
    const row = db.prepare('SELECT * FROM ip_geo_cache WHERE ip = ?').get(ip);
    if (!row) return null;
    return {
      ip: row.ip,
      countryCode: row.country_code,
      countryName: row.country_name,
      region: row.region,
      city: row.city,
      hasCity: Boolean(row.has_city),
      lat: row.lat,
      lon: row.lon,
      timezone: row.timezone,
      isp: row.isp,
      asOrg: row.as_org,
      source: row.source,
      isLocal: false,
    };
  } catch (_) {
    return null;
  }
}

function setCachedGeoIp(data) {
  try {
    const stmt = db.prepare(`
      INSERT INTO ip_geo_cache (
        ip, country_code, country_name, region, city, has_city, lat, lon, timezone, isp, as_org, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET
        country_code = excluded.country_code,
        country_name = excluded.country_name,
        region = excluded.region,
        city = excluded.city,
        has_city = excluded.has_city,
        lat = excluded.lat,
        lon = excluded.lon,
        timezone = excluded.timezone,
        isp = excluded.isp,
        as_org = excluded.as_org,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      data.ip,
      data.countryCode || 'UN',
      data.countryName || 'Unknown',
      data.region || '',
      data.city || '',
      data.hasCity ? 1 : 0,
      Number(data.lat) || 0,
      Number(data.lon) || 0,
      data.timezone || 'UTC',
      data.isp || '',
      data.asOrg || data.as || '',
      data.source || 'ip-api',
      Date.now()
    );

    // Update active or existing sessions for this IP with higher accuracy city and lat/lon if available
    if (data.city && data.countryCode && data.countryCode !== 'UN') {
      try {
        db.prepare(`
          UPDATE listener_sessions
          SET city = ?, country_code = ?, country_name = ?, lat = ?, lon = ?
          WHERE ip = ? AND (city = '' OR city = country_name OR city LIKE 'Unresolved%')
        `).run(data.city, data.countryCode, data.countryName, data.lat, data.lon, data.ip);
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Error saving cached GeoIP for ${data.ip}:`, err.message);
  }
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
  getHistoricalTrackChanges,
  getHistoricalBreakdowns,
  getTimeOfDayProfile,
  getTopReturningListeners,
  getAggregatedStats,
  getIpHistory,
  getIpAliasesMap,
  getIpAlias,
  setIpAlias,
  getBotIpsSet,
  isBotIp,
  setBotIp,
  logCustomEvent,
  getCachedGeoIp,
  setCachedGeoIp,
  getDetractorSongs,
  getDetractorSummary,
};
