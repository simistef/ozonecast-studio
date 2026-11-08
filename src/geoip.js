const http = require('node:http');
const https = require('node:https');
const geoip = require('geoip-lite');
const { getCachedGeoIp, setCachedGeoIp } = require('./db');

const COUNTRY_NAMES = {
  US: 'United States',
  GB: 'United Kingdom',
  DE: 'Germany',
  FR: 'France',
  NL: 'Netherlands',
  RO: 'Romania',
  GR: 'Greece',
  IT: 'Italy',
  ES: 'Spain',
  CA: 'Canada',
  AU: 'Australia',
  CH: 'Switzerland',
  AT: 'Austria',
  BE: 'Belgium',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  PL: 'Poland',
  CZ: 'Czechia',
  HU: 'Hungary',
  BG: 'Bulgaria',
  RS: 'Serbia',
  HR: 'Croatia',
  SI: 'Slovenia',
  SK: 'Slovakia',
  PT: 'Portugal',
  IE: 'Ireland',
  BR: 'Brazil',
  AR: 'Argentina',
  MX: 'Mexico',
  CL: 'Chile',
  CO: 'Colombia',
  JP: 'Japan',
  KR: 'South Korea',
  SG: 'Singapore',
  IN: 'India',
  ZA: 'South Africa',
  AE: 'United Arab Emirates',
  IL: 'Israel',
  TR: 'Turkey',
  UA: 'Ukraine',
  MD: 'Moldova',
  CY: 'Cyprus',
  NZ: 'New Zealand',
};

const geoCache = new Map();
const queue = [];
const inQueueOrFlight = new Set();
let isQueueRunning = false;

function cleanIp(rawIp) {
  if (!rawIp) return '';
  let ip = String(rawIp).trim();
  // Strip IPv6-mapped IPv4 prefix
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  return ip;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  return false;
}

/**
 * Fetch high-accuracy geolocation from online API
 * Prioritizes ipinfo.io if IPINFO_TOKEN is provided, otherwise uses ip-api.com
 */
