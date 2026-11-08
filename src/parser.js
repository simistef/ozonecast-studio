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
  const ua = String(uaRaw || 'Unknown Client').replace(/\s+/g, ' ').trim();
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
  if (/^music\/[\d.]+/i.test(ua) && lower.includes('ios/')) {
    const iosVer = ua.match(/iOS\/([\d.]+)/i)?.[1];
    return {
      raw: ua,
      player: 'Apple Music / HomePod',
      category: 'Smart Speaker',
      os: iosVer ? `iOS / audioOS (${iosVer})` : 'iOS / audioOS',
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

  if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('ipod') || lower.includes('cpu os') || lower.includes('ios/')) {
    os = 'iOS';
  } else if (lower.includes('android') || lower.includes('dalvik') || lower.includes('stagefright') || lower.includes('exoplayer')) {
    const andVer = ua.match(/Android\s+([\d.]+)/i)?.[1];
    os = andVer ? `Android ${andVer}` : 'Android';
  } else if (lower.includes('windows nt') || lower.includes('win64') || lower.includes('win32') || lower.includes('windows')) {
    os = 'Windows';
  } else if (lower.includes('mac os x') || lower.includes('macintosh') || lower.includes('darwin')) {
    os = 'macOS';
  } else if (lower.includes('linux') || lower.includes('ubuntu') || lower.includes('debian') || lower.includes('alsa') || lower.includes('pulseaudio')) {
    os = 'Linux';
  } else if (lower.includes('sonos') || lower.includes('alexa') || lower.includes('echoshow') || lower.includes('crkey') || lower.includes('chromecast') || lower.includes('bose') || lower.includes('squeezebox')) {
    os = 'Hardware / Embedded';
  }

  // Bots, crawlers, uptime monitors, and stream monitors first (before generic Mozilla/Chrome checks)
  if (lower.includes('hisbot') || lower.includes('onlineradiobox')) {
    player = 'OnlineRadioBox (ORB Bot)';
    category = 'Bot / Ripper';
    if (os === 'Unknown') os = 'Linux';
    isRipper = true;
  } else if (
    lower.includes('uptimerobot') ||
    lower.includes('pingdom') ||
    lower.includes('statuscake') ||
    lower.includes('zabbix') ||
    lower.includes('prometheus') ||
    lower.includes('nagios') ||
    lower.includes('site24x7') ||
    lower.includes('nodeping') ||
    lower.includes('freshping') ||
    lower.includes('betteruptime') ||
    lower.includes('hetrixtools') ||
    lower.includes('healthcheck')
  ) {
    const probeMatch = ua.match(/([A-Za-z0-9_-]*(?:Uptime|Pingdom|StatusCake|Monitor|Probe|Check)[A-Za-z0-9_-]*)/i);
    player = probeMatch ? `${probeMatch[1]} Monitor` : 'Uptime Health Monitor';
    category = 'Bot / Ripper';
    os = 'Monitor / Probe';
    isRipper = true;
  } else if (lower.includes('radio-browser') || lower.includes('streamcheck') || lower.includes('icecastcheck') || lower.includes('vtuner')) {
    player = 'Directory Indexer / Stream Check';
    category = 'Bot / Ripper';
    os = 'Aggregator Bot';
    isRipper = true;
  } else if (
    lower.includes('claudebot') ||
    lower.includes('gptbot') ||
    lower.includes('googlebot') ||
    lower.includes('bingbot') ||
    lower.includes('yandexbot') ||
    lower.includes('ahrefsbot') ||
    lower.includes('semrushbot') ||
    lower.includes('mj12bot') ||
    lower.includes('petalsearch') ||
    lower.includes('applebot') ||
    lower.includes('bytespider') ||
    lower.includes('duckduckbot') ||
    lower.includes('crawler') ||
    lower.includes('spider') ||
    lower.includes('scraper') ||
    /\b(bot|crawler|spider)\b/i.test(ua)
  ) {
    const botMatch = ua.match(/([A-Za-z0-9_-]*(?:Bot|Spider|Crawler))\b/i);
    player = botMatch ? `${botMatch[1]}` : 'Web Crawler Bot';
    category = 'Bot / Ripper';
    os = 'Crawler / Bot';
    isRipper = true;
  } else if (
    lower.includes('streamripper') ||
    (lower.includes('icy-metadata') && lower.includes('wget')) ||
    lower.includes('curl/') ||
    lower.includes('wget') ||
    lower.includes('python-urllib') ||
    lower.includes('python-requests') ||
    lower.includes('go-http-client') ||
    lower.includes('okhttp') ||
    lower.includes('aiohttp') ||
    lower.includes('node-fetch') ||
    lower.includes('axios') ||
    lower.includes('got/') ||
    lower.includes('needle/') ||
    lower.includes('libwww-perl') ||
    lower.includes('httpclient')
  ) {
    player = ua.split('/')[0] || 'Stream Ripper / CLI';
    category = 'Bot / Ripper';
    isRipper = true;
  } else if (lower.includes('simpleradio') || lower.includes('com.simpleradio')) {
    player = 'Simple Radio App';
    category = 'Mobile / Native';
    if (os === 'Unknown') os = 'Mobile (iOS / Android)';
  } else if (lower.includes('radioexpert.net') || lower.includes('radioexpert')) {
    player = 'RadioExpert.net App';
    category = 'Mobile / Native';
  } else if (lower.includes('dalvik/')) {
    const modelMatch = ua.match(/;\s*([^;)]+?)\s+Build\//i);
    player = modelMatch ? `Android Audio (${modelMatch[1].trim()})` : 'Android Native Audio';
    category = 'Mobile / Native';
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
    const verMatch = ua.match(/Lavf\/([\d.]+)/i);
    player = verMatch ? `FFmpeg / Lavf ${verMatch[1]}` : 'FFmpeg / Lavf Player';
    category = 'Desktop Player';
    if (os === 'Unknown') os = 'Linux / Stream';
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
  } else if (lower.includes('myradiobox') || lower.includes('my tuner') || lower.includes('mytuner')) {
    player = 'myTuner Radio';
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
    player = os.startsWith('Android') ? 'Chrome Mobile (Web)' : 'Chrome (Web)';
    category = 'Web Browser';
  } else if (lower.includes('safari/') && !lower.includes('chrome/')) {
    player = os === 'iOS' ? 'Mobile Safari (Web)' : 'Safari (Web)';
    category = 'Web Browser';
  } else if (lower.includes('mozilla/')) {
    player = 'HTML5 Web Player';
    category = 'Web Browser';
  } else if (ua.length > 0 && ua !== 'Unknown Client' && lower !== 'anonymous') {
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

function isIgnoredRoleOrActionCell(val) {
  if (!val) return true;
  const s = String(val).replace(/\s+/g, ' ').trim();
  if (!s || s === '-' || s === '—') return true;
  if (/^(anonymous|admin|source|relay|kick|move|delete|kill|kick\s+move|move\s+kick)$/i.test(s)) return true;
  return false;
}

/**
 * Universal parser for Icecast /admin/listclients.xsl:
 * Supports XML, 4-column and 7-column HTML tables (ignoring Username & Role="anonymous"),
 * single-line tab/space copy-paste, and multi-line cell copy-paste,
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
            const userAgent = String(item.UserAgent || item.useragent || item['User-Agent'] || 'Unknown').replace(/\s+/g, ' ').trim();
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

  // 2. Check HTML table format (supports both 4-column Icecast and 7-column Icecast with Username/Role/Location)
  if (text.includes('<tr') || text.includes('<td') || text.includes('<table')) {
    const $ = cheerio.load(text);
    const listeners = [];

    $('table').each((_, table) => {
      // Detect header column indices if present (IP | Username | Role | Sec. connected | User Agent | Location | Action)
      let ipColIdx = 0;
      let secColIdx = null;
      let uaColIdx = null;

      $(table)
        .find('tr')
        .each((__, tr) => {
          const headerCells = $(tr).find('th, td');
          if (headerCells.length < 3) return;
          const texts = headerCells
            .map((___, c) => $(c).text().replace(/\s+/g, ' ').trim().toLowerCase())
            .get();
          if (texts[0] === 'ip' || texts.some(t => t.includes('sec. connected') || t.includes('user agent'))) {
            texts.forEach((h, idx) => {
              if (h === 'ip' || h === 'ip address') ipColIdx = idx;
              else if (h.includes('sec') || h.includes('connected') || h === 'duration') secColIdx = idx;
              else if (h.includes('user agent') || h.includes('user-agent') || h === 'agent') uaColIdx = idx;
            });
          }
        });

      $(table)
        .find('tr')
        .each((rIdx, tr) => {
          const cells = $(tr).find('td');
          if (cells.length < 2) return;

          const cellTexts = cells
            .map((__, c) => $(c).text().replace(/\s+/g, ' ').trim())
            .get();

          const rawIp = cellTexts[ipColIdx] || cellTexts[0];
          if (!isIpToken(rawIp)) return;

          let connectedSec = 0;
          let userAgent = '';

          // Strategy A: Use detected header indices if valid
          if (
            secColIdx !== null &&
            secColIdx < cellTexts.length &&
            /^\d+$/.test(cellTexts[secColIdx])
          ) {
            connectedSec = parseDurationValue(cellTexts[secColIdx]);
          }
          if (
            uaColIdx !== null &&
            uaColIdx < cellTexts.length &&
            !isIgnoredRoleOrActionCell(cellTexts[uaColIdx])
          ) {
            userAgent = cellTexts[uaColIdx];
          }

          // Strategy B: Cell-content scan (skips empty Username, "anonymous" Role, and "Kick/Move" Action)
          if (!connectedSec || !userAgent) {
            let foundSecIdx = -1;
            for (let cIdx = 1; cIdx < cellTexts.length; cIdx++) {
              const val = cellTexts[cIdx];
              if (!val || isIgnoredRoleOrActionCell(val)) continue;
              if (foundSecIdx === -1 && (/^\d+$/.test(val) || /^\d+:\d+(?::\d+)?$/.test(val))) {
                foundSecIdx = cIdx;
                if (!connectedSec) connectedSec = parseDurationValue(val);
                continue;
              }
              if (!userAgent && !/^\d+$/.test(val)) {
                userAgent = val;
                break;
              }
            }
          }

          // Strip any trailing Kick / Move text if merged
          userAgent = userAgent.replace(/\s*(?:Kick|Move|Delete|Kill)(?:\s+(?:Kick|Move|Delete|Kill))*\s*$/i, '').trim();
          if (!userAgent || isIgnoredRoleOrActionCell(userAgent)) {
            userAgent = 'Unknown Client';
          }

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
            ip: rawIp.replace(/^::ffff:/i, ''),
            connectedSeconds: connectedSec,
            userAgent,
            lag: 0,
            mount: mountFromLink,
          });
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
    .filter(
      l =>
        l.length > 0 &&
        !/^(IP|Username|Role|Sec\.\s*connected|connected|User\s*Agent|Location|Action|Mountpoint|List\s*Clients|Listeners|Move|Kick|anonymous)$/i.test(l)
    );

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    let tokens = line.split(/\s+/);
    const firstToken = tokens[0];

    if (!isIpToken(firstToken)) continue;
    const cleanIp = firstToken.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');

    // Remove "anonymous" role token if it appears right after IP
    let restTokens = tokens.slice(1).filter((t, idx) => !(idx === 0 && /^anonymous$/i.test(t)));

    // Case A: IP + [anonymous] + Seconds + UserAgent on the same line (tab or space separated)
    if (restTokens.length >= 1 && (/^\d+$/.test(restTokens[0]) || /^\d+:\d+/.test(restTokens[0]))) {
      const sec = parseDurationValue(restTokens[0]);
      let uaTokens = restTokens.slice(1);
      if (uaTokens.length >= 2 && /^\d+$/.test(uaTokens[0])) {
        uaTokens = uaTokens.slice(1);
      }
      let ua = uaTokens
        .join(' ')
        .replace(/\s*(?:Kick|Move|Delete|Kill)(?:\s+(?:Kick|Move|Delete|Kill))*\s*$/i, '')
        .trim();
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

    // Case B: Multi-line copy where IP is on line i, Seconds is on line i+1, User-Agent on line i+2 (and possibly wrapped across lines)
    if (restTokens.length === 0 && i + 1 < rawLines.length && (/^\d+$/.test(rawLines[i + 1]) || /^\d+:\d+/.test(rawLines[i + 1]))) {
      const sec = parseDurationValue(rawLines[i + 1]);
      const uaParts = [];
      let cursor = i + 2;
      while (cursor < rawLines.length) {
        const nextLine = rawLines[cursor];
        if (isIpToken(nextLine.split(/\s+/)[0])) break;
        const cleaned = nextLine.replace(/\s*(?:Kick|Move|Delete|Kill)(?:\s+(?:Kick|Move|Delete|Kill))*\s*$/i, '').trim();
        if (cleaned && !/^(Kick|Move|Delete|Kill|anonymous)$/i.test(cleaned)) {
          uaParts.push(cleaned);
        }
        cursor++;
      }
      plainListeners.push({
        clientId: String(1000 + plainListeners.length),
        ip: cleanIp,
        connectedSeconds: sec,
        userAgent: uaParts.join(' ') || 'Audio Stream Client',
        lag: 0,
        mount: targetMount,
      });
      i = cursor - 1;
      continue;
    }

    // Case C: Line has IP and User-Agent without numeric seconds
    if (restTokens.length >= 1) {
      const ua = restTokens
        .join(' ')
        .replace(/\s*(?:Kick|Move|Delete|Kill)(?:\s+(?:Kick|Move|Delete|Kill))*\s*$/i, '')
        .trim();
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

/**
 * Builds a composite device/agent key for a listener connection.
 * If multiple connections share the same IP and the same player user agent, they share the same key (count as 1).
 * Separate players or user-agents on the same IP produce different keys and are counted separately.
 */
function getListenerDeviceKey(l) {
  const ip = String(l.ip || '').trim();
  const player = (l.ua?.player && l.ua.player !== 'Audio Client' && l.ua.player !== 'Unknown')
    ? l.ua.player.trim().toLowerCase()
    : '';
  const os = (l.ua?.os && l.ua.os !== 'Unknown')
    ? l.ua.os.trim().toLowerCase()
    : '';
  const ua = String(l.userAgent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const agentKey = (player || os) ? `${player}::${os}` : ua;
  return `${ip}::${agentKey}`;
}

/**
 * Deduplicates listener stream connections by (IP + Player / User-Agent).
 * Multiple simultaneous connections from the same IP with the same player/UA combine into 1 listener.
 * Connections from the same IP with different players or agents remain distinct listeners.
 */
function deduplicateListenersByDevice(listeners) {
  const map = new Map();
  for (const l of listeners || []) {
    const key = getListenerDeviceKey(l);
    if (!map.has(key)) {
      map.set(key, {
        ...l,
        streamCount: 1,
        streams: [l],
        allClientIds: [String(l.clientId)],
        connectionsFromIp: l.connectionsFromIp || 1,
      });
    } else {
      const existing = map.get(key);
      existing.streamCount++;
      existing.streams.push(l);
      existing.allClientIds.push(String(l.clientId));
      if ((l.connectedSeconds || 0) > (existing.connectedSeconds || 0)) {
        existing.connectedSeconds = l.connectedSeconds;
        existing.clientId = l.clientId;
      }
      existing.connectionsFromIp = Math.max(existing.connectionsFromIp || 1, existing.streams.length);
    }
  }
  return Array.from(map.values());
}

module.exports = {
  parseUserAgent,
  parseIcecastClientsPayload,
  parseStatusJson,
  extractSourceMetaFromXml,
  xmlParser,
  getListenerDeviceKey,
  deduplicateListenersByDevice,
};
