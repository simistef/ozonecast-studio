const geoip = require('geoip-lite');

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

function lookupIp(rawIp) {
  const ip = cleanIp(rawIp);
  if (!ip) {
    return {
      ip: '0.0.0.0',
      countryCode: 'XX',
      countryName: 'Unknown',
      region: '',
      city: 'Unknown',
      lat: 0,
      lon: 0,
      timezone: 'UTC',
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
      lat: 44.4268,
      lon: 26.1025,
      timezone: 'Europe/Bucharest',
      isLocal: true,
    };
    geoCache.set(ip, localResult);
    return localResult;
  }

  const record = geoip.lookup(ip);
  if (!record) {
    const unknownResult = {
      ip,
      countryCode: 'UN',
      countryName: 'Unresolved Region',
      region: '',
      city: 'Unknown City',
      lat: 46.2,
      lon: 15.0,
      timezone: 'UTC',
      isLocal: false,
    };
    geoCache.set(ip, unknownResult);
    return unknownResult;
  }

  const countryCode = record.country || 'UN';
  let countryName = COUNTRY_NAMES[countryCode] || countryCode;
  try {
    if (!COUNTRY_NAMES[countryCode] && typeof Intl !== 'undefined' && Intl.DisplayNames) {
      const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
      countryName = displayNames.of(countryCode) || countryCode;
    }
  } catch (_) {}

  const ll = Array.isArray(record.ll) && record.ll.length === 2 ? record.ll : [0, 0];

  const result = {
    ip,
    countryCode,
    countryName,
    region: record.region || '',
    city: record.city || countryName,
    lat: Number(ll[0]) || 0,
    lon: Number(ll[1]) || 0,
    timezone: record.timezone || 'UTC',
    isLocal: false,
  };

  if (geoCache.size > 5000) {
    const firstKey = geoCache.keys().next().value;
    geoCache.delete(firstKey);
  }
  geoCache.set(ip, result);
  return result;
}

module.exports = {
  lookupIp,
  cleanIp,
};
