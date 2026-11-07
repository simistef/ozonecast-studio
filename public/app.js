(function () {
  let dashboardState = null;
  let lastFetchClientTime = Date.now();
  let selectedRangeMinutes = 60;
  let mapViewMode = 'europe'; // 'europe' | 'romania' | 'world'
  let geoTabMode = 'countries'; // 'countries' | 'cities'
  let rightMidTabMode = 'retention'; // 'retention' | 'events'
  let tableSearchQuery = '';
  let tableCategoryFilter = 'ALL';
  let tableSortField = 'connectedSeconds';
  let tableSortAsc = false;
  let frontendPollTimer = null;
  let vuAnimationTimer = null;

  // Format seconds into HH:MM:SS or Xh Ym Zs
  function formatDurationClock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const pad = n => String(n).padStart(2, '0');
    if (hrs > 0) {
      return `${hrs}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  }

  function formatDurationHuman(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) return `${hrs}h ${String(mins).padStart(2, '0')}m`;
    if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`;
    return `${secs}s`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isoToFlagEmoji(cc) {
    const code = String(cc || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || code === 'UN' || code === 'XX' || code === 'LO') return '🌐';
    return String.fromCodePoint(...code.split('').map(c => 127397 + c.charCodeAt(0)));
  }

  function renderCountryFlag(cc, countryName = '', size = 18) {
    const code = String(cc || '').trim().toLowerCase();
    const emoji = isoToFlagEmoji(cc);
    const titleAttr = escapeHtml(countryName ? `${countryName} (${code.toUpperCase()})` : code.toUpperCase());
    if (!/^[a-z]{2}$/.test(code) || code === 'un' || code === 'xx' || code === 'lo') {
      return `<span class="country-flag-badge" title="${titleAttr}" style="font-size:${size - 2}px;line-height:1">${emoji}</span>`;
    }
    const h = Math.round(size * 0.75);
    return `<img class="country-flag-img" src="https://flagcdn.com/24x18/${code}.png" srcset="https://flagcdn.com/48x36/${code}.png 2x" width="${size}" height="${h}" alt="${emoji}" title="${titleAttr}" loading="lazy" style="border-radius:2px;vertical-align:middle;object-fit:cover;box-shadow:0 0 0 1px rgba(255,255,255,0.16);flex-shrink:0" onerror="this.replaceWith(document.createTextNode('${emoji}'))" />`;
  }

  function showToast(message) {
    const region = document.getElementById('toastRegion');
    if (!region) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    region.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3400);
  }

  async function fetchDashboard() {
    try {
      const res = await fetch(`/api/dashboard?rangeMinutes=${selectedRangeMinutes}`);
      const data = await res.json();
      if (!data.ok) return;
      dashboardState = data;
      lastFetchClientTime = Date.now();
      renderAll();
    } catch (err) {
      console.error('Failed to load dashboard telemetry:', err);
    }
  }

  function renderAll() {
    if (!dashboardState) return;
    const { connection, stream, kpis, listeners, breakdowns, history, recentEvents } = dashboardState;

    // 1. Header & Connection Status
    const hostShort = (connection.baseUrl || 'https://live.ozone.fm:8443').replace(/^https?:\/\//, '');
    document.getElementById('stationNameHeading').textContent = stream.serverName || 'OZONE.FM';
    document.getElementById('mountBadge').textContent = connection.mount || '/listen';
    document.getElementById('endpointHostDisplay').textContent = hostShort;
    const formatLabel = (stream.contentType || 'audio/aacp').includes('aac') ? 'AAC+' : 'MP3';
    document.getElementById('streamFormatSpec').textContent = `${stream.bitrate || 320} kbps ${formatLabel}`;
    document.getElementById('nowPlayingTitle').textContent = stream.title || 'OZONE.FM Live Stream';
    document.getElementById('lastUpdatedClock').textContent = new Date(dashboardState.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const badge = document.getElementById('connectionStatusBadge');
    const badgeText = document.getElementById('connectionStatusText');
    const banner = document.getElementById('diagnosticBanner');
    const diagMsg = document.getElementById('diagnosticMessage');

    badge.className = 'status-badge';
    if (connection.activeSourceMode === 'live' && connection.status === 'connected') {
      badge.classList.add('live');
      badgeText.textContent = `LIVE • ${hostShort} (${connection.latencyMs || 40}ms)`;
      banner.classList.add('hidden');
    } else if (connection.activeSourceMode === 'imported') {
      badge.classList.add('live');
      badgeText.textContent = 'IMPORTED XSL SNAPSHOT';
      banner.classList.add('hidden');
    } else {
      badge.classList.add('simulated');
      if (connection.status === 'proxy_blocked') {
        badgeText.textContent = 'SIMULATION FEED (8443 Proxy-Restricted)';
        banner.classList.remove('hidden');
        diagMsg.textContent = `Outbound port 8443 to ${connection.endpointUrl} returned "${connection.error}" from the cloud sandbox proxy. Showing live-simulated OZONE.FM (/listen) telemetry. Run locally on your machine for direct port 8443 polling, or click "Paste listclients.xsl HTML" to inspect a snapshot right now.`;
      } else if (connection.status === 'unreachable') {
        badgeText.textContent = 'SIMULATION FALLBACK';
        banner.classList.remove('hidden');
        diagMsg.textContent = `Could not reach ${connection.endpointUrl} (${connection.error}). Showing simulated telemetry feed.`;
      } else {
        badgeText.textContent = 'SIMULATION DEMO MODE';
        banner.classList.add('hidden');
      }
    }

    // Sync poll select
    const pollSel = document.getElementById('pollIntervalSelect');
    if (pollSel && String(connection.pollIntervalSec) !== pollSel.value) {
      const opt = Array.from(pollSel.options).find(o => o.value === String(connection.pollIntervalSec));
      if (opt) pollSel.value = String(connection.pollIntervalSec);
    }

    // 2. KPI Cards
    const capPct = Math.min(100, Math.round((kpis.currentListeners / (kpis.maxCapacity || 500)) * 100));
    document.getElementById('kpiCurrentListeners').textContent = kpis.currentListeners;
    document.getElementById('kpiUniqueIpsTag').textContent = `${kpis.uniqueIps} unique IPs`;
    document.getElementById('capacityPctBadge').textContent = `${capPct}% cap`;
    document.getElementById('capacityMeterFill').style.width = `${Math.max(2, capPct)}%`;
    document.getElementById('kpiMountName').textContent = connection.mount || '/listen';
    document.getElementById('kpiMaxCapacity').textContent = kpis.maxCapacity || 500;

    document.getElementById('kpiPeak24h').textContent = kpis.peak24h;
    document.getElementById('kpiAllTimePeakBadge').textContent = `All-Time: ${kpis.allTimePeak}`;
    const diffFromPeak = kpis.peak24h - kpis.currentListeners;
    document.getElementById('kpiPeakDeltaTag').textContent =
      diffFromPeak <= 0 ? 'At Peak Now!' : `-${diffFromPeak} from peak`;
    document.getElementById('kpiPeakTime').textContent = new Date(kpis.peak24hTs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    document.getElementById('kpiAvgDuration').textContent = formatDurationHuman(kpis.avgSessionDurationSec);
    document.getElementById('kpiLongestTag').textContent = `Max: ${formatDurationHuman(kpis.longestSessionSec)}`;
    document.getElementById('kpiTlhBadge').textContent = `${kpis.totalActiveListeningHours} TLH`;
    document.getElementById('kpiActiveTlh').textContent = `${kpis.totalActiveListeningHours} hrs`;
    document.getElementById('kpi24hTlh').textContent = `${kpis.totalListeningHours24h} hrs`;

    document.getElementById('kpiCountriesCount').textContent = breakdowns.countries.length;
    const topCountry = breakdowns.countries[0];
    document.getElementById('kpiTopCountryBadge').innerHTML = topCountry
      ? `<span style="display:inline-flex;align-items:center;gap:5px">Top: ${renderCountryFlag(topCountry.countryCode, topCountry.countryName, 15)} ${escapeHtml(topCountry.countryName)} (${topCountry.sharePct}%)</span>`
      : 'Top: --';
    document.getElementById('kpiDupConnectionsTag').textContent = `${kpis.duplicateConnections} multi-stream`;
    document.getElementById('kpi24hUniqueIps').textContent = kpis.uniqueIps24h;
    document.getElementById('kpi24hSessions').textContent = kpis.totalSessions24h;

    // 3. World Map & Geo Distribution
    const svgEl = document.getElementById('worldMapSvg');
    const tooltipEl = document.getElementById('mapTooltip');
    if (window.OzoneWorldMap) {
      window.OzoneWorldMap.renderWorldMap(svgEl, tooltipEl, listeners, mapViewMode, ip => openIpInspector(ip));
    }
    renderGeoBreakdown(breakdowns);

    // 4. Historical Chart & Retention / Events
    renderHistoryChart(history);
    renderRetentionAndEvents(breakdowns.durationBuckets, recentEvents);

    // 4.5. Time-of-Day Profile, Connected Time Stats & Top 5 Returning Listeners
    renderTimeOfDayAndConnectedStats(dashboardState.timeOfDay, kpis);
    renderTopReturningListeners(dashboardState.topReturningListeners, kpis);

    // 5. User-Agent / Player / OS Breakdowns
    renderDistributionList('playersDistList', breakdowns.players, 'amber');
    renderDistributionList('categoriesDistList', breakdowns.categories, 'cyan');
    renderDistributionList('platformsDistList', breakdowns.platforms, 'emerald');

    // 6. Active Clients Table
    document.getElementById('tableEndpointLabel').textContent = connection.endpointUrl;
    renderClientsTable();
  }

  function renderTimeOfDayAndConnectedStats(timeOfDay, kpis) {
    if (!timeOfDay) return;
    const bestTag = document.getElementById('bestHourTag');
    if (bestTag) {
      bestTag.textContent = `Peak Hour: ${timeOfDay.bestHourLabel} (avg ${timeOfDay.bestHourAvg})`;
    }

    // Render 24-hour bar chart on #timeOfDayCanvas
    const canvas = document.getElementById('timeOfDayCanvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(240, Math.floor(rect.width || canvas.parentElement.clientWidth || 600));
      const h = Math.max(140, Math.floor(rect.height || 185));

      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.scale(dpr, dpr);

      ctx.clearRect(0, 0, w, h);

      const hourly = timeOfDay.hourly || [];
      const padL = 36;
      const padR = 14;
      const padT = 16;
      const padB = 26;
      const pw = w - padL - padR;
      const ph = h - padT - padB;

      const peakObserved = Math.max(0, ...hourly.map(x => Math.max(x.avgListeners || 0, x.peakListeners || 0)));
      const maxVal = Math.max(5, Math.ceil(peakObserved * 1.2));
      const currentHour = new Date().getHours();

      // Reference horizontal gridlines
      const steps = 3;
      ctx.strokeStyle = 'hsla(210, 20%, 90%, 0.08)';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'hsl(214, 12%, 52%)';
      ctx.font = '10.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';

      for (let i = 0; i <= steps; i++) {
        const y = padT + (ph / steps) * i;
        const val = Math.round(maxVal * (1 - i / steps));
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.fillText(String(val), padL - 8, y + 3.5);
      }

      const slotW = pw / 24;
      const barW = Math.max(5, Math.min(24, slotW * 0.72));

      hourly.forEach((b, idx) => {
        const xCenter = padL + idx * slotW + slotW / 2;
        const xLeft = xCenter - barW / 2;
        const avg = Number(b.avgListeners) || 0;
        const peak = Number(b.peakListeners) || 0;
        const isCurrent = idx === currentHour;
        const isPeakHour = avg === timeOfDay.bestHourAvg && avg > 0;

        // Background slot track so every hour slot is clearly visible
        ctx.fillStyle = isCurrent ? 'hsla(152, 76%, 46%, 0.12)' : 'hsla(210, 20%, 90%, 0.035)';
        ctx.fillRect(xLeft, padT, barW, ph);

        // Peak surge line if peak > avg
        if (peak > avg && peak > 0) {
          const peakH = Math.min(ph, (peak / maxVal) * ph);
          const yPeak = padT + ph - peakH;
          ctx.strokeStyle = 'hsla(28, 95%, 56%, 0.5)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(xLeft, yPeak);
          ctx.lineTo(xLeft + barW, yPeak);
          ctx.stroke();
        }

        // Active average listener bar
        if (avg > 0) {
          const barH = Math.max(4, Math.min(ph, (avg / maxVal) * ph));
          const yTop = padT + ph - barH;

          const grad = ctx.createLinearGradient(0, yTop, 0, padT + ph);
          if (isCurrent) {
            grad.addColorStop(0, 'hsl(152, 76%, 52%)');
            grad.addColorStop(1, 'hsl(152, 76%, 36%)');
          } else if (isPeakHour) {
            grad.addColorStop(0, 'hsl(28, 95%, 58%)');
            grad.addColorStop(1, 'hsl(18, 92%, 46%)');
          } else {
            grad.addColorStop(0, 'hsl(28, 95%, 54%)');
            grad.addColorStop(1, 'hsla(28, 95%, 44%, 0.75)');
          }

          ctx.fillStyle = grad;
          if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(xLeft, yTop, barW, barH, [3, 3, 0, 0]);
            ctx.fill();
          } else {
            ctx.fillRect(xLeft, yTop, barW, barH);
          }

          if (avg >= 2 && barH >= 16) {
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(String(avg), xCenter, yTop - 3);
          }
        } else {
          // Subtle baseline tick for monitored hours with 0 listeners
          ctx.fillStyle = isCurrent ? 'hsl(152, 76%, 46%)' : 'hsla(210, 20%, 90%, 0.16)';
          ctx.fillRect(xLeft, padT + ph - 2, barW, 2);
        }

        // X-axis Hour Labels (every 3 hours: 00h, 03h, 06h, 09h, 12h, 15h, 18h, 21h, 23h)
        if (idx % 3 === 0 || idx === 23) {
          ctx.fillStyle = isCurrent ? 'hsl(152, 76%, 50%)' : 'hsl(214, 12%, 48%)';
          ctx.font = isCurrent ? 'bold 10px "JetBrains Mono", monospace' : '9.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${String(idx).padStart(2, '0')}h`, xCenter, h - 7);
        }
      });
    }

    // Render 4 Daypart cards
    const dpGrid = document.getElementById('daypartSummaryGrid');
    if (dpGrid && Array.isArray(timeOfDay.dayparts)) {
      dpGrid.innerHTML = timeOfDay.dayparts
        .map(
          dp => `
          <div style="background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px;padding:8px 10px">
            <div style="font-size:11px;color:var(--text-muted);font-weight:600">${escapeHtml(dp.name)}</div>
            <div class="mono" style="font-size:10.5px;color:var(--text-secondary)">${escapeHtml(dp.hours)}</div>
            <div class="mono" style="margin-top:4px;font-size:14px;font-weight:700;color:var(--text-primary)">
              Avg ${dp.avgListeners} <span style="font-size:11px;font-weight:500;color:var(--accent-amber)">(Peak ${dp.peakListeners})</span>
            </div>
          </div>
        `
        )
        .join('');
    }

    // Render Connected Time Stats Strip (Mean, Median, P90, Longest)
    const ctStrip = document.getElementById('connectedTimeStatsStrip');
    if (ctStrip && kpis) {
      ctStrip.innerHTML = `
        <div>
          <div style="font-size:11px;color:var(--text-muted)">MEAN CONNECTED TIME</div>
          <div class="mono" style="font-size:14px;font-weight:700;color:var(--accent-emerald)">${formatDurationHuman(kpis.avgSessionDurationSec)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">MEDIAN SESSION</div>
          <div class="mono" style="font-size:14px;font-weight:700">${formatDurationHuman(kpis.medianSessionDurationSec || kpis.avgSessionDurationSec)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">90TH PERCENTILE</div>
          <div class="mono" style="font-size:14px;font-weight:700;color:var(--accent-cyan)">${formatDurationHuman(kpis.p90SessionDurationSec || kpis.longestSessionSec)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">LONGEST SESSION</div>
          <div class="mono" style="font-size:14px;font-weight:700;color:var(--accent-amber)">${formatDurationHuman(kpis.longestSessionSec)}</div>
        </div>
      `;
    }
  }

  function renderTopReturningListeners(topList, kpis) {
    const container = document.getElementById('topReturningList');
    const tag = document.getElementById('returningTotalTag');
    const quickSelect = document.getElementById('returningMinAvgQuickSelect');
    const minAvgSec =
      kpis && Number.isFinite(Number(kpis.returningMinAvgSec))
        ? Number(kpis.returningMinAvgSec)
        : 60;

    if (quickSelect) {
      const strVal = String(minAvgSec);
      const exists = Array.from(quickSelect.options).some(opt => opt.value === strVal);
      if (!exists) {
        const customOpt = document.createElement('option');
        customOpt.value = strVal;
        customOpt.textContent = `Min Avg ≥ ${formatDurationHuman(minAvgSec)}`;
        quickSelect.appendChild(customOpt);
      }
      quickSelect.value = strVal;
    }

    if (tag && kpis) {
      tag.textContent = `${kpis.returningListenerCount ?? (topList || []).length} Repeat IPs`;
    }
    if (!container) return;

    const items = (topList || []).slice(0, 5);
    if (items.length === 0) {
      container.innerHTML = `<div style="color:var(--text-muted);font-size:12.5px">No returning human listeners with average session ≥ ${formatDurationHuman(minAvgSec)} yet (bots excluded).</div>`;
      return;
    }

    container.innerHTML = items
      .map(item => {
        const statusBadge = item.isActive
          ? `<span class="event-badge join">LIVE NOW</span>`
          : `<span class="event-badge leave">RECENT</span>`;
        const locLabel =
          item.city && item.city !== item.countryName && !item.city.startsWith('Unresolved') && item.city !== 'Unknown City' && item.city !== 'Unknown'
            ? `${escapeHtml(item.city)}, <span style="color:var(--text-secondary)">${escapeHtml(item.countryName || item.countryCode)}</span>`
            : escapeHtml(item.countryName || item.countryCode || 'Unknown');
        const nameBadge = item.friendlyName
          ? `<span style="background:hsla(28,95%,56%,0.16);color:var(--accent-amber);border:1px solid hsla(28,95%,56%,0.38);border-radius:4px;padding:1px 6px;font-size:11.5px;font-weight:600">${escapeHtml(item.friendlyName)}</span>`
          : '';
        return `
          <div class="event-row" style="padding:10px 12px">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              <span class="mono" style="font-weight:700;font-size:13px;color:var(--accent-amber);width:22px">#${item.rank}</span>
              <div style="min-width:0">
                <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                  <button type="button" class="ip-link" data-inspect-ip="${escapeHtml(item.ip)}" title="Click to set friendly name or inspect history">
                    ${escapeHtml(item.ip)}
                  </button>
                  ${nameBadge}
                  ${renderCountryFlag(item.countryCode, item.countryName, 18)}
                  <span style="font-weight:500">${locLabel}</span>
                  ${statusBadge}
                </div>
                <div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px">
                  ${escapeHtml(item.player)} (${escapeHtml(item.os)}) • Avg visit: <span class="mono">${formatDurationHuman(item.avgDurationSeconds)}</span>
                </div>
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0" class="mono">
              <div style="font-size:13px;font-weight:700;color:var(--accent-emerald)">${item.sessionCount} sessions</div>
              <div style="font-size:11.5px;color:var(--text-secondary)">Total: ${formatDurationHuman(item.totalDurationSeconds)}</div>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('[data-inspect-ip]').forEach(btn => {
      btn.addEventListener('click', () => openIpInspector(btn.getAttribute('data-inspect-ip')));
    });
  }

  function renderGeoBreakdown(breakdowns) {
    const container = document.getElementById('geoBreakdownList');
    if (!container) return;
    const items = geoTabMode === 'countries' ? breakdowns.countries.slice(0, 7) : breakdowns.cities.slice(0, 7);

    if (items.length === 0) {
      container.innerHTML = `<div style="color:var(--text-muted);font-size:12.5px">No geographic listener data available.</div>`;
      return;
    }

    container.innerHTML = items
      .map(item => {
        let label = '';
        if (geoTabMode === 'countries') {
          label = `${renderCountryFlag(item.countryCode, item.countryName, 18)}<span>${escapeHtml(item.countryName)}</span>`;
        } else {
          if (item.hasCity) {
            label = `${renderCountryFlag(item.countryCode, item.countryName, 18)}<span>${escapeHtml(item.city)}</span>`;
          } else {
            label = `${renderCountryFlag(item.countryCode, item.countryName, 18)}<span style="color:var(--text-secondary);font-style:italic" title="Specific city not resolved by GeoIP">${escapeHtml(item.city)}</span>`;
          }
        }
        return `
          <div class="dist-item">
            <div class="dist-item-header">
              <div class="dist-label">${label}</div>
              <div class="dist-metrics">
                <span>avg ${formatDurationHuman(item.avgDurationSec)}</span>
                <strong style="color:var(--text-primary)">${item.count} (${item.sharePct}%)</strong>
              </div>
            </div>
            <div class="dist-bar-track">
              <div class="dist-bar-fill" style="width:${Math.max(3, item.sharePct)}%"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderDistributionList(elementId, list, colorClass) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const top = (list || []).slice(0, 6);
    if (top.length === 0) {
      el.innerHTML = `<div style="color:var(--text-muted);font-size:12.5px">No active clients</div>`;
      return;
    }
    el.innerHTML = top
      .map(
        item => `
        <div class="dist-item">
          <div class="dist-item-header">
            <div class="dist-label">${escapeHtml(item.name)}</div>
            <div class="dist-metrics">
              <strong style="color:var(--text-primary)">${item.count}</strong>
              <span>${item.sharePct}%</span>
            </div>
          </div>
          <div class="dist-bar-track">
            <div class="dist-bar-fill ${colorClass || ''}" style="width:${Math.max(3, item.sharePct)}%"></div>
          </div>
        </div>
      `
      )
      .join('');
  }

  function renderRetentionAndEvents(buckets, recentEvents) {
    const retEl = document.getElementById('retentionBucketList');
    const evEl = document.getElementById('eventFeedContainer');
    if (!retEl || !evEl) return;

    if (rightMidTabMode === 'retention') {
      retEl.style.display = 'flex';
      evEl.style.display = 'none';
      retEl.innerHTML = (buckets || [])
        .map(
          b => `
          <div class="dist-item">
            <div class="dist-item-header">
              <div class="dist-label mono">${escapeHtml(b.label)}</div>
              <div class="dist-metrics">
                <strong style="color:var(--text-primary)">${b.count} listeners</strong>
                <span>${b.sharePct}%</span>
              </div>
            </div>
            <div class="dist-bar-track">
              <div class="dist-bar-fill emerald" style="width:${Math.max(2, b.sharePct)}%"></div>
            </div>
          </div>
        `
        )
        .join('');
    } else {
      retEl.style.display = 'none';
      evEl.style.display = 'flex';
      if (!recentEvents || recentEvents.length === 0) {
        evEl.innerHTML = `<div style="color:var(--text-muted);font-size:12.5px">No join/leave events recorded yet.</div>`;
        return;
      }
      evEl.innerHTML = recentEvents
        .slice(0, 25)
        .map(ev => {
          const timeStr = new Date(ev.ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          const locStr = ev.city ? `${ev.city}, ${ev.country_code}` : '';
          const mainText = ev.ip
            ? `<strong class="mono">${escapeHtml(ev.ip)}</strong> ${locStr ? `(${escapeHtml(locStr)})` : ''} — ${escapeHtml(ev.details || ev.player)}`
            : escapeHtml(ev.details);
          return `
            <div class="event-row">
              <div class="event-left">
                <span class="event-badge ${escapeHtml(ev.event_type)}">${escapeHtml(ev.event_type)}</span>
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${mainText}</span>
              </div>
              <span class="mono" style="color:var(--text-muted);font-size:11px;flex-shrink:0">${timeStr}</span>
            </div>
          `;
        })
        .join('');
    }
  }

  function renderHistoryChart(historySeries) {
    const canvas = document.getElementById('historyChartCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const pts = Array.isArray(historySeries) ? historySeries : [];
    if (pts.length === 0) {
      ctx.fillStyle = 'hsl(214, 12%, 48%)';
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText('Collecting time-series snapshots...', 20, h / 2);
      return;
    }

    const padLeft = 38;
    const padRight = 14;
    const padTop = 16;
    const padBottom = 26;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    const maxVal = Math.max(10, ...pts.map(p => Math.max(p.listener_count || 0, p.peak_reported || 0))) * 1.15;

    // Horizontal reference lines
    const steps = 4;
    ctx.strokeStyle = 'hsla(210, 20%, 90%, 0.06)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'hsl(214, 12%, 48%)';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = 0; i <= steps; i++) {
      const y = padTop + (plotH / steps) * i;
      const val = Math.round(maxVal * (1 - i / steps));
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();
      ctx.fillText(String(val), padLeft - 8, y + 4);
    }

    const getX = idx =>
      pts.length === 1 ? padLeft + plotW / 2 : padLeft + (idx / (pts.length - 1)) * plotW;
    const getY = val => padTop + plotH - (Math.min(maxVal, val) / maxVal) * plotH;

    // Draw area fill under listener_count curve
    const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    grad.addColorStop(0, 'hsla(28, 95%, 56%, 0.34)');
    grad.addColorStop(1, 'hsla(28, 95%, 56%, 0.0)');

    ctx.beginPath();
    pts.forEach((p, idx) => {
      const x = getX(idx);
      const y = getY(p.listener_count);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(getX(pts.length - 1), padTop + plotH);
    ctx.lineTo(getX(0), padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw listener_count line
    ctx.beginPath();
    pts.forEach((p, idx) => {
      const x = getX(idx);
      const y = getY(p.listener_count);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'hsl(28, 95%, 56%)';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Draw unique_ips dashed line
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    pts.forEach((p, idx) => {
      const x = getX(idx);
      const y = getY(p.unique_ips || p.listener_count);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'hsl(196, 88%, 54%)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.setLineDash([]);

    // X-axis time labels
    ctx.fillStyle = 'hsl(214, 12%, 48%)';
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, pts.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / Math.max(1, labelCount - 1)) * (pts.length - 1));
      const p = pts[idx];
      const x = getX(idx);
      const label = new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(label, x, h - 6);
    }
  }

  function getLiveElapsedSec() {
    return Math.max(0, Math.floor((Date.now() - lastFetchClientTime) / 1000));
  }

  function renderClientsTable() {
    if (!dashboardState) return;
    const tbody = document.getElementById('clientsTableBody');
    const countBadge = document.getElementById('tableCountBadge');
    if (!tbody) return;

    const elapsedSec = getLiveElapsedSec();
    const q = tableSearchQuery.trim().toLowerCase();

    let rows = (dashboardState.listeners || []).map(l => ({
      ...l,
      liveConnectedSeconds: (l.connectedSeconds || 0) + elapsedSec,
    }));

    if (tableCategoryFilter !== 'ALL') {
      rows = rows.filter(r => r.ua?.category === tableCategoryFilter);
    }

    if (q) {
      rows = rows.filter(
        r =>
          r.ip.toLowerCase().includes(q) ||
          (r.friendlyName || '').toLowerCase().includes(q) ||
          (r.notes || '').toLowerCase().includes(q) ||
          (r.geo?.city || '').toLowerCase().includes(q) ||
          (r.geo?.countryName || '').toLowerCase().includes(q) ||
          (r.geo?.countryCode || '').toLowerCase().includes(q) ||
          (r.ua?.player || '').toLowerCase().includes(q) ||
          (r.ua?.os || '').toLowerCase().includes(q) ||
          (r.userAgent || '').toLowerCase().includes(q)
      );
    }

    rows.sort((a, b) => {
      let va, vb;
      switch (tableSortField) {
        case 'ip':
          va = (a.friendlyName || a.ip).toLowerCase();
          vb = (b.friendlyName || b.ip).toLowerCase();
          break;
        case 'location':
          va = `${a.geo?.countryName || ''} ${a.geo?.city || ''}`;
          vb = `${b.geo?.countryName || ''} ${b.geo?.city || ''}`;
          break;
        case 'player':
          va = a.ua?.player || '';
          vb = b.ua?.player || '';
          break;
        case 'os':
          va = a.ua?.os || '';
          vb = b.ua?.os || '';
          break;
        case 'connectedSeconds':
        default:
          va = a.liveConnectedSeconds;
          vb = b.liveConnectedSeconds;
          break;
      }
      if (va < vb) return tableSortAsc ? -1 : 1;
      if (va > vb) return tableSortAsc ? 1 : -1;
      return 0;
    });

    if (countBadge) {
      countBadge.textContent = `${rows.length} of ${dashboardState.listeners.length} clients`;
    }

    if (rows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center;padding:28px;color:var(--text-muted)">
            No active listeners match the current filter.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = rows
      .map(r => {
        const sec = r.liveConnectedSeconds;
        const durClass = sec >= 3600 ? 'long' : sec >= 900 ? 'medium' : '';
        const dupHtml =
          r.connectionsFromIp > 1
            ? `<span class="dup-badge" title="${r.connectionsFromIp} simultaneous connections from this IP">${r.connectionsFromIp}x</span>`
            : '';
        const isBot = Boolean(r.isBot || r.isManualBot || r.ua?.isRipper || r.ua?.category === 'Bot / Ripper');
        const catClass = isBot ? 'ripper' : '';
        const botBtnHtml = isBot
          ? `<button type="button" class="btn btn-warning-ghost" style="padding:4px 8px;font-size:11.5px" data-bot-ip="${escapeHtml(r.ip)}" data-bot-state="1" title="Marked as Bot / Ripper. Click to remove bot classification">🤖 Unmark Bot</button>`
          : `<button type="button" class="btn" style="padding:4px 8px;font-size:11.5px" data-bot-ip="${escapeHtml(r.ip)}" data-bot-state="0" title="Flag this IP as a Bot or Stream Ripper">🤖 Mark Bot</button>`;
        const friendlyBadgeHtml = r.friendlyName
          ? `<button type="button" data-inspect-ip="${escapeHtml(r.ip)}" style="background:hsla(28,95%,56%,0.16);color:var(--accent-amber);border:1px solid hsla(28,95%,56%,0.42);border-radius:4px;padding:2px 7px;font-size:12px;font-weight:600;cursor:pointer;text-align:left" title="Click to edit friendly name or inspect IP">${escapeHtml(r.friendlyName)}</button>`
          : '';

        return `
          <tr data-client-id="${escapeHtml(r.clientId)}">
            <td>
              <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start">
                ${friendlyBadgeHtml}
                <div class="ip-cell">
                  <button type="button" class="ip-link" data-inspect-ip="${escapeHtml(r.ip)}" title="Click to assign a friendly name &amp; view session history for ${escapeHtml(r.ip)}">
                    ${escapeHtml(r.ip)}
                  </button>
                  <button type="button" class="copy-ip-btn" data-copy-ip="${escapeHtml(r.ip)}" title="Copy IP address">Copy</button>
                  ${dupHtml}
                </div>
              </div>
            </td>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                ${renderCountryFlag(r.geo?.countryCode, r.geo?.countryName, 18)}
                <span>${
                  r.geo?.city && r.geo.city !== r.geo.countryName && !r.geo.city.startsWith('Unresolved') && r.geo.city !== 'Unknown City' && r.geo.city !== 'Unknown'
                    ? `${escapeHtml(r.geo.city)}, <span style="color:var(--text-secondary)">${escapeHtml(r.geo?.countryName || '')}</span>`
                    : `${escapeHtml(r.geo?.countryName || 'Unknown')}`
                }</span>
              </div>
            </td>
            <td>
              <span class="duration-pill ${durClass}" data-base-sec="${r.connectedSeconds}">
                ${formatDurationClock(sec)}
              </span>
              <span class="mono" style="font-size:11px;color:var(--text-muted);margin-left:6px">(${sec}s)</span>
            </td>
            <td class="ua-cell">
              <div class="ua-parsed-row">
                <span>${escapeHtml(r.ua?.player || 'Audio Client')}</span>
              </div>
              <div class="ua-raw-sub" title="${escapeHtml(r.userAgent)}">${escapeHtml(r.userAgent)}</div>
            </td>
            <td>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span class="cat-tag ${catClass}">${isBot ? '🤖 Bot / Ripper' : escapeHtml(r.ua?.category || 'Client')}</span>
                <span style="font-size:12px;color:var(--text-secondary)">${escapeHtml(r.ua?.os || '')}</span>
              </div>
            </td>
            <td>
              <div style="display:flex;align-items:center;gap:6px">
                <button type="button" class="btn" style="padding:4px 8px;font-size:11.5px" data-inspect-ip="${escapeHtml(r.ip)}" title="Set friendly name &amp; view history">Name / History</button>
                ${botBtnHtml}
                <button type="button" class="btn btn-danger-ghost" data-kick-id="${escapeHtml(r.clientId)}" data-kick-ip="${escapeHtml(r.ip)}">Kick</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // Live 1-second duration ticker so Connected Time updates smoothly every second
  setInterval(() => {
    if (!dashboardState) return;
    const elapsed = getLiveElapsedSec();
    const pills = document.querySelectorAll('#clientsTableBody .duration-pill[data-base-sec]');
    pills.forEach(pill => {
      const base = parseInt(pill.getAttribute('data-base-sec') || '0', 10);
      const total = base + elapsed;
      pill.textContent = formatDurationClock(total);
      const nextSpan = pill.nextElementSibling;
      if (nextSpan) nextSpan.textContent = `(${total}s)`;
    });
  }, 1000);

  // Open IP Dossier & Friendly Name Modal
  async function openIpInspector(ip) {
    const backdrop = document.getElementById('ipModalBackdrop');
    const title = document.getElementById('ipModalTitle');
    const content = document.getElementById('ipModalContent');
    if (!backdrop || !content) return;

    title.textContent = `Listener Dossier — ${ip}`;
    content.innerHTML = `<div style="color:var(--text-secondary)">Querying SQLite session history and MaxMind GeoIP for ${escapeHtml(ip)}...</div>`;
    backdrop.classList.remove('hidden');

    try {
      const res = await fetch(`/api/ip/${encodeURIComponent(ip)}`);
      const data = await res.json();
      if (!data.ok) {
        content.innerHTML = `<div style="color:var(--accent-crimson)">Failed to load IP dossier.</div>`;
        return;
      }

      const { geo, activeConnections, history, friendlyName } = data;
      const sum = history?.summary || {};
      const sessions = history?.sessions || [];
      const currentName = friendlyName || history?.friendlyName || '';
      const isBot = Boolean(history?.isBot);

      title.textContent = currentName ? `${currentName} (${ip})` : `Listener Dossier — ${ip}`;

      content.innerHTML = `
        <form id="ipAliasForm" style="background:var(--bg-elevated);padding:12px 14px;border-radius:8px;border:1px solid var(--border-strong);display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <label for="ipFriendlyNameInput" style="font-size:11.5px;font-weight:700;color:var(--accent-amber);letter-spacing:0.04em">FRIENDLY NAME FOR ${escapeHtml(ip)}</label>
            <span style="font-size:11px;color:var(--text-muted)">Saved in SQLite</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="ipFriendlyNameInput" class="form-input" placeholder="e.g. My HomePod mini, Studio Monitor, DJ Alex..." value="${escapeHtml(currentName)}" style="flex:1" autocomplete="off" />
            <button type="submit" class="btn btn-primary" style="white-space:nowrap">Save Name</button>
            ${
              currentName
                ? `<button type="button" id="clearIpAliasBtn" class="btn btn-danger-ghost" style="white-space:nowrap">Remove</button>`
                : ''
            }
          </div>
        </form>

        <div style="background:var(--bg-elevated);padding:10px 14px;border-radius:8px;border:1px solid ${isBot ? 'hsla(355,84%,60%,0.4)' : 'var(--border-subtle)'};display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.04em">BOT / RIPPER CLASSIFICATION</div>
            <div style="font-size:12.5px;margin-top:2px">
              ${isBot ? '<span style="color:var(--accent-crimson);font-weight:700">🤖 Flagged as Bot / Ripper</span> — Excluded from Top 5 Returning Listeners' : '<span style="color:var(--accent-emerald);font-weight:600">👤 Standard Listener</span> — Included in listener analytics'}
            </div>
          </div>
          <button type="button" id="modalToggleBotBtn" class="btn ${isBot ? 'btn-warning-ghost' : 'btn'}" style="white-space:nowrap;padding:5px 12px">
            ${isBot ? 'Remove Bot Flag' : '🤖 Flag as Bot / Ripper'}
          </button>
        </div>

        <div class="form-grid-2" style="background:var(--bg-canvas);padding:12px 14px;border-radius:8px;border:1px solid var(--border-subtle)">
          <div>
            <div style="font-size:11px;color:var(--text-muted)">LOCATION</div>
            <div style="font-weight:600;margin-top:2px;display:flex;align-items:center;gap:6px">${renderCountryFlag(geo.countryCode, geo.countryName, 18)} <span>${escapeHtml(geo.hasCity && geo.city && geo.city !== geo.countryName && !geo.city.startsWith('Unresolved') ? `${geo.city}, ${geo.countryName}` : `${geo.countryName || 'Unknown'}`)}</span></div>
            <div class="mono" style="font-size:11.5px;color:var(--text-secondary);margin-top:2px">Coords: ${geo.lat}, ${geo.lon} • TZ: ${escapeHtml(geo.timezone)}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted)">CUMULATIVE SQLITE STATS</div>
            <div class="mono" style="font-weight:600;margin-top:2px">${sum.session_count || 1} recorded session(s)</div>
            <div class="mono" style="font-size:11.5px;color:var(--accent-emerald);margin-top:2px">
              Total Listen Time: ${formatDurationHuman(sum.total_seconds || 0)} • Active Now: ${activeConnections.length}
            </div>
          </div>
        </div>

        <div style="font-size:12.5px;font-weight:600;margin-top:4px">Recent Sessions from ${escapeHtml(ip)}</div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto">
          ${
            sessions.length === 0
              ? `<div style="color:var(--text-muted);font-size:12px">No stored sessions yet.</div>`
              : sessions
                  .map(
                    s => `
                  <div class="event-row">
                    <div>
                      <div style="font-weight:500">${escapeHtml(s.player)} <span style="color:var(--text-muted)">(${escapeHtml(s.os)})</span></div>
                      <div class="mono" style="font-size:11px;color:var(--text-muted)">${escapeHtml(s.user_agent.slice(0, 68))}</div>
                    </div>
                    <div style="text-align:right" class="mono">
                      <div style="color:var(--accent-amber);font-weight:600">${formatDurationHuman(s.duration_seconds)}</div>
                      <div style="font-size:10.5px;color:var(--text-muted)">${new Date(s.last_seen).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  </div>
                `
                  )
                  .join('')
          }
        </div>
      `;

      const nameInput = document.getElementById('ipFriendlyNameInput');
      if (nameInput) {
        setTimeout(() => {
          nameInput.focus();
          nameInput.select();
        }, 40);
      }

      document.getElementById('modalToggleBotBtn')?.addEventListener('click', async () => {
        const nextState = !isBot;
        const botRes = await fetch(`/api/ip/${encodeURIComponent(ip)}/bot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isBot: nextState }),
        });
        const botData = await botRes.json();
        if (botData.ok) {
          showToast(nextState ? `Flagged ${ip} as Bot / Ripper` : `Removed Bot flag from ${ip}`);
          await fetchDashboard();
          openIpInspector(ip);
        }
      });

      document.getElementById('ipAliasForm')?.addEventListener('submit', async e => {
        e.preventDefault();
        const newName = (document.getElementById('ipFriendlyNameInput')?.value || '').trim();
        const saveRes = await fetch(`/api/ip/${encodeURIComponent(ip)}/alias`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ friendlyName: newName }),
        });
        const saveData = await saveRes.json();
        if (saveData.ok) {
          showToast(newName ? `Named ${ip} "${newName}"` : `Cleared friendly name for ${ip}`);
          title.textContent = newName ? `${newName} (${ip})` : `Listener Dossier — ${ip}`;
          await fetchDashboard();
        }
      });

      document.getElementById('clearIpAliasBtn')?.addEventListener('click', async () => {
        await fetch(`/api/ip/${encodeURIComponent(ip)}/alias`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ friendlyName: '' }),
        });
        showToast(`Cleared friendly name for ${ip}`);
        await fetchDashboard();
        openIpInspector(ip);
      });
    } catch (err) {
      content.innerHTML = `<div style="color:var(--accent-crimson)">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Event Listeners Setup
  function setupInteractions() {
    // Map View Tabs ('europe' | 'romania' | 'world')
    ['mapViewEuropeBtn', 'mapViewRomaniaBtn', 'mapViewWorldBtn'].forEach(btnId => {
      document.getElementById(btnId)?.addEventListener('click', e => {
        const mode = e.currentTarget.getAttribute('data-map-view') || 'europe';
        mapViewMode = mode;
        ['mapViewEuropeBtn', 'mapViewRomaniaBtn', 'mapViewWorldBtn'].forEach(id => {
          document.getElementById(id)?.classList.toggle('active', id === btnId);
        });
        renderAll();
      });
    });

    // Geo Breakdown Tabs
    document.getElementById('geoTabCountriesBtn')?.addEventListener('click', e => {
      geoTabMode = 'countries';
      e.currentTarget.classList.add('active');
      document.getElementById('geoTabCitiesBtn')?.classList.remove('active');
      if (dashboardState) renderGeoBreakdown(dashboardState.breakdowns);
    });
    document.getElementById('geoTabCitiesBtn')?.addEventListener('click', e => {
      geoTabMode = 'cities';
      e.currentTarget.classList.add('active');
      document.getElementById('geoTabCountriesBtn')?.classList.remove('active');
      if (dashboardState) renderGeoBreakdown(dashboardState.breakdowns);
    });

    // Historical Range Tabs
    document.querySelectorAll('#historyRangeTabs .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#historyRangeTabs .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedRangeMinutes = parseInt(btn.getAttribute('data-range') || '60', 10);
        fetchDashboard();
      });
    });

    // Retention vs Event Feed Tabs
    document.getElementById('tabRetentionBtn')?.addEventListener('click', e => {
      rightMidTabMode = 'retention';
      e.currentTarget.classList.add('active');
      document.getElementById('tabEventFeedBtn')?.classList.remove('active');
      document.getElementById('rightMidPanelTitle').textContent = 'Listener Retention & Tune-In Duration';
      document.getElementById('rightMidPanelSub').textContent = 'Distribution of active listener loyalty cohorts';
      if (dashboardState) renderRetentionAndEvents(dashboardState.breakdowns.durationBuckets, dashboardState.recentEvents);
    });
    document.getElementById('tabEventFeedBtn')?.addEventListener('click', e => {
      rightMidTabMode = 'events';
      e.currentTarget.classList.add('active');
      document.getElementById('tabRetentionBtn')?.classList.remove('active');
      document.getElementById('rightMidPanelTitle').textContent = 'Real-Time Join / Leave Activity Log';
      document.getElementById('rightMidPanelSub').textContent = 'Audit trail of listener connections and disconnections';
      if (dashboardState) renderRetentionAndEvents(dashboardState.breakdowns.durationBuckets, dashboardState.recentEvents);
    });

    // Search & Category filter
    document.getElementById('clientSearchInput')?.addEventListener('input', e => {
      tableSearchQuery = e.target.value || '';
      renderClientsTable();
    });
    document.getElementById('categoryFilterSelect')?.addEventListener('change', e => {
      tableCategoryFilter = e.target.value || 'ALL';
      renderClientsTable();
    });

    // Table sorting
    document.querySelectorAll('#clientsTable thead th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (tableSortField === field) {
          tableSortAsc = !tableSortAsc;
        } else {
          tableSortField = field;
          tableSortAsc = field !== 'connectedSeconds';
        }
        renderClientsTable();
      });
    });

    // Table row actions delegation (Inspect IP, Copy IP, Kick Client)
    document.getElementById('clientsTableBody')?.addEventListener('click', async e => {
      const inspectBtn = e.target.closest('[data-inspect-ip]');
      if (inspectBtn) {
        openIpInspector(inspectBtn.getAttribute('data-inspect-ip'));
        return;
      }

      const copyBtn = e.target.closest('[data-copy-ip]');
      if (copyBtn) {
        const ip = copyBtn.getAttribute('data-copy-ip');
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(ip);
          } else {
            const ta = document.createElement('textarea');
            ta.value = ip;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
          showToast(`Copied IP ${ip} to clipboard`);
        } catch (_) {
          showToast(`IP: ${ip}`);
        }
        return;
      }

      const botBtn = e.target.closest('[data-bot-ip]');
      if (botBtn) {
        const ip = botBtn.getAttribute('data-bot-ip');
        const currentState = botBtn.getAttribute('data-bot-state') === '1';
        const newState = !currentState;
        botBtn.disabled = true;
        botBtn.textContent = newState ? 'Marking...' : 'Unmarking...';
        try {
          const res = await fetch(`/api/ip/${encodeURIComponent(ip)}/bot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isBot: newState }),
          });
          const data = await res.json();
          if (data.ok) {
            showToast(newState ? `Flagged ${ip} as Bot / Ripper (excluded from Top 5)` : `Removed Bot flag from ${ip}`);
            await fetchDashboard();
          } else {
            showToast(`Error: ${data.error}`);
            botBtn.disabled = false;
            botBtn.textContent = currentState ? '🤖 Unmark Bot' : '🤖 Mark Bot';
          }
        } catch (err) {
          showToast(`Request failed: ${err.message}`);
          botBtn.disabled = false;
          botBtn.textContent = currentState ? '🤖 Unmark Bot' : '🤖 Mark Bot';
        }
        return;
      }

      const kickBtn = e.target.closest('[data-kick-id]');
      if (kickBtn) {
        const clientId = kickBtn.getAttribute('data-kick-id');
        const ip = kickBtn.getAttribute('data-kick-ip');
        kickBtn.disabled = true;
        kickBtn.textContent = 'Kicking...';
        try {
          const res = await fetch('/api/kick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, ip }),
          });
          const data = await res.json();
          if (data.ok) {
            showToast(data.message || `Disconnected client #${clientId}`);
            fetchDashboard();
          } else {
            showToast(`Kick error: ${data.error}`);
            kickBtn.disabled = false;
            kickBtn.textContent = 'Kick';
          }
        } catch (err) {
          showToast(`Kick request failed: ${err.message}`);
          kickBtn.disabled = false;
          kickBtn.textContent = 'Kick';
        }
      }
    });

    // Manual Refresh & Retry Live
    document.getElementById('manualRefreshBtn')?.addEventListener('click', async () => {
      showToast('Polling Icecast telemetry...');
      await fetch('/api/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      await fetchDashboard();
    });
    document.getElementById('retryLiveBtn')?.addEventListener('click', async () => {
      showToast('Probing live.ozone.fm:8443...');
      await fetch('/api/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forceLive: true }) });
      await fetchDashboard();
    });

    // Returning Listeners Min Avg Duration quick selector
    document.getElementById('returningMinAvgQuickSelect')?.addEventListener('change', async e => {
      const minSec = Math.max(0, parseInt(e.target.value, 10) || 0);
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returningMinAvgSec: minSec }),
      });
      showToast(`Top Returning filter updated: Min Avg ≥ ${formatDurationHuman(minSec)}`);
      await fetchDashboard();
    });

    // Poll interval selector
    document.getElementById('pollIntervalSelect')?.addEventListener('change', async e => {
      const sec = parseInt(e.target.value, 10) || 10;
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pollIntervalSec: sec }),
      });
      restartFrontendTimer(sec);
      showToast(`Polling interval updated to ${sec}s`);
    });

    // Export CSV & JSON
    document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
      if (!dashboardState || !dashboardState.listeners) return;
      const headers = ['ClientID', 'IP', 'CountryCode', 'Country', 'City', 'ConnectedSeconds', 'Player', 'Category', 'OS', 'Mount', 'UserAgent'];
      const lines = [headers.join(',')];
      for (const l of dashboardState.listeners) {
        const row = [
          l.clientId,
          l.ip,
          l.geo?.countryCode || '',
          `"${(l.geo?.countryName || '').replace(/"/g, '""')}"`,
          `"${(l.geo?.city || '').replace(/"/g, '""')}"`,
          l.connectedSeconds,
          `"${(l.ua?.player || '').replace(/"/g, '""')}"`,
          `"${(l.ua?.category || '').replace(/"/g, '""')}"`,
          `"${(l.ua?.os || '').replace(/"/g, '""')}"`,
          l.mount || '/listen',
          `"${(l.userAgent || '').replace(/"/g, '""')}"`,
        ];
        lines.push(row.join(','));
      }
      downloadBlob(lines.join('\n'), `ozone-fm-listeners-${Date.now()}.csv`, 'text/csv');
    });

    document.getElementById('exportJsonBtn')?.addEventListener('click', () => {
      if (!dashboardState) return;
      downloadBlob(JSON.stringify(dashboardState, null, 2), `ozone-fm-telemetry-${Date.now()}.json`, 'application/json');
    });

    // Audio Stream Preview Player
    const audioEl = document.getElementById('liveStreamAudio');
    const playBtn = document.getElementById('toggleAudioBtn');
    const playSvg = document.getElementById('playIconSvg');
    const vuBars = document.getElementById('vuMeterBars');

    playBtn?.addEventListener('click', async () => {
      if (!audioEl) return;
      if (audioEl.paused) {
        const streamUrl = dashboardState?.stream?.listenUrl || 'https://live.ozone.fm:8443/listen';
        audioEl.src = streamUrl;
        try {
          await audioEl.play();
          playBtn.classList.add('playing');
          playSvg.innerHTML = `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;
          startVuAnimation(vuBars);
          showToast(`Playing live stream: ${streamUrl}`);
        } catch (err) {
          // If sandbox blocks direct browser audio stream, animate monitor or notify user
          showToast(`Stream monitor notice: Direct browser connection to ${streamUrl} requires network access to port 8443.`);
        }
      } else {
        audioEl.pause();
        audioEl.src = '';
        playBtn.classList.remove('playing');
        playSvg.innerHTML = `<polygon points="6 4 20 12 6 20 6 4"></polygon>`;
        stopVuAnimation(vuBars);
      }
    });

    // Settings Modal
    const settingsBackdrop = document.getElementById('settingsModalBackdrop');
    document.getElementById('openSettingsModalBtn')?.addEventListener('click', async () => {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data.ok && data.config) {
        document.getElementById('cfgBaseUrl').value = data.config.baseUrl || 'https://live.ozone.fm:8443';
        document.getElementById('cfgMount').value = data.config.mount || '/listen';
        document.getElementById('cfgUsername').value = data.config.username || 'admin';
        document.getElementById('cfgPassword').value = data.config.password || '';
        document.getElementById('cfgStationName').value = data.config.stationName || 'OZONE.FM';
        document.getElementById('cfgSourceMode').value = data.config.sourceMode || 'auto';
        document.getElementById('cfgMaxCapacity').value = data.config.maxListenersCapacity || 500;
        document.getElementById('cfgReturningMinAvgSec').value =
          Number.isFinite(Number(data.config.returningMinAvgSec)) ? Number(data.config.returningMinAvgSec) : 60;
        document.getElementById('cfgReturningExcludeBots').checked = data.config.returningExcludeBots !== false;
        document.getElementById('cfgRequireDashboardAuth').checked = data.config.requireDashboardAuth !== false;
        document.getElementById('cfgIgnoreTls').checked = data.config.ignoreTlsErrors !== false;
      }
      document.getElementById('testConnectionResultBox').style.display = 'none';
      settingsBackdrop.classList.remove('hidden');
    });

    const closeSettings = () => settingsBackdrop.classList.add('hidden');
    document.getElementById('closeSettingsModalBtn')?.addEventListener('click', closeSettings);
    document.getElementById('cancelSettingsBtn')?.addEventListener('click', closeSettings);

    document.getElementById('testConnectionBtn')?.addEventListener('click', async () => {
      const box = document.getElementById('testConnectionResultBox');
      box.style.display = 'block';
      box.style.background = 'var(--bg-canvas)';
      box.style.color = 'var(--text-secondary)';
      box.textContent = 'Testing connection to Icecast endpoint...';

      const payload = {
        baseUrl: document.getElementById('cfgBaseUrl').value,
        mount: document.getElementById('cfgMount').value,
        username: document.getElementById('cfgUsername').value,
        password: document.getElementById('cfgPassword').value,
        ignoreTlsErrors: document.getElementById('cfgIgnoreTls').checked,
      };

      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        box.style.background = 'var(--accent-emerald-soft)';
        box.style.color = 'var(--accent-emerald)';
        box.textContent = `Connected in ${data.latencyMs}ms! Parsed ${data.listenerCount} active listeners (${data.format}) from ${data.endpointUsed}.`;
      } else {
        box.style.background = 'var(--accent-crimson-soft)';
        box.style.color = 'var(--accent-crimson)';
        box.textContent = `Connection failed (${data.latencyMs}ms): ${data.error}`;
      }
    });

    document.getElementById('settingsForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const minAvgRaw = parseInt(document.getElementById('cfgReturningMinAvgSec').value, 10);
      const payload = {
        baseUrl: document.getElementById('cfgBaseUrl').value,
        mount: document.getElementById('cfgMount').value,
        username: document.getElementById('cfgUsername').value,
        password: document.getElementById('cfgPassword').value,
        stationName: document.getElementById('cfgStationName').value,
        sourceMode: document.getElementById('cfgSourceMode').value,
        maxListenersCapacity: parseInt(document.getElementById('cfgMaxCapacity').value, 10) || 500,
        returningMinAvgSec: Number.isFinite(minAvgRaw) ? Math.max(0, minAvgRaw) : 60,
        returningExcludeBots: document.getElementById('cfgReturningExcludeBots').checked,
        requireDashboardAuth: document.getElementById('cfgRequireDashboardAuth').checked,
        ignoreTlsErrors: document.getElementById('cfgIgnoreTls').checked,
      };
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      closeSettings();
      showToast('Configuration saved');
      await fetchDashboard();
    });

    // Import XSL Modal
    const importBackdrop = document.getElementById('importModalBackdrop');
    const openImport = () => {
      document.getElementById('importErrorMsg').textContent = '';
      importBackdrop.classList.remove('hidden');
    };
    document.getElementById('openImportModalBtn')?.addEventListener('click', openImport);
    document.getElementById('pasteXslQuickBtn')?.addEventListener('click', openImport);
    document.getElementById('closeImportModalBtn')?.addEventListener('click', () => importBackdrop.classList.add('hidden'));
    document.getElementById('cancelImportBtn')?.addEventListener('click', () => importBackdrop.classList.add('hidden'));

    document.getElementById('loadSampleXslBtn')?.addEventListener('click', () => {
      document.getElementById('importPayloadTextarea').value = `<div class="roundbox">
  <div class="mounthead"><h3 class="mount">Mountpoint /listen</h3></div>
  <div class="mountcont">
    <table class="yellowkeys">
      <thead>
        <tr><th>IP</th><th>Sec. connected</th><th>User Agent</th><th>Action</th></tr>
      </thead>
      <tbody>
        <tr><td>86.120.140.22</td><td>4215</td><td>VLC/3.0.21 LibVLC/3.0.21</td><td><a href="killclient.xsl?mount=/listen&amp;id=901">Kick</a></td></tr>
        <tr><td>82.132.219.44</td><td>1980</td><td>AppleCoreMedia/1.0.0.21F90 (iPhone; U; CPU OS 17_5_1 like Mac OS X)</td><td><a href="killclient.xsl?mount=/listen&amp;id=902">Kick</a></td></tr>
        <tr><td>91.198.174.192</td><td>845</td><td>Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36</td><td><a href="killclient.xsl?mount=/listen&amp;id=903">Kick</a></td></tr>
        <tr><td>188.25.102.61</td><td>3110</td><td>foobar2000/2.1.5</td><td><a href="killclient.xsl?mount=/listen&amp;id=904">Kick</a></td></tr>
        <tr><td>212.58.244.23</td><td>5420</td><td>Sonos/79.1-53290 (ZP120)</td><td><a href="killclient.xsl?mount=/listen&amp;id=905">Kick</a></td></tr>
        <tr><td>145.239.88.14</td><td>612</td><td>TuneIn Radio/34.2 (Android 14; Pixel 8 Pro; ExoPlayerLib/2.19.1)</td><td><a href="killclient.xsl?mount=/listen&amp;id=906">Kick</a></td></tr>
      </tbody>
    </table>
  </div>
</div>`;
    });

    document.getElementById('submitImportBtn')?.addEventListener('click', async () => {
      const payload = document.getElementById('importPayloadTextarea').value;
      const errEl = document.getElementById('importErrorMsg');
      errEl.textContent = '';

      const res = await fetch('/api/import-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      });
      const data = await res.json();
      if (!data.ok) {
        errEl.textContent = data.error || 'Import failed';
        return;
      }
      importBackdrop.classList.add('hidden');
      showToast(`Parsed ${data.importedCount} listeners from ${data.format.toUpperCase()} snapshot!`);
      await fetchDashboard();
    });

    // IP Dossier Modal Close
    const ipBackdrop = document.getElementById('ipModalBackdrop');
    document.getElementById('closeIpModalBtn')?.addEventListener('click', () => ipBackdrop.classList.add('hidden'));
    document.getElementById('closeIpModalFooterBtn')?.addEventListener('click', () => ipBackdrop.classList.add('hidden'));

    window.addEventListener('resize', () => {
      if (dashboardState) {
        renderHistoryChart(dashboardState.history);
        renderTimeOfDayAndConnectedStats(dashboardState.timeOfDay, dashboardState.kpis);
      }
    });
  }

  function startVuAnimation(container) {
    if (!container) return;
    container.classList.add('active');
    const bars = container.querySelectorAll('.vu-bar');
    if (vuAnimationTimer) clearInterval(vuAnimationTimer);
    vuAnimationTimer = setInterval(() => {
      bars.forEach(b => {
        const h = Math.floor(4 + Math.random() * 14);
        b.style.height = `${h}px`;
      });
    }, 130);
  }

  function stopVuAnimation(container) {
    if (vuAnimationTimer) clearInterval(vuAnimationTimer);
    if (!container) return;
    container.classList.remove('active');
    container.querySelectorAll('.vu-bar').forEach(b => {
      b.style.height = '4px';
    });
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function restartFrontendTimer(intervalSec = 10) {
    if (frontendPollTimer) clearInterval(frontendPollTimer);
    frontendPollTimer = setInterval(() => {
      fetchDashboard();
    }, Math.max(3, intervalSec) * 1000);
  }

  // Initialize
  setupInteractions();
  fetchDashboard();
  restartFrontendTimer(10);
})();
