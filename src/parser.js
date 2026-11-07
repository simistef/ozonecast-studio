const cheerio = require('cheerio');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true,
});

function isIpToken(str) {
  if (!str) return false;
  const s = String(str).trim().replace(/^\[|\]$/g, '');
  const cleanV4 = s.replace(/^::ffff:/i, '');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(cleanV4)) return true;
  // IPv6 check (e.g. 2a02:2f0e:..., fe80::..., ::1)
  if (s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s) && s.split(':').length >= 3) return true;
  return false;
}

function parseDurationValue(str) {
  const s = String(str || '').trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^\d+s$/i.test(s)) return parseInt(s, 10);
  const clock = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    if (clock[3] !== undefined) {
      return parseInt(clock[1], 10) * 3600 + parseInt(clock[2], 10) * 60 + parseInt(clock[3], 10);
    }
    return parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
  }
  const num = parseInt(s.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Parses an Icecast User-Agent string into structured telemetry
 */
function parseUserAgent(uaRaw) {
  const ua = String(uaRaw || 'Unknown Client').trim();
  const lower = ua.toLowerCase();

  if (lower.includes('audioaccessory5,')) {
    return {
      raw: ua,
      player: 'Apple HomePod mini',
      category: 'Smart Speaker',
      os: 'HomePod Software (audioOS)',
      isRipper: false,
    };
  }
  if (lower.includes('audioaccessory') || lower.includes('homepod')) {
    return {
      raw: ua,
      player: 'Apple HomePod',
      category: 'Smart Speaker',
      os: 'HomePod Software (audioOS)',
      isRipper: false,
    };
  }
  if (lower.includes('appletv') || lower.includes('apple tv')) {
    return {
      raw: ua,
      player: 'Apple TV',
      category: 'Smart Speaker',
      os: 'tvOS',
      isRipper: false,
    };
  }

  let player = 'Custom Audio Client';
  let category = 'Other Audio Client';
  let os = 'Unknown';
  let isRipper = false;

  if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('ipod') || lower.includes('cpu os')) {
    os = 'iOS';
  } else if (lower.includes('android') || lower.includes('dalvik') || lower.includes('stagefright') || lower.includes('exoplayer')) {
    os = 'Android';
  } else if (lower.includes('windows nt') || lower.includes('win64') || lower.includes('win32') || lower.includes('windows')) {
    os = 'Windows';
  } else if (lower.includes('mac os x') || lower.includes('macintosh') || lower.includes('darwin')) {
    os = 'macOS';
  } else if (lower.includes('linux') || lower.includes('ubuntu') || lower.includes('debian') || lower.includes('alsa') || lower.includes('pulseaudio')) {
    os = 'Linux';
  } else if (lower.includes('sonos') || lower.includes('alexa') || lower.includes('echoshow') || lower.includes('crkey') || lower.includes('chromecast') || lower.includes('bose') || lower.includes('squeezebox')) {
    os = 'Hardware / Embedded';
  }

  if (
    lower.includes('streamripper') ||
    (lower.includes('icy-metadata') && lower.includes('wget')) ||
    lower.includes('curl/') ||
    lower.includes('python-urllib') ||
    lower.includes('python-requests') ||
    lower.includes('go-http-client')
  ) {
    player = ua.split('/')[0] || 'Stream Ripper / CLI';
    category = 'Bot / Ripper';
    isRipper = true;
  } else if (lower.includes('vlc') || lower.includes('libvlc')) {
    const match = ua.match(/(?:VLC|LibVLC)[/\s]([\d.]+)/i);
    player = match ? `VLC ${match[1].split('.').slice(0, 2).join('.')}` : 'VLC Media Player';
    category = 'Desktop Player';
    if (os === 'Unknown') os = 'Desktop';
  } else if (lower.includes('winamp') || lower.includes('nsplayer')) {
    player = 'Winamp';
    category = 'Desktop Player';
    if (os === 'Unknown') os = 'Windows';
  } else if (lower.includes('foobar2000')) {
    player = 'foobar2000';
    category = 'Desktop Player';
    if (os === 'Unknown') os = 'Windows';
  } else if (lower.includes('aimp')) {
    player = 'AIMP';
    category = 'Desktop Player';
    if (os === 'Unknown') os = 'Windows';
  } else if (lower.includes('musicbee')) {
    player = 'MusicBee';
    category = 'Desktop Player';
    if (os === 'Unknown') os = 'Windows';
  } else if (lower.includes('itunes')) {
    player = 'iTunes / Apple Music';
    category = 'Desktop Player';
  } else if (lower.includes('mpv') || lower.includes('mplayer')) {
    player = 'mpv / MPlayer';
    category = 'Desktop Player';
  } else if (lower.includes('lavf/') || lower.includes('ffmpeg')) {
    player = 'FFmpeg / Lavf Player';
    category = 'Desktop Player';
  } else if (lower.includes('gstreamer')) {
    player = 'GStreamer Audio';
    category = 'Desktop Player';
  } else if (lower.includes('sonos')) {
    player = 'Sonos Wireless HiFi';
    category = 'Smart Speaker';
    os = 'Hardware / Embedded';
  } else if (lower.includes('airplay')) {
    player = 'Apple AirPlay / HomePod';
    category = 'Smart Speaker';
    os = 'HomePod / AirPlay';
  } else if (lower.includes('tunein')) {
    player = 'TuneIn Radio';
    category = 'Mobile / Native';
  } else if (lower.includes('radiogarden') || lower.includes('radio garden')) {
    player = 'Radio Garden';
    category = 'Mobile / Native';
  } else if (lower.includes('alexa') || lower.includes('echo')) {
    player = 'Amazon Alexa';
    category = 'Smart Speaker';
    os = 'Hardware / Embedded';
  } else if (lower.includes('crkey') || lower.includes('chromecast') || lower.includes('googlecast')) {
    player = 'Google Cast / Home';
    category = 'Smart Speaker';
    os = 'Hardware / Embedded';
  } else if (lower.includes('applecoremedia')) {
    player = os === 'macOS' ? 'Apple CoreMedia (macOS)' : 'Apple CoreMedia (iOS / HomePod)';
    category = 'Mobile / Native';
    if (os === 'Unknown') os = 'iOS / audioOS';
  } else if (lower.includes('exoplayer') || lower.includes('stagefright') || lower.includes('androidx.media3')) {
    player = 'Android ExoPlayer';
    category = 'Mobile / Native';
    os = 'Android';
  } else if (lower.includes('cfnetwork') && lower.includes('darwin')) {
    player = 'Apple Native Streamer';
    category = 'Mobile / Native';
    if (os === 'Unknown') os = 'iOS / macOS';
  } else if (lower.includes('edg/') || lower.includes('edge/')) {
    player = 'Microsoft Edge (Web)';
    category = 'Web Browser';
  } else if (lower.includes('opr/') || lower.includes('opera')) {
    player = 'Opera (Web)';
    category = 'Web Browser';
  } else if (lower.includes('firefox/')) {
    player = 'Firefox (Web)';
    category = 'Web Browser';
  } else if (lower.includes('chrome/') && !lower.includes('edg/')) {
    player = os === 'Android' ? 'Chrome Mobile (Web)' : 'Chrome (Web)';
    category = 'Web Browser';
  } else if (lower.includes('safari/') && !lower.includes('chrome/')) {
    player = os === 'iOS' ? 'Mobile Safari (Web)' : 'Safari (Web)';
    category = 'Web Browser';
  } else if (lower.includes('mozilla/')) {
    player = 'HTML5 Web Player';
    category = 'Web Browser';
  } else if (ua.length > 0 && ua !== 'Unknown Client') {
    player = ua.split(' ')[0].slice(0, 28);
  }

  return {
    raw: ua,
    player,
    category,
    os,
    isRipper,
  };
}