function fetchRemoteGeo(ip) {
  return new Promise((resolve, reject) => {
    const ipinfoToken = process.env.IPINFO_TOKEN;
    if (ipinfoToken) {
      const url = `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(ipinfoToken)}`;
      const req = https.get(url, { timeout: 4500 }, res => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error(`IPinfo HTTP ${res.statusCode}: ${raw}`));
            }
            const data = JSON.parse(raw);
            const [latStr, lonStr] = (data.loc || '').split(',');
            const countryCode = data.country || 'UN';
            const countryName = COUNTRY_NAMES[countryCode] || data.country || countryCode;
            const city = (data.city || '').trim();

            resolve({
              ip,
              countryCode,
              countryName,
              region: data.region || '',
              city,
              hasCity: Boolean(city),
              lat: Number(latStr) || 0,
              lon: Number(lonStr) || 0,
              timezone: data.timezone || 'UTC',
              isp: data.org || '',
              asOrg: data.org || '',
              source: 'ipinfo.io (High Accuracy)',
              isLocal: false,
            });
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('IPinfo lookup timeout')));
      return;
    }

    // Default to ip-api.com (No token needed, highly accurate in Europe/worldwide)
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`;
    const req = http.get(url, { timeout: 4500 }, res => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.status !== 'success') {
            return reject(new Error(`ip-api returned: ${data.message || 'failure'}`));
          }
          const countryCode = data.countryCode || 'UN';
          const countryName = data.country || COUNTRY_NAMES[countryCode] || countryCode;
          const city = (data.city || '').trim();

          resolve({
            ip,
            countryCode,
            countryName,
            region: data.regionName || data.region || '',
            city,
            hasCity: Boolean(city),
            lat: Number(data.lat) || 0,
            lon: Number(data.lon) || 0,
            timezone: data.timezone || 'UTC',
            isp: data.isp || data.org || '',
            asOrg: data.as || data.org || '',
            source: 'ip-api.com (High Accuracy)',
            isLocal: false,
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ip-api lookup timeout')));
  });
}

function processQueue() {
  if (isQueueRunning || queue.length === 0) return;
  isQueueRunning = true;

  const ip = queue.shift();
  fetchRemoteGeo(ip)
    .then(result => {
      geoCache.set(ip, result);
      setCachedGeoIp(result);
    })
    .catch(_err => {
      // Keep existing cached or offline fallback on remote failure
    })
    .finally(() => {
      inQueueOrFlight.delete(ip);
      isQueueRunning = false;
      // Rate limiter delay: 1400ms for ip-api (under 45/min threshold), 200ms for ipinfo token
      const delay = process.env.IPINFO_TOKEN ? 200 : 1400;
      setTimeout(processQueue, delay);
    });
}

function enqueueHighAccuracy(ip) {
  if (!ip || isPrivateIp(ip) || inQueueOrFlight.has(ip)) return;
  inQueueOrFlight.add(ip);
  queue.push(ip);
  processQueue();
}

/**
 * Fast synchronous lookup for continuous telemetry loops.
 * Checks Memory Cache -> SQLite Persistent Cache -> Offline GeoIP fallback.
 * Enqueues un-enhanced public IPs for background high-accuracy enhancement.
 */
function lookupIp(rawIp) {
  const ip = cleanIp(rawIp);
  if (!ip) {
    return {
      ip: '0.0.0.0',
      countryCode: 'XX',
      countryName: 'Unknown',
      region: '',
      city: '',
      hasCity: false,
      lat: 0,
      lon: 0,
      timezone: 'UTC',
      isp: '',
      asOrg: '',
      source: 'none',
      isLocal: true,
    };
  }

  if (geoCache.has(ip)) {
    return geoCache.get(ip);
  }

  if (isPrivateIp(ip)) {
    const localResult = {
      ip,
      countryCode: 'LO',
      countryName: 'Local Network (LAN)',
      region: 'Internal',
      city: 'Studio / Local',
      hasCity: true,
      lat: 44.4268,
      lon: 26.1025,
      timezone: 'Europe/Bucharest',
      isp: 'Local Subnet',
      asOrg: 'Private Network',
      source: 'local',
      isLocal: true,
    };
    geoCache.set(ip, localResult);
    return localResult;
  }

  // Check persistent SQLite cache
  const cachedDb = getCachedGeoIp(ip);
  if (cachedDb) {
    geoCache.set(ip, cachedDb);
    return cachedDb;
  }

  // Instant offline fallback using geoip-lite
  const record = geoip.lookup(ip);
  let initialResult;
  if (!record) {
    initialResult = {
      ip,
      countryCode: 'UN',
      countryName: 'Unresolved Region',
      region: '',
      city: '',
      hasCity: false,
      lat: 46.2,
      lon: 15.0,
      timezone: 'UTC',
      isp: '',
      asOrg: '',
      source: 'geoip-lite (Pending Live Enhancement)',
      isLocal: false,
    };
  } else {
    const countryCode = record.country || 'UN';
    let countryName = COUNTRY_NAMES[countryCode] || countryCode;
    try {
      if (!COUNTRY_NAMES[countryCode] && typeof Intl !== 'undefined' && Intl.DisplayNames) {
        const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
        countryName = displayNames.of(countryCode) || countryCode;
      }
    } catch (_) {}

    const ll = Array.isArray(record.ll) && record.ll.length === 2 ? record.ll : [0, 0];
    const rawCity = (record.city || '').trim();
    const hasCity = Boolean(rawCity);

    initialResult = {
      ip,
      countryCode,
      countryName,
      region: record.region || '',
      city: hasCity ? rawCity : '',
      hasCity,
      lat: Number(ll[0]) || 0,
      lon: Number(ll[1]) || 0,
      timezone: record.timezone || 'UTC',
      isp: '',
      asOrg: '',
      source: 'geoip-lite (Pending Live Enhancement)',
      isLocal: false,
    };
  }

  if (geoCache.size > 5000) {
    const firstKey = geoCache.keys().next().value;
    geoCache.delete(firstKey);
  }
  geoCache.set(ip, initialResult);

  // Enqueue for background high-accuracy resolution
  enqueueHighAccuracy(ip);

  return initialResult;
}

/**
 * Direct async resolution for on-demand requests (e.g. IP dossier modal).
 * If already cached with high accuracy, returns immediately.
 * Otherwise resolves directly from high-accuracy provider and saves to SQLite.
 */
async function resolveIpHighAccuracy(rawIp) {
  const ip = cleanIp(rawIp);
  if (!ip || isPrivateIp(ip)) return lookupIp(rawIp);

  const cached = getCachedGeoIp(ip);
  if (cached && !cached.source.includes('geoip-lite')) {
    geoCache.set(ip, cached);
    return cached;
  }

  try {
    const result = await fetchRemoteGeo(ip);
    geoCache.set(ip, result);
    setCachedGeoIp(result);
    return result;
  } catch (_err) {
    return lookupIp(rawIp);
  }
}

module.exports = {
  lookupIp,
  resolveIpHighAccuracy,
  cleanIp,
  isPrivateIp,
};
