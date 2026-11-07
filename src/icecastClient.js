const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const {
  parseIcecastClientsPayload,
  parseStatusJson,
  extractSourceMetaFromXml,
  xmlParser,
} = require('./parser');

/**
 * Performs an HTTP/HTTPS GET request to the Icecast server.
 * Supports direct connections (with optional self-signed TLS tolerance)
 * as well as HTTP CONNECT proxy if running in a proxied environment.
 */
function requestIcecastUrl(targetUrlStr, { username, password, ignoreTlsErrors = true, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrlStr);
    } catch (err) {
      return reject(new Error(`Invalid URL: ${targetUrlStr}`));
    }

    const authHeader =
      username || password
        ? 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64')
        : undefined;

    const headers = {
      'User-Agent': 'OzoneCast-Telemetry-Monitor/1.0',
      Accept: 'text/html,application/xhtml+xml,application/xml,application/json,*/*',
    };
    if (authHeader) {
      headers.Authorization = authHeader;
    }

    const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

    // If an HTTP proxy is configured in the environment and target is HTTPS, use HTTP CONNECT tunnel
    if (proxyEnv && parsedUrl.protocol === 'https:') {
      let proxyUrl;
      try {
        proxyUrl = new URL(proxyEnv);
      } catch (_) {
        proxyUrl = null;
      }

      if (proxyUrl) {
        const targetPort = parsedUrl.port || 443;
        const connectReq = http.request({
          host: proxyUrl.hostname,
          port: proxyUrl.port || 80,
          method: 'CONNECT',
          path: `${parsedUrl.hostname}:${targetPort}`,
          timeout: timeoutMs,
        });

        connectReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            return reject(
              new Error(
                `Outbound proxy returned HTTP ${res.statusCode} (${res.statusMessage || 'Forbidden'}) for ${parsedUrl.hostname}:${targetPort}`
              )
            );
          }

          const tlsReq = https.request(
            {
              host: parsedUrl.hostname,
              port: targetPort,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'GET',
              headers,
              socket,
              agent: false,
              rejectUnauthorized: !ignoreTlsErrors,
              timeout: timeoutMs,
            },
            tlsRes => {
              const chunks = [];
              tlsRes.on('data', c => chunks.push(c));
              tlsRes.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({ statusCode: tlsRes.statusCode, headers: tlsRes.headers, body });
              });
            }
          );

          tlsReq.on('error', err => reject(err));
          tlsReq.on('timeout', () => {
            tlsReq.destroy();
            reject(new Error('TLS request timed out'));
          });
          tlsReq.end();
        });

        connectReq.on('error', err => reject(err));
        connectReq.on('timeout', () => {
          connectReq.destroy();
          reject(new Error('Proxy CONNECT timed out'));
        });
        connectReq.end();
        return;
      }
    }

    // Direct HTTP or HTTPS request (standard when deployed on user's machine/server)
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers,
        rejectUnauthorized: !ignoreTlsErrors,
        timeout: timeoutMs,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      }
    );

    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Connection timed out to ${parsedUrl.host}`));
    });
    req.end();
  });
}

/**
 * Fetches live clients and stream metadata from the configured Icecast server.
 * Specifically targets:
 *   1. /admin/listclients.xsl?mount=/listen
 *   2. /admin/listclients?mount=/listen (XML fallback/enrichment)
 *   3. /status-json.xsl or /admin/stats (for stream metadata like song title & bitrate)
 */
async function fetchLiveIcecastTelemetry(config) {
  const baseUrl = String(config.baseUrl || 'https://live.ozone.fm:8443').replace(/\/+$/, '');
  const mount = config.mount?.startsWith('/') ? config.mount : `/${config.mount || 'listen'}`;
  const authOpts = {
    username: config.username,
    password: config.password,
    ignoreTlsErrors: config.ignoreTlsErrors !== false,
    timeoutMs: 6500,
  };

  const xslUrl = `${baseUrl}/admin/listclients.xsl?mount=${encodeURIComponent(mount)}`;
  const xmlUrl = `${baseUrl}/admin/listclients?mount=${encodeURIComponent(mount)}`;
  const statusJsonUrl = `${baseUrl}/status-json.xsl`;
  const adminStatsUrl = `${baseUrl}/admin/stats`;

  // Primary request: /admin/listclients.xsl?mount=/listen
  const xslResp = await requestIcecastUrl(xslUrl, authOpts);

  if (xslResp.statusCode === 401) {
    throw new Error('Icecast authentication failed (HTTP 401 Unauthorized). Check admin username and password.');
  }
  if (xslResp.statusCode === 403) {
    throw new Error(`HTTP 403 Forbidden from ${xslUrl}`);
  }
  if (xslResp.statusCode >= 400) {
    throw new Error(`Icecast returned HTTP ${xslResp.statusCode} for ${xslUrl}`);
  }

  let parsedClients = parseIcecastClientsPayload(xslResp.body, mount);

  // If XSL had 0 clients or we also want XML enrichment, try /admin/listclients?mount=...
  if (parsedClients.listeners.length === 0) {
    try {
      const xmlResp = await requestIcecastUrl(xmlUrl, authOpts);
      if (xmlResp.statusCode === 200) {
        const xmlParsed = parseIcecastClientsPayload(xmlResp.body, mount);
        if (xmlParsed.listeners.length >= parsedClients.listeners.length) {
          parsedClients = xmlParsed;
        }
      }
    } catch (_) {}
  }

  // Fetch stream metadata in parallel (non-blocking if it fails)
  let sourceMeta = parsedClients.sourceMeta || null;
  try {
    const [statusResp, statsResp] = await Promise.allSettled([
      requestIcecastUrl(statusJsonUrl, { ...authOpts, timeoutMs: 3500 }),
      requestIcecastUrl(adminStatsUrl, { ...authOpts, timeoutMs: 3500 }),
    ]);

    if (statusResp.status === 'fulfilled' && statusResp.value.statusCode === 200) {
      const metaJson = parseStatusJson(statusResp.value.body, mount);
      if (metaJson) sourceMeta = { ...sourceMeta, ...metaJson };
    }
    if (statsResp.status === 'fulfilled' && statsResp.value.statusCode === 200) {
      const parsedXml = xmlParser.parse(statsResp.value.body);
      const icestats = parsedXml?.icestats;
      if (icestats) {
        let sources = icestats.source || [];
        if (!Array.isArray(sources)) sources = [sources];
        const matched = sources.find(s => s && s['@_mount'] === mount) || sources[0];
        const xmlMeta = extractSourceMetaFromXml(matched);
        if (xmlMeta) {
          sourceMeta = {
            ...sourceMeta,
            ...Object.fromEntries(Object.entries(xmlMeta).filter(([_, v]) => v !== null)),
            serverId: icestats.server_id || sourceMeta?.serverId,
            host: icestats.host || sourceMeta?.host,
          };
        }
      }
    }
  } catch (_) {}

  return {
    listeners: parsedClients.listeners,
    reportedCount: parsedClients.reportedCount,
    format: parsedClients.format,
    endpointUsed: xslUrl,
    sourceMeta: {
      serverName: sourceMeta?.serverName || config.stationName || 'OZONE.FM',
      serverDescription: sourceMeta?.serverDescription || 'Icecast Live Stream',
      contentType: sourceMeta?.contentType || 'audio/mpeg',
      bitrate: sourceMeta?.bitrate || 320,
      samplerate: sourceMeta?.samplerate || 44100,
      channels: sourceMeta?.channels || 2,
      title: sourceMeta?.title || 'Live Broadcast Stream',
      genre: sourceMeta?.genre || 'Radio',
      listenerPeak: Math.max(sourceMeta?.listenerPeak || 0, parsedClients.listeners.length),
      maxListeners: sourceMeta?.maxListeners || config.maxListenersCapacity || 500,
      streamStart: sourceMeta?.streamStart || null,
      listenUrl: sourceMeta?.listenUrl || `${baseUrl}${mount}`,
      serverId: sourceMeta?.serverId || 'Icecast 2.4.x',
    },
  };
}

/**
 * Sends a kick request to Icecast Admin:
 * /admin/killclient.xsl?mount=/listen&id=<clientId>
 */
async function kickLiveIcecastClient(config, clientId, mountOverride) {
  const baseUrl = String(config.baseUrl || 'https://live.ozone.fm:8443').replace(/\/+$/, '');
  const mount = mountOverride || (config.mount?.startsWith('/') ? config.mount : `/${config.mount || 'listen'}`);
  const kickUrl = `${baseUrl}/admin/killclient.xsl?mount=${encodeURIComponent(mount)}&id=${encodeURIComponent(clientId)}`;

  const resp = await requestIcecastUrl(kickUrl, {
    username: config.username,
    password: config.password,
    ignoreTlsErrors: config.ignoreTlsErrors !== false,
    timeoutMs: 5000,
  });

  if (resp.statusCode >= 400) {
    throw new Error(`Kick failed with HTTP ${resp.statusCode}`);
  }
  return { ok: true, kickUrl };
}

module.exports = {
  fetchLiveIcecastTelemetry,
  kickLiveIcecastClient,
  requestIcecastUrl,
};