/**
 * Universal parser for Icecast /admin/listclients.xsl:
 * Supports XML, HTML tables, single-line tab/space copy-paste, and multi-line cell copy-paste,
 * across IPv4, ::ffff:IPv4, and IPv6 addresses.
 */
function parseIcecastClientsPayload(bodyText, targetMount = '/listen') {
  const text = String(bodyText || '').trim();
  if (!text) {
    return { listeners: [], reportedCount: 0, format: 'empty' };
  }

  // 1. Check XML format
  if (text.startsWith('<?xml') || text.startsWith('<icestats') || (text.includes('<icestats') && text.includes('<listener'))) {
    try {
      const parsed = xmlParser.parse(text);
      const icestats = parsed.icestats || parsed;
      let sources = icestats.source || [];
      if (!Array.isArray(sources)) sources = [sources];

      let matchedSource = sources.find(s => s && s['@_mount'] === targetMount) || sources[0];
      if (matchedSource) {
        let rawListeners = matchedSource.listener || [];
        if (!Array.isArray(rawListeners)) rawListeners = [rawListeners];

        const listeners = rawListeners
          .filter(Boolean)
          .map((item, idx) => {
            const ip = String(item.IP || item.ip || '').trim().replace(/^::ffff:/i, '');
            const connectedSec = parseInt(item.Connected ?? item.connected ?? 0, 10) || 0;
            const userAgent = String(item.UserAgent || item.useragent || item['User-Agent'] || 'Unknown').trim();
            const id = String(item.ID ?? item.id ?? item['@_id'] ?? `${1000 + idx}`);
            return {
              clientId: id,
              ip,
              connectedSeconds: connectedSec,
              userAgent,
              lag: parseInt(item.lag ?? 0, 10) || 0,
              mount: matchedSource['@_mount'] || targetMount,
            };
          })
          .filter(l => l.ip);

        if (listeners.length > 0) {
          return {
            listeners,
            reportedCount: parseInt(matchedSource.Listeners ?? matchedSource.listeners ?? listeners.length, 10) || listeners.length,
            format: 'xml',
            sourceMeta: extractSourceMetaFromXml(matchedSource),
          };
        }
      }
    } catch (_) {}
  }

  // 2. Check HTML table format
  if (text.includes('<tr') || text.includes('<td') || text.includes('<table')) {
    const $ = cheerio.load(text);
    const listeners = [];

    $('tr').each((rIdx, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 2) return;

      const col0 = $(cells[0]).text().trim();
      if (!isIpToken(col0)) return;

      const col1 = $(cells[1]).text().trim();
      const col2 = cells.length >= 3 ? $(cells[2]).text().trim() : 'Unknown Client';

      let clientId = `${1000 + listeners.length}`;
      let mountFromLink = targetMount;
      $(tr)
        .find('a')
        .each((__, a) => {
          const href = $(a).attr('href') || '';
          const idMatch = href.match(/[?&]id=([^&]+)/i);
          if (idMatch) clientId = idMatch[1];
          const mountMatch = href.match(/[?&]mount=([^&]+)/i);
          if (mountMatch) mountFromLink = decodeURIComponent(mountMatch[1]);
        });

      listeners.push({
        clientId: String(clientId),
        ip: col0.replace(/^::ffff:/i, ''),
        connectedSeconds: parseDurationValue(col1),
        userAgent: col2 || 'Unknown Client',
        lag: 0,
        mount: mountFromLink,
      });
    });

    if (listeners.length > 0) {
      return {
        listeners,
        reportedCount: listeners.length,
        format: 'xsl-html',
      };
    }
  }

  // 3. Universal Plain-Text Parser (Ctrl+A / Ctrl+C from browser across Chrome, Safari, Firefox)
  const plainListeners = [];
  const rawLines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^(IP|Sec\.\s*connected|Connected|User\s*Agent|Action|Mountpoint|List\s*Clients)/i.test(l));

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const tokens = line.split(/\s+/);
    const firstToken = tokens[0];

    if (!isIpToken(firstToken)) continue;
    const cleanIp = firstToken.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');

    // Case A: IP + Seconds + UserAgent on the same line (tab or space separated)
    if (tokens.length >= 2 && (/^\d+$/.test(tokens[1]) || /^\d+:\d+/.test(tokens[1]))) {
      const sec = parseDurationValue(tokens[1]);
      let uaTokens = tokens.slice(2);
      // If Icecast-KH has a numeric Lag column right after Connected seconds
      if (uaTokens.length >= 2 && /^\d+$/.test(uaTokens[0])) {
        uaTokens = uaTokens.slice(1);
      }
      let ua = uaTokens.join(' ').replace(/\s*(?:Kick|Delete|Kill)\s*$/i, '').trim();
      if (!ua) ua = 'Audio Stream Client';
      plainListeners.push({
        clientId: String(1000 + plainListeners.length),
        ip: cleanIp,
        connectedSeconds: sec,
        userAgent: ua,
        lag: 0,
        mount: targetMount,
      });
      continue;
    }

    // Case B: Multi-line copy where IP is on line i, Seconds is on line i+1, User-Agent on line i+2
    if (tokens.length === 1 && i + 1 < rawLines.length && (/^\d+$/.test(rawLines[i + 1]) || /^\d+:\d+/.test(rawLines[i + 1]))) {
      const sec = parseDurationValue(rawLines[i + 1]);
      let ua = 'Audio Stream Client';
      let advance = 1;
      if (i + 2 < rawLines.length && !isIpToken(rawLines[i + 2].split(/\s+/)[0]) && !/^(Kick|Delete)$/i.test(rawLines[i + 2])) {
        ua = rawLines[i + 2].replace(/\s*(?:Kick|Delete)\s*$/i, '').trim();
        advance = 2;
        if (i + 3 < rawLines.length && /^(Kick|Delete)$/i.test(rawLines[i + 3])) {
          advance = 3;
        }
      }
      plainListeners.push({
        clientId: String(1000 + plainListeners.length),
        ip: cleanIp,
        connectedSeconds: sec,
        userAgent: ua,
        lag: 0,
        mount: targetMount,
      });
      i += advance;
      continue;
    }

    // Case C: Line has IP and User-Agent without numeric seconds
    if (tokens.length >= 2) {
      const ua = tokens.slice(1).join(' ').replace(/\s*(?:Kick|Delete)\s*$/i, '').trim();
      plainListeners.push({
        clientId: String(1000 + plainListeners.length),
        ip: cleanIp,
        connectedSeconds: 60,
        userAgent: ua || 'Audio Stream Client',
        lag: 0,
        mount: targetMount,
      });
    }
  }

  return {
    listeners: plainListeners,
    reportedCount: plainListeners.length,
    format: plainListeners.length > 0 ? 'plain-text' : 'empty',
  };
}

