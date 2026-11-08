const { db } = require('./db');

// Real public IPs across Europe, North America, and globally so geoip-lite resolves accurate cities & coordinates
const SAMPLE_CLIENT_POOL = [
  { ip: '86.120.140.22', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
  { ip: '79.112.44.185', ua: 'VLC/3.0.21 LibVLC/3.0.21' },
  { ip: '5.14.88.110', ua: 'AppleCoreMedia/1.0.0.21F90 (iPhone; U; CPU OS 17_5_1 like Mac OS X; ro_ro)' },
  { ip: '188.25.102.61', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' },
  { ip: '82.132.219.44', ua: 'AppleCoreMedia/1.0.0.21F90 (iPhone; U; CPU OS 17_5_1 like Mac OS X; en_gb)' },
  { ip: '91.198.174.192', ua: 'VLC/3.0.20 LibVLC/3.0.20' },
  { ip: '185.60.216.35', ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' },
  { ip: '212.58.244.23', ua: 'Sonos/79.1-53290 (ZP120)' },
  { ip: '193.239.56.12', ua: 'WinampMPEG/5.92, Ultravox/2.1' },
  { ip: '62.210.105.118', ua: 'foobar2000/2.1.5' },
  { ip: '145.239.88.14', ua: 'TuneIn Radio/34.2 (Android 14; Pixel 8 Pro; ExoPlayerLib/2.19.1)' },
  { ip: '94.66.120.48', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0' },
  { ip: '176.58.119.26', ua: 'RadioGarden/4.10.2 (iOS 17.6; iPhone15,3)' },
  { ip: '89.136.44.99', ua: 'AIMP/5.30.2549 (Windows 11)' },
  { ip: '195.154.122.40', ua: 'Lavf/60.16.100' },
  { ip: '81.196.22.145', ua: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36' },
  { ip: '109.166.130.72', ua: 'AppleCoreMedia/1.0.0.21F90 (iPad; U; CPU OS 17_5 like Mac OS X)' },
  { ip: '46.101.142.88', ua: 'VLC/3.0.20 LibVLC/3.0.20' },
  { ip: '138.201.81.199', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
  { ip: '24.48.0.1', ua: 'iTunes/12.13.2 (Macintosh; OS X 14.5)' },
  { ip: '64.233.160.10', ua: 'GoogleCast/1.68.374976 (Linux; Android 12; Chromecast)' },
  { ip: '151.101.1.69', ua: 'mpv 0.38.0' },
  { ip: '37.120.192.41', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
  { ip: '185.125.190.36', ua: 'ExoPlayerLib/2.19.1 (Linux; Android 14) OzoneFM-Mobile/2.4.0' },
  { ip: '86.124.88.19', ua: 'ExoPlayerLib/2.19.1 (Linux; Android 13) OzoneFM-Mobile/2.4.0' },
  { ip: '92.81.204.11', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1' },
  { ip: '104.244.42.129', ua: 'Streamripper/1.64.6' },
  { ip: '178.138.96.45', ua: 'MusicBee/3.5.8698' },
];

const TRACK_ROTATION = [
  'Bicep - Apricots (Ozone.FM Club Edit)',
  'RÜFÜS DU SOL - On My Knees (Live Broadcast Mix)',
  'Fred again.. & Swedish House Mafia - Turn On The Lights again..',
  'Bonobo & Jacques Greene - Fold',
  'Peggy Gou - (It Goes Like) Nanana',
  'Four Tet - Three Drums (Ozone Late Night Session)',
  'Disclosure - Higher Than Ever Before',
  'Overmono - Good Lies',
  'Keinemusik (Rampa, Adam Port, &ME) - Move',
];

let activeSimClients = [];
let nextClientId = 4810;
let lastSimTick = Date.now();
let simPeak = 34;

function initSimulator() {
  if (activeSimClients.length > 0) return;
  const now = Date.now();
  // Start with 19 active listeners with realistic staggered connected durations
  const initialCount = 19;
  for (let i = 0; i < initialCount; i++) {
    const template = SAMPLE_CLIENT_POOL[i % SAMPLE_CLIENT_POOL.length];
    const connectedSeconds = Math.floor(120 + (i * 347) % 7800);
    activeSimClients.push({
      clientId: String(nextClientId++),
      ip: template.ip,
      userAgent: template.ua,
      connectedSeconds,
      joinedAt: now - connectedSeconds * 1000,
      mount: '/listen',
      lag: 0,
    });
  }

  seedSimulationHistory();
}

function seedSimulationHistory() {
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM snapshots WHERE source_mode = 'simulation'").get();
  if (existing && existing.cnt > 10) return;

  const now = Date.now();
  const insertSnap = db.prepare(`
    INSERT INTO snapshots (ts, mount, listener_count, unique_ips, peak_reported, current_track, bitrate, source_mode)
    VALUES (?, '/listen', ?, ?, ?, ?, 320, 'simulation')
  `);

  // Seed 24 hours at 10-minute intervals (144 points)
  let runningPeak = 28;
  for (let i = 144; i >= 1; i--) {
    const ts = now - i * 10 * 60 * 1000;
    const hourOfDay = new Date(ts).getUTCHours();
    // Diurnal broadcast curve: higher in afternoon/evening, lower late night
    const diurnalWave = Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2) * 9;
    const jitter = Math.round(Math.sin(i * 0.7) * 3 + Math.cos(i * 1.3) * 2);
    const count = Math.max(6, Math.round(21 + diurnalWave + jitter));
    if (count > runningPeak) runningPeak = count;
    const track = TRACK_ROTATION[Math.floor(i / 2) % TRACK_ROTATION.length];
    insertSnap.run(ts, count, Math.max(5, count - 1), runningPeak, track);
  }

  // Seed historical returning listener sessions for Top 5 Returning Listeners in simulation mode
  const returningProfiles = [
    {
      ip: '86.124.118.42',
      ua: 'AppleCoreMedia/1.0.0.21M5068a (AudioAccessory5,1; U; CPU OS 18_1 like Mac OS X; ro_ro)',
      player: 'Apple HomePod mini',
      category: 'Smart Speaker',
      os: 'HomePod Software (audioOS)',
      cc: 'RO',
      cn: 'Romania',
      city: 'Brebu Mănăstirei, Prahova',
      lat: 45.18,
      lon: 25.77,
      sessions: 14,
      avgSec: 4620,
    },
    {
      ip: '86.120.140.22',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
      player: 'Chrome (Web)',
      category: 'Web Browser',
      os: 'Windows',
      cc: 'RO',
      cn: 'Romania',
      city: 'Bucharest',
      lat: 44.43,
      lon: 26.10,
      sessions: 11,
      avgSec: 5180,
    },
    {
      ip: '79.112.44.185',
      ua: 'VLC/3.0.21 LibVLC/3.0.21',
      player: 'VLC 3.0',
      category: 'Desktop Player',
      os: 'Windows',
      cc: 'RO',
      cn: 'Romania',
      city: 'Cluj-Napoca',
      lat: 46.77,
      lon: 23.60,
      sessions: 9,
      avgSec: 3940,
    },
    {
      ip: '82.132.219.44',
      ua: 'AppleCoreMedia/1.0.0.21F90 (iPhone; U; CPU OS 17_5_1 like Mac OS X; en_gb)',
      player: 'Apple CoreMedia (iOS / HomePod)',
      category: 'Mobile / Native',
      os: 'iOS',
      cc: 'GB',
      cn: 'United Kingdom',
      city: 'London',
      lat: 51.51,
      lon: -0.13,
      sessions: 8,
      avgSec: 3410,
    },
    {
      ip: '91.198.174.192',
      ua: 'VLC/3.0.20 LibVLC/3.0.20',
      player: 'VLC 3.0',
      category: 'Desktop Player',
      os: 'macOS',
      cc: 'NL',
      cn: 'Netherlands',
      city: 'Amsterdam',
      lat: 52.37,
      lon: 4.90,
      sessions: 6,
      avgSec: 2890,
    },
  ];

  const insertHistSession = db.prepare(`
    INSERT OR IGNORE INTO listener_sessions (
      session_key, client_id, ip, mount, user_agent, player, category, os,
      country_code, country_name, city, lat, lon,
      first_seen, last_seen, duration_seconds, is_active, source_mode,
      last_track, last_track_progress_sec
    ) VALUES (?, ?, ?, '/listen', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'simulation', ?, ?)
  `);

  for (const prof of returningProfiles) {
    for (let s = 1; s <= prof.sessions - 1; s++) {
      const endTs = now - s * 5.5 * 3600 * 1000;
      const dur = Math.round(prof.avgSec * (0.75 + ((s * 17) % 50) / 100));
      const startTs = endTs - dur * 1000;
      const track = TRACK_ROTATION[(s * 3 + prof.sessions) % TRACK_ROTATION.length];
      const progressPhases = [
        18 + (s % 12),        // intro: 18-30s
        45 + ((s * 7) % 45),  // early mid: 45-90s
        85 + ((s * 13) % 35), // mid: 85-120s
        135 + ((s * 19) % 45),// late: 135-180s
        190 + ((s * 23) % 50),// outro: 190-240s
      ];
      const trackProgress = progressPhases[(s + prof.sessions) % progressPhases.length];
      insertHistSession.run(
        `simulation:hist:${prof.ip}:${s}`,
        String(3000 + s),
        prof.ip,
        prof.ua,
        prof.player,
        prof.category,
        prof.os,
        prof.cc,
        prof.cn,
        prof.city,
        prof.lat,
        prof.lon,
        startTs,
        endTs,
        dur,
        track,
        trackProgress
      );
    }
  }
}

function stepSimulation(mount = '/listen') {
  initSimulator();
  const now = Date.now();
  const elapsedSec = Math.max(1, Math.round((now - lastSimTick) / 1000));
  lastSimTick = now;

  // Increment connectedSeconds for all active simulated listeners
  for (const c of activeSimClients) {
    c.connectedSeconds += elapsedSec;
    c.mount = mount;
  }

  // Occasionally have 1 listener leave or join so live telemetry feels dynamic
  if (activeSimClients.length > 10 && Math.random() < 0.25) {
    const idx = Math.floor(Math.random() * activeSimClients.length);
    activeSimClients.splice(idx, 1);
  }

  if (activeSimClients.length < 26 && Math.random() < 0.32) {
    const activeIps = new Set(activeSimClients.map(c => c.ip));
    const candidates = SAMPLE_CLIENT_POOL.filter(p => !activeIps.has(p.ip));
    const chosen = candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : SAMPLE_CLIENT_POOL[Math.floor(Math.random() * SAMPLE_CLIENT_POOL.length)];
    activeSimClients.push({
      clientId: String(nextClientId++),
      ip: chosen.ip,
      userAgent: chosen.ua,
      connectedSeconds: Math.floor(Math.random() * 8) + 1,
      joinedAt: now,
      mount,
      lag: 0,
    });
  }

  if (activeSimClients.length > simPeak) {
    simPeak = activeSimClients.length;
  }

  const trackIndex = Math.floor(now / (180 * 1000)) % TRACK_ROTATION.length;
  const currentTrack = TRACK_ROTATION[trackIndex];

  return {
    listeners: activeSimClients.map(c => ({ ...c })),
    reportedCount: activeSimClients.length,
    sourceMeta: {
      serverName: 'OZONE.FM — Live Broadcast',
      serverDescription: 'Ozone.FM 8443 High-Definition Audio Stream',
      contentType: 'audio/aacp',
      bitrate: 320,
      samplerate: 48000,
      channels: 2,
      title: currentTrack,
      genre: 'Electronic / Progressive / Club',
      listenerPeak: simPeak,
      maxListeners: 500,
      streamStart: new Date(now - 14 * 24 * 3600 * 1000).toISOString(),
      listenUrl: `https://live.ozone.fm:8443${mount}`,
      serverId: 'Icecast 2.4.4-kh15',
      host: 'live.ozone.fm',
    },
  };
}

function kickSimulatedClient(clientId) {
  const before = activeSimClients.length;
  const target = activeSimClients.find(c => String(c.clientId) === String(clientId));
  activeSimClients = activeSimClients.filter(c => String(c.clientId) !== String(clientId));
  return { removed: activeSimClients.length < before, client: target || null };
}

module.exports = {
  stepSimulation,
  kickSimulatedClient,
};