function extractSourceMetaFromXml(source) {
  if (!source) return null;
  return {
    serverName: source.server_name || null,
    serverDescription: source.server_description || null,
    contentType: source.server_type || source.content_type || null,
    bitrate: parseInt(source.bitrate || source['ice-bitrate'] || 0, 10) || null,
    samplerate: parseInt(source.samplerate || source['ice-samplerate'] || 0, 10) || null,
    channels: parseInt(source.channels || source['ice-channels'] || 0, 10) || null,
    title: source.title ? (source.artist ? `${source.artist} - ${source.title}` : String(source.title)) : null,
    genre: source.genre || null,
    listenerPeak: parseInt(source.listener_peak || 0, 10) || null,
    maxListeners: source.max_listeners === 'unlimited' ? null : (parseInt(source.max_listeners || 0, 10) || null),
    streamStart: source.stream_start_iso8601 || source.stream_start || null,
    listenUrl: source.listenurl || null,
    totalBytesRead: parseInt(source.total_bytes_read || 0, 10) || null,
    totalBytesSent: parseInt(source.total_bytes_sent || 0, 10) || null,
  };
}

function parseStatusJson(jsonData, targetMount = '/listen') {
  try {
    const obj = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    const icestats = obj?.icestats;
    if (!icestats) return null;
    let sources = icestats.source || [];
    if (!Array.isArray(sources)) sources = [sources];
    const matched =
      sources.find(s => s?.listenurl?.endsWith(targetMount) || s?.mount === targetMount) ||
      sources[0];
    if (!matched) return null;

    return {
      serverName: matched.server_name || 'Ozone.FM Live Stream',
      serverDescription: matched.server_description || '',
      contentType: matched.server_type || 'audio/mpeg',
      bitrate: parseInt(matched.bitrate || matched['ice-bitrate'] || 128, 10) || 128,
      samplerate: parseInt(matched.samplerate || 44100, 10) || 44100,
      title: matched.title
        ? matched.artist
          ? `${matched.artist} - ${matched.title}`
          : String(matched.title)
        : matched.yp_currently_playing || null,
      genre: matched.genre || 'Electronic / Radio',
      listenerPeak: parseInt(matched.listener_peak || 0, 10) || null,
      listeners: parseInt(matched.listeners || 0, 10) || 0,
      maxListeners: matched.max_listeners === 'unlimited' ? null : (parseInt(matched.max_listeners || 0, 10) || null),
      streamStart: matched.stream_start_iso8601 || matched.stream_start || null,
      listenUrl: matched.listenurl || null,
      serverId: icestats.server_id || 'Icecast 2.4.4',
      host: icestats.host || 'live.ozone.fm',
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  parseUserAgent,
  parseIcecastClientsPayload,
  parseStatusJson,
  extractSourceMetaFromXml,
  xmlParser,
};
