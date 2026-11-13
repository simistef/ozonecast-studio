(function () {
  let dashboardState = null;
  let lastFetchClientTime = Date.now();
  let selectedRangeMinutes = 60;
  let excludeBotsSetting = localStorage.getItem('ozonecast_exclude_bots') === '1';
  let dedupeListenersSetting = localStorage.getItem('ozonecast_dedupe_listeners') !== '0'; // default true
  let mapViewMode = 'europe'; // 'europe' | 'romania' | 'world'
  let geoTabMode = 'countries'; // 'countries' | 'cities'
  let rightMidTabMode = 'retention'; // 'retention' | 'events'
  let breakdownScopeMode = localStorage.getItem('ozonecast_breakdown_scope') || 'live'; // 'live' | '24h' | '7d' | 'all'
  let timeOfDayDayMode = localStorage.getItem('ozonecast_time_of_day_day') || 'all'; // 'all' | 'weekdays' | 'weekend' | 'mon' | 'tue' | ...
  let detractorScopeMode = localStorage.getItem('ozonecast_detractor_scope') || 'past_24h';
  let returningSortMode = localStorage.getItem('ozonecast_returning_sort') || 'total_time'; // 'total_time' | 'sessions'
  let tableSearchQuery = '';
  let tableCategoryFilter = 'ALL';
  let tableBadgeFilter = 'ALL';
  let tableSortField = 'connectedSeconds';
  let tableSortAsc = false;
  let currentHistoryData = [];
  let currentTrackChanges = [];
  let historyHoverIdx = null;
  let showTracksSetting = localStorage.getItem('ozonecast_show_tracks') !== '0'; // default true
  // Bot category groups collapsed by default; expanded groups tracked in localStorage
  let expandedBotCategories = new Set(JSON.parse(localStorage.getItem('ozonecast_expanded_bots') || '[]'));
  let themeMode = localStorage.getItem('ozonecast_theme_mode') || 'auto'; // 'auto' | 'light' | 'dark'
  let frontendPollTimer = null;
  let vuAnimationTimer = null;

  function isDaytime() {
    const hours = new Date().getHours();
    return hours >= 7 && hours < 19; // 7:00 AM to 6:59 PM is day
  }

  function resolveEffectiveTheme(mode) {
    if (mode === 'light') return 'light';
    if (mode === 'dark') return 'dark';
    return isDaytime() ? 'light' : 'dark';
  }

  function applyTheme(mode, notify = false) {
    themeMode = mode || 'auto';
    localStorage.setItem('ozonecast_theme_mode', themeMode);
    const effective = resolveEffectiveTheme(themeMode);
    document.documentElement.setAttribute('data-theme', effective);
    document.documentElement.setAttribute('data-theme-mode', themeMode);

    // Update active button state
    document.querySelectorAll('#themeSwitchGroup .theme-btn').forEach(btn => {
      const m = btn.getAttribute('data-theme-mode');
      btn.classList.toggle('active', m === themeMode);
    });

    const autoLabel = document.getElementById('themeAutoLabel');
    if (autoLabel) {
      autoLabel.textContent = `Auto (${isDaytime() ? 'Day' : 'Night'})`;
    }

    // Redraw historical chart with updated theme colors if data is available
    if (typeof renderHistoryChart === 'function' && Array.isArray(currentHistoryData) && currentHistoryData.length > 0) {
      renderHistoryChart(currentHistoryData, currentTrackChanges);
    }

    if (notify) {
      const modeNames = {
        auto: `Auto mode: ${isDaytime() ? '☀️ White / Day theme (07:00–19:00)' : '🌙 Dark / Night theme'}`,
        light: '☀️ White / Day theme locked',
        dark: '🌙 Dark / Night theme locked',
      };
      showToast(modeNames[themeMode] || `Theme: ${themeMode}`);
    }
  }

  // Apply initial theme immediately on script initialization
  applyTheme(themeMode, false);

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

  function formatRelativeTime(ts) {
    if (!ts) return '--';
    const diffSec = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Composite device/agent key:
  // Same IP + same player/user-agent count as 1 listener.
  // Separate players or agents on the same IP count as separate listeners.
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

  // Listener Badges & Loyalty Classification
  function getListenerBadges(listener, liveConnectedSeconds = 0) {
    const badges = [];
    if (!listener) return badges;

    const friendlyName = (listener.friendlyName || '').trim();
    const lowerName = friendlyName.toLowerCase();
    const isMe = lowerName === 'me' || lowerName.startsWith('me ') || lowerName === 'admin' || lowerName.startsWith('admin ');
    const isBot = Boolean(listener.isBot || listener.isManualBot || listener.ua?.isRipper || listener.ua?.category === 'Bot / Ripper');

    // 1. Station Admin ("Me")
    if (isMe) {
      badges.push({
        id: 'admin',
        type: 'admin',
        label: '👑 Station Admin',
        shortLabel: '👑 Admin',
        className: 'badge-admin',
        tooltip: 'Station Admin IP ("Me") • Excluded from detractor statistics'
      });
    }

    // 2. Bot / Stream Ripper
    if (isBot) {
      badges.push({
        id: 'bot',
        type: 'bot',
        label: '🤖 Bot / Ripper',
        shortLabel: '🤖 Bot',
        className: 'badge-bot',
        tooltip: 'Classified as stream ripper or automated crawler'
      });
      return badges;
    }

    const h = listener.historySummary || {};
    const sessionCount = Number(h.sessionCount ?? listener.sessionCount ?? 1);
    const totalDuration = Number(h.totalDurationSeconds ?? listener.totalDurationSeconds ?? liveConnectedSeconds);
    const longestSession = Number(h.longestSessionSeconds ?? liveConnectedSeconds);
    const allTimeRank = h.allTimeRank ?? listener.allTimeRank ?? null;
    const firstSeen = Number(h.firstSeen ?? listener.firstSeen ?? 0);

    // 3. Top Listener Rank Badges
    if (allTimeRank && allTimeRank > 0) {
      if (allTimeRank === 1) {
        badges.push({
          id: 'top',
          type: 'top',
          label: '🌟 Top #1 Listener',
          shortLabel: '🌟 #1 Top',
          className: 'badge-top-1',
          tooltip: `#1 Top Listener station-wide • Total listening: ${formatDurationHuman(totalDuration)} (${sessionCount} visits)`
        });
      } else if (allTimeRank <= 3) {
        badges.push({
          id: 'top',
          type: 'top',
          label: `⭐ Top 3 (#${allTimeRank})`,
          shortLabel: `⭐ Top #${allTimeRank}`,
          className: 'badge-top',
          tooltip: `Top 3 Listener station-wide (Rank #${allTimeRank}) • Total: ${formatDurationHuman(totalDuration)}`
        });
      } else if (allTimeRank <= 5) {
        badges.push({
          id: 'top',
          type: 'top',
          label: `⭐ Top 5 (#${allTimeRank})`,
          shortLabel: `⭐ Top 5`,
          className: 'badge-top',
          tooltip: `Top 5 Listener station-wide (Rank #${allTimeRank}) • Total: ${formatDurationHuman(totalDuration)}`
        });
      } else if (allTimeRank <= 10) {
        badges.push({
          id: 'top',
          type: 'top',
          label: `⭐ Top 10 (#${allTimeRank})`,
          shortLabel: `⭐ Top 10`,
          className: 'badge-top',
          tooltip: `Top 10 Listener station-wide (Rank #${allTimeRank}) • Total: ${formatDurationHuman(totalDuration)}`
        });
      }
    }

    // 4. Frequency & Return Badges
    if (sessionCount >= 5) {
      badges.push({
        id: 'frequent',
        type: 'frequent',
        label: `🔄 Frequent (${sessionCount} visits)`,
        shortLabel: `🔄 Frequent (${sessionCount}x)`,
        className: 'badge-frequent',
        tooltip: `Frequent repeat listener • ${sessionCount} distinct listening sessions recorded`
      });
    } else if (sessionCount >= 2) {
      badges.push({
        id: 'returning',
        type: 'returning',
        label: `🔁 Returning (${sessionCount} visits)`,
        shortLabel: `🔁 Returning (${sessionCount}x)`,
        className: 'badge-returning',
        tooltip: `Returning listener • Has tuned in ${sessionCount} times`
      });
    } else {
      // 1 session: check if new
      const now = Date.now();
      const isFirstVisit = !firstSeen || (now - firstSeen) < 48 * 3600 * 1000;
      if (isFirstVisit) {
        badges.push({
          id: 'new',
          type: 'new',
          label: '✨ New Listener',
          shortLabel: '✨ New',
          className: 'badge-new',
          tooltip: 'First-time listener • First seen on OzoneCast recently'
        });
      }
    }

    // 5. Marathon Listening Badges
    const effectiveLiveSec = Math.max(liveConnectedSeconds, listener.connectedSeconds || 0);
    if (effectiveLiveSec >= 7200 || longestSession >= 10800) {
      const hrs = (effectiveLiveSec / 3600).toFixed(1);
      badges.push({
        id: 'marathon',
        type: 'marathon',
        label: `⚡ Marathon (${hrs}h)`,
        shortLabel: `⚡ Marathon`,
        className: 'badge-marathon',
        tooltip: `Marathon listening session • Active for ${formatDurationHuman(effectiveLiveSec)} in a single session`
      });
    }

    // 6. Superfan Badge (cumulative > 24 hours, if not #1 top)
    if (totalDuration >= 86400 && allTimeRank !== 1) {
      const totHrs = (totalDuration / 3600).toFixed(0);
      badges.push({
        id: 'superfan',
        type: 'superfan',
        label: `🏆 Superfan (${totHrs}h+)`,
        shortLabel: `🏆 Superfan`,
        className: 'badge-superfan',
        tooltip: `Station Superfan • Accumulated over ${totHrs} hours of total listening time`
      });
    }

    return badges;
  }

  function renderListenerBadgesHtml(badges, maxBadges = 3) {
    if (!badges || badges.length === 0) return '';
    const visible = badges.slice(0, maxBadges);
    const extraCount = badges.length - visible.length;
    const extraBadge = extraCount > 0
      ? `<span class="listener-badge badge-top" style="opacity:0.85;font-size:10px;padding:1px 5px" title="${escapeHtml(badges.slice(maxBadges).map(b => b.label).join(', '))}">+${extraCount} more</span>`
      : '';

    return `
      <div class="listener-badges-row">
        ${visible.map(b => `
          <span class="listener-badge ${escapeHtml(b.className)}" title="${escapeHtml(b.tooltip)}">
            ${escapeHtml(b.label)}
          </span>
        `).join('')}
        ${extraBadge}
      </div>
    `;
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
      const res = await fetch(`/api/dashboard?rangeMinutes=${selectedRangeMinutes}&returningSortBy=${encodeURIComponent(returningSortMode)}`);
      if (!res.ok) {
        console.warn(`Dashboard telemetry HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (!data.ok) {
        console.warn('Dashboard telemetry response not ok:', data.error);
        return;
      }
      dashboardState = data;
      lastFetchClientTime = Date.now();
      renderAll();
    } catch (err) {
      console.error('Failed to load dashboard telemetry:', err);
    }
  }

  function getActiveBreakdowns() {
    if (!dashboardState) return null;
    if (dashboardState.breakdownsByPeriod && dashboardState.breakdownsByPeriod[breakdownScopeMode]) {
      return dashboardState.breakdownsByPeriod[breakdownScopeMode];
    }
    return dashboardState.breakdowns || null;
  }

  function updateScopeBadges() {
    const scopeBadge = document.getElementById('breakdownActiveScopeBadge');
    const geoBadge = document.getElementById('geoTimeScopeBadge');
    const geoSub = document.getElementById('geoSubtitle');
    const mapBadge = document.getElementById('mapTimeScopeBadge');
    const mapSub = document.getElementById('mapSubtitle');
    const retentionBadge = document.getElementById('retentionTimeScopeBadge');
    const playersBadge = document.getElementById('playersTimeScopeBadge');
    const playersSub = document.getElementById('playersSubtitle');
    const categoriesBadge = document.getElementById('categoriesTimeScopeBadge');
    const categoriesSub = document.getElementById('categoriesSubtitle');
    const platformsBadge = document.getElementById('platformsTimeScopeBadge');
    const platformsSub = document.getElementById('platformsSubtitle');

    const scopeConfig = {
      live: {
        label: 'Live Active Connections',
        badgeClass: 'time-bound-badge live',
        badgeText: 'Live Active',
        geoSub: 'Listener share & average session time by location (Live active connections)',
        mapSub: 'Real-time MaxMind GeoIP coordinate clustering across active connections',
        retentionText: 'Live Cohort',
        techSub: 'Live active connections',
      },
      '24h': {
        label: 'Past 24 Hours (SQLite)',
        badgeClass: 'time-bound-badge time-24h',
        badgeText: 'Past 24h',
        geoSub: 'Listener share & average session time by location (Unique listeners & connection sessions over 24h)',
        mapSub: 'MaxMind GeoIP locations for unique listener sessions over the past 24 hours',
        retentionText: '24h Sessions',
        techSub: 'All sessions over past 24 hours',
      },
      '7d': {
        label: 'Past 7 Days (SQLite)',
        badgeClass: 'time-bound-badge time-7d',
        badgeText: 'Past 7d',
        geoSub: 'Listener share & average session time by location (Unique listeners & connection sessions over 7d)',
        mapSub: 'MaxMind GeoIP locations for unique listener sessions over the past 7 days',
        retentionText: '7d Sessions',
        techSub: 'All sessions over past 7 days',
      },
      all: {
        label: 'All-Time Station History',
        badgeClass: 'time-bound-badge alltime',
        badgeText: 'All-Time',
        geoSub: 'Lifetime listener share & average session time by location (Unique listeners & connection sessions All-Time)',
        mapSub: 'MaxMind GeoIP locations across all recorded station history in SQLite',
        retentionText: 'All-Time Sessions',
        techSub: 'All recorded station history',
      },
    };

    const cfg = scopeConfig[breakdownScopeMode] || scopeConfig.live;
    if (scopeBadge) {
      scopeBadge.className = cfg.badgeClass;
      scopeBadge.textContent = cfg.label;
    }
    if (geoBadge) {
      geoBadge.className = cfg.badgeClass;
      geoBadge.textContent = cfg.badgeText;
    }
    if (geoSub) geoSub.textContent = cfg.geoSub;
    if (mapBadge) {
      mapBadge.className = cfg.badgeClass;
      mapBadge.textContent = cfg.badgeText;
    }
    if (mapSub) mapSub.textContent = cfg.mapSub;
    if (retentionBadge && rightMidTabMode === 'retention') {
      retentionBadge.className = cfg.badgeClass;
      retentionBadge.textContent = cfg.retentionText;
    }
    if (playersBadge) {
      playersBadge.className = cfg.badgeClass;
      playersBadge.textContent = cfg.badgeText;
    }
    if (playersSub) playersSub.textContent = `Parsed from Icecast User-Agent headers (${cfg.techSub})`;
    if (categoriesBadge) {
      categoriesBadge.className = cfg.badgeClass;
      categoriesBadge.textContent = cfg.badgeText;
    }
    if (categoriesSub) categoriesSub.textContent = `Web Browser vs Native Player vs Smart Speaker (${cfg.techSub})`;
    if (platformsBadge) {
      platformsBadge.className = cfg.badgeClass;
      platformsBadge.textContent = cfg.badgeText;
    }
    if (platformsSub) platformsSub.textContent = `Desktop, Mobile, and Embedded Hardware (${cfg.techSub})`;

    // Sync active segmented button
    document.querySelectorAll('#breakdownScopeTabs .seg-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-scope') === breakdownScopeMode);
    });
  }

  function renderKpiCards() {
    if (!dashboardState) return;
    const { connection, kpis, breakdowns } = dashboardState;
    const activeBreakdowns = getActiveBreakdowns() || breakdowns || {};
    const mode = breakdownScopeMode || 'live';

    // 1. Listeners Card (Concurrent in live, Unique in historical)
    const card1Title = document.getElementById('kpiCard1Title');
    const card1Badge = document.getElementById('kpiCard1ScopeBadge');
    const card1Number = document.getElementById('kpiCurrentListeners');
    const card1Tag = document.getElementById('kpiUniqueIpsTag');
    const botFilterBadge = document.getElementById('kpiBotsFilterBadge');
    const capPctBadge = document.getElementById('capacityPctBadge');
    const capMeterFill = document.getElementById('capacityMeterFill');
    const card1FooterLeft = document.getElementById('kpiCard1FooterLeft');
    const card1FooterRight = document.getElementById('kpiCard1FooterRight');

    const capPct = Math.min(100, Math.round((kpis.currentListeners / (kpis.maxCapacity || 500)) * 100));

    if (botFilterBadge) {
      if (mode === 'live') {
        const botCount = kpis.botListenersCount || 0;
        botFilterBadge.textContent = botCount > 0 ? `🤖 ${botCount} Bot${botCount === 1 ? '' : 's'} Ignored` : '🤖 Bots Ignored';
        botFilterBadge.title = `${botCount} flagged bot/crawler/probe connections isolated from listener analytics`;
      } else {
        botFilterBadge.textContent = '🤖 Bots Excluded';
        botFilterBadge.title = 'Flagged bot and crawler connections excluded from historical metrics';
      }
      botFilterBadge.classList.remove('hidden');
    }

    if (mode === 'live') {
      if (card1Title) card1Title.textContent = 'CONCURRENT LISTENERS';
      if (card1Badge) {
        card1Badge.className = 'time-bound-badge live';
        card1Badge.textContent = 'Live Now';
        card1Badge.title = 'Real-time live connections currently streaming';
      }
      if (card1Number) card1Number.textContent = kpis.currentListeners;
      const totalStreams = kpis.totalStreams || kpis.totalListenersRaw || kpis.currentListeners;
      const streamSuffix = (totalStreams && totalStreams > kpis.currentListeners)
        ? ` (${totalStreams} streams)`
        : '';
      if (card1Tag) card1Tag.textContent = `${kpis.uniqueIps} unique IPs${streamSuffix}`;
      if (capPctBadge) capPctBadge.textContent = `${capPct}% cap`;
      if (capMeterFill) capMeterFill.style.width = `${Math.max(2, capPct)}%`;
      if (card1FooterLeft) card1FooterLeft.innerHTML = `Mount: <strong id="kpiMountName" class="mono">${escapeHtml(connection.mount || '/listen')}</strong>`;
      if (card1FooterRight) card1FooterRight.innerHTML = `Max: <strong id="kpiMaxCapacity" class="mono">${kpis.maxCapacity || 500}</strong>`;
    } else {
      const modeLabels = {
        '24h': { title: '24H UNIQUE LISTENERS', badge: 'Past 24h', badgeClass: 'time-bound-badge time-24h', footer: '24h Sessions' },
        '7d': { title: '7D UNIQUE LISTENERS', badge: 'Past 7d', badgeClass: 'time-bound-badge time-7d', footer: '7d Sessions' },
        all: { title: 'ALL-TIME UNIQUE LISTENERS', badge: 'All-Time', badgeClass: 'time-bound-badge alltime', footer: 'All Sessions' },
      };
      const cfg = modeLabels[mode] || modeLabels['24h'];
      if (card1Title) card1Title.textContent = cfg.title;
      if (card1Badge) {
        card1Badge.className = cfg.badgeClass;
        card1Badge.textContent = cfg.badge;
        card1Badge.title = `De-duplicated unique listener IPs over ${cfg.badge}`;
      }
      const uniqueCount = activeBreakdowns.uniqueIps ?? (mode === '24h' ? kpis.uniqueIps24h : 0);
      if (card1Number) card1Number.textContent = uniqueCount;
      const sessCount = activeBreakdowns.totalSessions ?? (mode === '24h' ? kpis.totalSessions24h : 0);
      if (card1Tag) card1Tag.textContent = `${sessCount} total sessions`;
      if (capPctBadge) capPctBadge.textContent = `${uniqueCount} unique`;
      const histCap = Math.min(100, Math.round((uniqueCount / (kpis.maxCapacity || 500)) * 100));
      if (capMeterFill) capMeterFill.style.width = `${Math.max(2, histCap)}%`;
      if (card1FooterLeft) card1FooterLeft.innerHTML = `Active Live: <strong class="mono">${kpis.currentListeners}</strong>`;
      if (card1FooterRight) card1FooterRight.innerHTML = `${cfg.footer}: <strong class="mono">${sessCount}</strong>`;
    }

    // 2. Peak Listeners Card
    const peakScopeBadge = document.getElementById('kpiPeakScopeBadge');
    const allTimeBadge = document.getElementById('kpiAllTimePeakBadge');
    const peakNumber = document.getElementById('kpiPeak24h');
    const peakDeltaTag = document.getElementById('kpiPeakDeltaTag');
    const peakTimeEl = document.getElementById('kpiPeakTime');
    const peakFooterRight = document.getElementById('kpiPeakFooterRight');

    if (allTimeBadge) allTimeBadge.textContent = `All-Time: ${kpis.allTimePeak}`;

    if (mode === 'live' || mode === '24h') {
      if (peakScopeBadge) {
        peakScopeBadge.className = 'time-bound-badge time-24h';
        peakScopeBadge.textContent = '24h Peak';
        peakScopeBadge.title = 'Rolling peak concurrency over the last 24 hours';
      }
      if (peakNumber) peakNumber.textContent = kpis.peak24h;
      const diffFromPeak = kpis.peak24h - kpis.currentListeners;
      if (peakDeltaTag) {
        peakDeltaTag.textContent = diffFromPeak <= 0 ? 'At Peak Now!' : `-${diffFromPeak} from peak`;
      }
      if (peakTimeEl) {
        peakTimeEl.textContent = new Date(kpis.peak24hTs).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
      }
      if (peakFooterRight) peakFooterRight.textContent = mode === 'live' ? 'SQLite Tracked' : '24h Concurrency';
    } else if (mode === '7d') {
      const peakVal = activeBreakdowns.peak ?? kpis.peak7d ?? kpis.peak24h;
      const peakTs = activeBreakdowns.peakTs || kpis.peak7dTs || kpis.peak24hTs;
      if (peakScopeBadge) {
        peakScopeBadge.className = 'time-bound-badge time-7d';
        peakScopeBadge.textContent = '7d Peak';
        peakScopeBadge.title = 'Peak listener concurrency recorded over the last 7 days';
      }
      if (peakNumber) peakNumber.textContent = peakVal;
      const diffFromPeak = peakVal - kpis.currentListeners;
      if (peakDeltaTag) {
        peakDeltaTag.textContent = diffFromPeak <= 0 ? 'At 7d Peak Now!' : `-${diffFromPeak} from 7d peak`;
      }
      if (peakTimeEl) {
        peakTimeEl.textContent = `${new Date(peakTs).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${new Date(peakTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
      if (peakFooterRight) peakFooterRight.textContent = '7d Concurrency';
    } else {
      // 'all'
      const peakVal = activeBreakdowns.peak ?? kpis.allTimePeak ?? kpis.peak24h;
      const peakTs = activeBreakdowns.peakTs || kpis.allTimePeakTs || kpis.peak24hTs;
      if (peakScopeBadge) {
        peakScopeBadge.className = 'time-bound-badge alltime';
        peakScopeBadge.textContent = 'Record Peak';
        peakScopeBadge.title = 'Highest listener concurrency ever recorded in SQLite history';
      }
      if (peakNumber) peakNumber.textContent = peakVal;
      const diffFromPeak = peakVal - kpis.currentListeners;
      if (peakDeltaTag) {
        peakDeltaTag.textContent = diffFromPeak <= 0 ? 'At Record Peak!' : `-${diffFromPeak} from record`;
      }
      if (peakTimeEl) {
        peakTimeEl.textContent = `${new Date(peakTs).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
      }
      if (peakFooterRight) peakFooterRight.textContent = 'All-Time Record';
    }

    // 3. Avg Tune-In Duration Card
    const avgDurationBadge = document.getElementById('kpiAvgDurationScopeBadge');
    const longestTag = document.getElementById('kpiLongestTag');
    const avgDurationEl = document.getElementById('kpiAvgDuration');
    const tlhBadge = document.getElementById('kpiTlhBadge');
    const card3FooterLeft = document.getElementById('kpiCard3FooterLeft');
    const card3FooterRight = document.getElementById('kpiCard3FooterRight');

    const durationScopeConfig = {
      live: { badge: 'Live Active', badgeClass: 'time-bound-badge live' },
      '24h': { badge: 'Past 24h', badgeClass: 'time-bound-badge time-24h' },
      '7d': { badge: 'Past 7d', badgeClass: 'time-bound-badge time-7d' },
      all: { badge: 'All-Time', badgeClass: 'time-bound-badge alltime' },
    };
    const durCfg = durationScopeConfig[mode] || durationScopeConfig.live;
    if (avgDurationBadge) {
      avgDurationBadge.className = durCfg.badgeClass;
      avgDurationBadge.textContent = durCfg.badge;
      avgDurationBadge.title = `Average duration of listeners in ${durCfg.badge}`;
    }

    if (mode === 'live') {
      if (avgDurationEl) avgDurationEl.textContent = formatDurationHuman(kpis.avgSessionDurationSec);
      if (longestTag) longestTag.textContent = `Max: ${formatDurationHuman(kpis.longestSessionSec)}`;
      if (tlhBadge) tlhBadge.textContent = `${kpis.totalActiveListeningHours} TLH`;
      if (card3FooterLeft) card3FooterLeft.innerHTML = `Active TLH (Live): <strong class="mono">${kpis.totalActiveListeningHours} hrs</strong>`;
      if (card3FooterRight) card3FooterRight.innerHTML = `24h Total TLH: <strong class="mono">${kpis.totalListeningHours24h} hrs</strong>`;
    } else {
      const avgSec = activeBreakdowns.avgSessionDurationSec || 0;
      const maxSec = activeBreakdowns.longestSessionSec || 0;
      const medSec = activeBreakdowns.medianSessionDurationSec || 0;
      const tlhVal = activeBreakdowns.totalListeningHours ?? (mode === '24h' ? kpis.totalListeningHours24h : 0);
      if (avgDurationEl) avgDurationEl.textContent = formatDurationHuman(avgSec);
      if (longestTag) longestTag.textContent = `Max: ${formatDurationHuman(maxSec)}`;
      if (tlhBadge) tlhBadge.textContent = `${tlhVal} TLH`;
      if (card3FooterLeft) card3FooterLeft.innerHTML = `Median Stay: <strong class="mono">${formatDurationHuman(medSec)}</strong>`;
      const tlhLabel = mode === '24h' ? '24h Total TLH' : (mode === '7d' ? '7d Total TLH' : 'All-Time TLH');
      if (card3FooterRight) card3FooterRight.innerHTML = `${tlhLabel}: <strong class="mono">${tlhVal} hrs</strong>`;
    }

    // 4. Geographic Reach & Sessions Card
    const geoScopeBadge = document.getElementById('kpiGeoScopeBadge');
    const dupConnectionsTag = document.getElementById('kpiDupConnectionsTag');
    const countriesCountEl = document.getElementById('kpiCountriesCount');
    const topCountryBadge = document.getElementById('kpiTopCountryBadge');
    const card4FooterLeft = document.getElementById('kpiCard4FooterLeft');
    const card4FooterRight = document.getElementById('kpiCard4FooterRight');

    const activeCountries = mode === 'live' ? (breakdowns.countries || []) : (activeBreakdowns.countries || []);
    const countriesCount = activeCountries.length;

    if (geoScopeBadge) {
      const cLabel = `${countriesCount} ${countriesCount === 1 ? 'country' : 'countries'}`;
      if (mode === 'live') {
        geoScopeBadge.className = 'time-bound-badge live';
        geoScopeBadge.textContent = `● Live: ${cLabel}`;
      } else if (mode === '24h') {
        geoScopeBadge.className = 'time-bound-badge time-24h';
        geoScopeBadge.textContent = `24h: ${cLabel}`;
      } else if (mode === '7d') {
        geoScopeBadge.className = 'time-bound-badge time-7d';
        geoScopeBadge.textContent = `7d: ${cLabel}`;
      } else {
        geoScopeBadge.className = 'time-bound-badge alltime';
        geoScopeBadge.textContent = `All-Time: ${cLabel}`;
      }
    }

    if (countriesCountEl) countriesCountEl.textContent = countriesCount;

    const topCountry = activeCountries[0];
    if (topCountryBadge) {
      topCountryBadge.innerHTML = topCountry
        ? `<span style="display:inline-flex;align-items:center;gap:5px">Top: ${renderCountryFlag(topCountry.countryCode, topCountry.countryName, 15)} ${escapeHtml(topCountry.countryName)} (${topCountry.sharePct}%)</span>`
        : 'Top: --';
    }

    if (mode === 'live') {
      if (dupConnectionsTag) dupConnectionsTag.textContent = `${kpis.duplicateConnections} multi-stream`;
      if (card4FooterLeft) card4FooterLeft.innerHTML = `24h Unique IPs: <strong class="mono">${kpis.uniqueIps24h}</strong>`;
      if (card4FooterRight) card4FooterRight.innerHTML = `24h Sessions: <strong class="mono">${kpis.totalSessions24h}</strong>`;
    } else {
      const citiesCount = (activeBreakdowns.cities || []).length;
      if (dupConnectionsTag) dupConnectionsTag.textContent = `${citiesCount} unique ${citiesCount === 1 ? 'city' : 'cities'}`;
      const uniqueIps = activeBreakdowns.uniqueIps ?? (mode === '24h' ? kpis.uniqueIps24h : 0);
      const totalSess = activeBreakdowns.totalSessions ?? (mode === '24h' ? kpis.totalSessions24h : 0);
      const ipLabel = mode === '24h' ? 'Unique Listeners' : (mode === '7d' ? '7d Unique Listeners' : 'All-Time Listeners');
      const sessLabel = mode === '24h' ? 'Total Sessions' : (mode === '7d' ? '7d Sessions' : 'All-Time Sessions');
      if (card4FooterLeft) card4FooterLeft.innerHTML = `${ipLabel}: <strong class="mono">${uniqueIps}</strong>`;
      if (card4FooterRight) card4FooterRight.innerHTML = `${sessLabel}: <strong class="mono">${totalSess}</strong>`;
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

    // 2. KPI Cards (dynamically reactive to active period scope)
    renderKpiCards();

    const historyScopeBadge = document.getElementById('historyTimeScopeBadge');
    if (historyScopeBadge) {
      const rangeMap = {
        15: '⏱️ 15m Window',
        60: '⏱️ 1h Window',
        360: '⏱️ 6h Window',
        1440: '⏱️ 24h Window',
        10080: '📅 7d Window',
      };
      historyScopeBadge.textContent = rangeMap[selectedRangeMinutes] || `⏱️ ${selectedRangeMinutes}m Window`;
      historyScopeBadge.className = selectedRangeMinutes > 1440 ? 'time-bound-badge time-7d' : 'time-bound-badge time-24h';
    }

    updateScopeBadges();
    const activeBreakdowns = getActiveBreakdowns() || breakdowns;

    // 3. World Map & Geo Distribution (human listeners only)
    const svgEl = document.getElementById('worldMapSvg');
    const tooltipEl = document.getElementById('mapTooltip');
    if (window.OzoneWorldMap && svgEl) {
      let mapLocations = [];
      if (breakdownScopeMode === 'live') {
        mapLocations = (listeners || []).filter(l => !l.isBot);
      } else if (activeBreakdowns && activeBreakdowns.mapLocations) {
        mapLocations = activeBreakdowns.mapLocations.filter(l => !l.isBot);
      } else {
        mapLocations = [];
      }
      window.OzoneWorldMap.renderWorldMap(svgEl, tooltipEl, mapLocations, mapViewMode, ip => openIpInspector(ip));
    }
    renderGeoBreakdown(activeBreakdowns);

    // 4. Historical Chart & Retention / Events
    renderHistoryChart(history, dashboardState.trackChanges);
    renderRetentionAndEvents(activeBreakdowns.durationBuckets, recentEvents);

    // 4.5. Time-of-Day Profile, Connected Time Stats & Top 5 Returning Listeners
    renderTimeOfDayAndConnectedStats(dashboardState.timeOfDay, kpis);
    renderTopReturningListeners(dashboardState.topReturningListeners, kpis);

    // 4.75. Detractor Songs (Tune-Outs & Drop-Off Analytics)
    renderDetractorSongs(activeBreakdowns.detractorSongs || dashboardState.detractorSongs, activeBreakdowns.detractorSummary || dashboardState.detractorSummary);

    // 5. User-Agent / Player / OS Breakdowns
    renderDistributionList('playersDistList', activeBreakdowns.players, 'amber');
    renderDistributionList('categoriesDistList', activeBreakdowns.categories, 'cyan');
    renderDistributionList('platformsDistList', activeBreakdowns.platforms, 'emerald');

    // 6. Active Clients Table
    document.getElementById('tableEndpointLabel').textContent = connection.endpointUrl;
    renderClientsTable();

    // 7. Detected Bots, Scrapers & Monitoring Probes Card
    renderBotCard(dashboardState.botActivity);
  }

  function renderTimeOfDayAndConnectedStats(timeOfDay, kpis) {
    if (!timeOfDay) return;

    // Resolve the active profile based on timeOfDayDayMode
    const activeKey = (timeOfDay.profiles && timeOfDay.profiles[timeOfDayDayMode]) ? timeOfDayDayMode : 'all';
    const profile = (timeOfDay.profiles && timeOfDay.profiles[activeKey]) ? timeOfDay.profiles[activeKey] : timeOfDay;

    // 1. Update Scope Badge, Subtitle & Summary Tag
    const scopeBadge = document.getElementById('timeOfDayScopeBadge');
    const subtitleEl = document.getElementById('timeOfDaySubtitle');
    const summaryTag = document.getElementById('activeDaySummaryTag');

    const dayMeta = {
      all: { badge: '📅 7-Day Rolling Average', sub: 'When listeners usually tune in across the day (7-day hourly averages & dayparts from SQLite)', tag: '7-Day Combined' },
      weekdays: { badge: '📅 Weekdays Average (Mon–Fri)', sub: 'Audience listening curve and dayparts averaged across Monday through Friday', tag: 'Mon–Fri Weekdays' },
      weekend: { badge: '📅 Weekend Average (Sat–Sun)', sub: 'Audience listening curve and dayparts averaged across Saturday and Sunday', tag: 'Sat–Sun Weekend' },
      mon: { badge: '📅 Monday Audience Profile', sub: 'Hourly listening curve and daypart breakdown for Mondays', tag: 'Monday' },
      tue: { badge: '📅 Tuesday Audience Profile', sub: 'Hourly listening curve and daypart breakdown for Tuesdays', tag: 'Tuesday' },
      wed: { badge: '📅 Wednesday Audience Profile', sub: 'Hourly listening curve and daypart breakdown for Wednesdays', tag: 'Wednesday' },
      thu: { badge: '📅 Thursday Audience Profile', sub: 'Hourly listening curve and daypart breakdown for Thursdays', tag: 'Thursday' },
      fri: { badge: '📅 Friday Audience Profile', sub: 'Hourly listening curve and daypart breakdown for Fridays', tag: 'Friday' },
      sat: { badge: '📅 Saturday Audience Profile', sub: 'Hourly listening curve and daypart breakdown for Saturdays', tag: 'Saturday' },
      sun: { badge: '📅 Sunday Audience Profile', sub: 'Hourly listening curve and daypart breakdown for Sundays', tag: 'Sunday' },
    };

    const cfg = dayMeta[activeKey] || dayMeta.all;
    if (scopeBadge) {
      scopeBadge.textContent = cfg.badge;
      scopeBadge.className = activeKey === 'all' ? 'time-bound-badge time-7d' : 'time-bound-badge time-24h';
    }
    if (subtitleEl) {
      subtitleEl.textContent = cfg.sub;
    }
    if (summaryTag) {
      const avg = Number(profile.overallAvg) || 0;
      const peak = Number(profile.overallPeak) || 0;
      summaryTag.textContent = avg > 0
        ? `${cfg.tag} • Avg ${avg} (Peak ${peak})`
        : cfg.tag;
    }

    // 2. Update Peak Hour Tag
    const bestTag = document.getElementById('bestHourTag');
    if (bestTag) {
      bestTag.textContent = profile.bestHourAvg > 0
        ? `Peak Hour: ${profile.bestHourLabel} (avg ${profile.bestHourAvg})`
        : `Peak Hour: ${profile.bestHourLabel}`;
    }

    // 3. Render 7-Day Performance Cards Strip
    const dowStrip = document.getElementById('dayOfWeekOverviewStrip');
    if (dowStrip && Array.isArray(timeOfDay.daysOfWeek)) {
      dowStrip.innerHTML = timeOfDay.daysOfWeek
        .map(d => {
          const isSelected = activeKey === d.key;
          const todayDot = d.isToday ? '<span class="dow-card-today" title="Today"></span>' : '';
          const todayText = d.isToday ? ' <span style="font-size:9.5px;color:var(--accent-emerald)">(Today)</span>' : '';
          return `
            <div class="dow-card ${isSelected ? 'active' : ''}" data-select-day="${d.key}" title="Click to view ${d.name}'s hourly profile &amp; dayparts">
              <div class="dow-card-header">
                <span>${d.shortName}${todayText}</span>
                ${todayDot}
              </div>
              <div class="dow-card-metrics">
                <span style="color:var(--accent-amber)">avg ${d.avgListeners}</span>
                <span class="dow-card-sub">pk ${d.peakListeners}</span>
              </div>
              <div class="dow-card-sub" title="${d.bestHourLabel}">
                ${d.bestHourAvg > 0 ? `🔥 ${d.bestHourLabel.split(' – ')[0]}` : '💤 Quiet'}
              </div>
            </div>
          `;
        })
        .join('');
    }

    // 4. Update Segmented Day Tabs active class
    document.querySelectorAll('#timeOfDayDayTabs .seg-btn').forEach(btn => {
      const day = btn.getAttribute('data-day');
      btn.classList.toggle('active', day === activeKey);
    });

    // 5. Render 24-hour bar chart on #timeOfDayCanvas
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

      const hourly = profile.hourly || [];
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
        const isPeakHour = avg === profile.bestHourAvg && avg > 0;

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

    // 6. Render 4 Daypart cards
    const dpGrid = document.getElementById('daypartSummaryGrid');
    if (dpGrid && Array.isArray(profile.dayparts)) {
      dpGrid.innerHTML = profile.dayparts
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

    // 7. Render Connected Time Stats Strip (Mean, Median, P90, Longest)
    const ctStrip = document.getElementById('connectedTimeStatsStrip');
    if (ctStrip) {
      const stats = (profile.connectedTime && profile.connectedTime.sessionCount > 0)
        ? profile.connectedTime
        : kpis || {};

      ctStrip.innerHTML = `
        <div>
          <div style="font-size:11px;color:var(--text-muted)">MEAN CONNECTED TIME</div>
          <div class="mono" style="font-size:14px;font-weight:700;color:var(--accent-emerald)">${formatDurationHuman(stats.avgSessionDurationSec || 0)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">MEDIAN SESSION</div>
          <div class="mono" style="font-size:14px;font-weight:700">${formatDurationHuman(stats.medianSessionDurationSec || stats.avgSessionDurationSec || 0)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">90TH PERCENTILE</div>
          <div class="mono" style="font-size:14px;font-weight:700;color:var(--accent-cyan)">${formatDurationHuman(stats.p90SessionDurationSec || stats.longestSessionSec || 0)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">LONGEST SESSION</div>
          <div class="mono" style="font-size:14px;font-weight:700;color:var(--accent-amber)">${formatDurationHuman(stats.longestSessionSec || 0)}</div>
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

    const sortSelect = document.getElementById('returningSortByQuickSelect');
    if (sortSelect) {
      const activeSort = kpis?.returningSortBy || returningSortMode || 'total_time';
      sortSelect.value = activeSort;
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
        const itemBadges = getListenerBadges({
          ...item,
          allTimeRank: item.rank,
        }, item.longestSessionSeconds || 0);

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
                  ${renderListenerBadgesHtml(itemBadges, 2)}
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

  // Render Detractor Songs (Tune-Outs & Drop-Off Analytics)
  function renderDetractorSongs(songsData, summaryData) {
    const listEl = document.getElementById('detractorSongsList');
    const kpiEl = document.getElementById('detractorKpiStrip');
    const scopeBadge = document.getElementById('detractorScopeBadge');
    const dropsBadge = document.getElementById('detractorTotalDropsBadge');

    let songs = songsData;
    let summary = summaryData;

    const periodKeyMap = {
      past_24h: '24h',
      past_7d: '7d',
      all_time: 'all',
    };
    const periodKey = periodKeyMap[detractorScopeMode] || '24h';
    if (dashboardState?.breakdownsByPeriod && dashboardState.breakdownsByPeriod[periodKey]) {
      const pData = dashboardState.breakdownsByPeriod[periodKey];
      if (pData.detractorSongs) songs = pData.detractorSongs;
      if (pData.detractorSummary) summary = pData.detractorSummary;
    }

    const scopeLabels = {
      past_24h: { text: '⏱️ Past 24h', badgeClass: 'time-bound-badge time-24h' },
      past_7d: { text: '📅 Past 7d', badgeClass: 'time-bound-badge time-7d' },
      all_time: { text: '🏆 All-Time', badgeClass: 'time-bound-badge alltime' },
    };
    const curScope = scopeLabels[detractorScopeMode] || scopeLabels.past_24h;

    if (scopeBadge) {
      scopeBadge.textContent = curScope.text;
      scopeBadge.className = curScope.badgeClass;
    }

    const totalUniqueIpsLost = summary?.uniqueDroppedListeners ?? (songs || []).reduce((acc, s) => acc + (s.uniqueIps || 0), 0);
    if (dropsBadge) {
      dropsBadge.textContent = `📉 ${totalUniqueIpsLost} Unique Listener IP${totalUniqueIpsLost === 1 ? '' : 's'} Lost`;
    }

    // Sync button active state
    document.querySelectorAll('#detractorScopeTabs .seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-scope') === detractorScopeMode);
    });

    // 1. Render 4-Card Summary Strip
    if (kpiEl) {
      const topTrack = (songs && songs[0]) || null;
      const topTrackTitle = topTrack ? topTrack.track : 'None';
      const avgPlaytime = summary?.avgPlaytimeWhenLeftSec || (topTrack ? topTrack.avgPlaytimeWhenLeftSec : 0);
      const avgStationStay = summary?.avgStationStaySec || (topTrack ? topTrack.avgStationStaySec : 0);
      const totalLostHrs = ((summary?.totalLostListeningSec || 0) / 3600).toFixed(1);

      kpiEl.innerHTML = `
        <div style="background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px;padding:9px 12px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600">UNIQUE LISTENERS LOST</div>
          <div class="mono" style="margin-top:2px;font-size:16px;font-weight:700;color:var(--accent-crimson)">
            ${totalUniqueIpsLost} <span style="font-size:11px;font-weight:500;color:var(--text-secondary)">unique IPs</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
            ${summary?.songsAffected || (songs || []).length} songs affected • Admin ("Me") &amp; bots excluded
          </div>
        </div>

        <div style="background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px;padding:9px 12px;min-width:0">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600">TOP DETRACTOR SONG</div>
          <div class="mono" style="margin-top:2px;font-size:14px;font-weight:700;color:var(--accent-amber);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(topTrackTitle)}">
            ${topTrack ? `#1 (${topTrack.uniqueIps} unique IPs)` : 'None'}
          </div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(topTrackTitle)}">
            ${escapeHtml(topTrackTitle)}
          </div>
        </div>

        <div style="background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px;padding:9px 12px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600">AVG PLAYTIME WHEN LEFT</div>
          <div class="mono" style="margin-top:2px;font-size:16px;font-weight:700;color:var(--accent-cyan)">
            ${avgPlaytime > 0 ? formatDurationClock(avgPlaytime) : '--:--'}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
            ${avgPlaytime > 0 ? `${formatDurationHuman(avgPlaytime)} into track` : 'No track progress recorded'}
          </div>
        </div>

        <div style="background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px;padding:9px 12px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600">PREVIOUS STATION STAY</div>
          <div class="mono" style="margin-top:2px;font-size:16px;font-weight:700;color:var(--accent-emerald)">
            ${avgStationStay > 0 ? formatDurationHuman(avgStationStay) : '0s'}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
            Avg station stay • ${totalLostHrs} hrs lost
          </div>
        </div>
      `;
    }

    // 2. Render Leaderboard List
    if (!listEl) return;
    const items = songs || [];
    if (items.length === 0) {
      listEl.innerHTML = `
        <div style="color:var(--text-muted);font-size:12.5px;padding:18px 14px;background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px;text-align:center">
          No unique listener drop-offs recorded for ${curScope.text.replace(/^[^\w]+/, '')} yet.
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:4px">
            Whenever unique listeners disconnect while a track is broadcasting, OzoneCast records the song title, playtime progress at disconnect, and their previous station listening time. (Station Admin "Me" IPs and bots are automatically excluded).
          </div>
        </div>
      `;
      return;
    }

    const maxDrops = items[0]?.uniqueIps || 1;

    listEl.innerHTML = items
      .map(song => {
        const pctOfTop = Math.min(100, Math.max(8, Math.round((song.uniqueIps / maxDrops) * 100)));
        const isNumOne = song.rank === 1;
        const rankColor = isNumOne ? 'var(--accent-crimson)' : 'var(--accent-amber)';
        const rankBg = isNumOne ? 'hsla(355,84%,60%,0.15)' : 'hsla(28,95%,56%,0.12)';
        const rankBorder = isNumOne ? 'hsla(355,84%,60%,0.35)' : 'hsla(28,95%,56%,0.3)';

        const timingTags = [];
        if (song.earlyDropoffs30s > 0) {
          timingTags.push(`<span class="kpi-subtag amber" style="font-size:10.5px;padding:1px 6px" title="${song.earlyDropoffs30s} unique listener(s) left in the first 30s (immediate intro skip)">⚡ ${song.earlyDropoffPct}% &lt;30s (Intro)</span>`);
        }
        if (song.midDropoffs2m > 0) {
          timingTags.push(`<span class="kpi-subtag cyan" style="font-size:10.5px;padding:1px 6px" title="${song.midDropoffs2m} unique listener(s) left between 30s and 2m (mid-track)">⏯️ ${song.midDropoffPct}% 30s–2m (Mid)</span>`);
        }
        if (song.lateDropoffs > 0) {
          timingTags.push(`<span class="kpi-subtag emerald" style="font-size:10.5px;padding:1px 6px" title="${song.lateDropoffs} unique listener(s) left after 2 minutes (late/outro)">⏳ ${song.lateDropoffPct}% &gt;2m (Late)</span>`);
        }
        const timingBadgesHtml = timingTags.join(' ');

        const minMaxStay = (song.minStationStaySec > 0 || song.maxStationStaySec > 0)
          ? `<span style="color:var(--text-muted);font-size:11px">(Min ${formatDurationHuman(song.minStationStaySec)} • Max ${formatDurationHuman(song.maxStationStaySec)})</span>`
          : '';

        return `
          <div class="event-row detractor-row" style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px">
            <div style="display:flex;align-items:flex-start;gap:12px;min-width:0;flex:1">
              <span class="mono" style="font-weight:700;font-size:13px;color:${rankColor};background:${rankBg};border:1px solid ${rankBorder};border-radius:4px;padding:2px 7px;width:30px;text-align:center;flex-shrink:0">#${song.rank}</span>
              <div style="min-width:0;flex:1">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span style="font-size:13.5px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:440px" title="${escapeHtml(song.track)}">
                    🎵 ${escapeHtml(song.track)}
                  </span>
                  <span class="mount-tag" style="background:hsla(355,84%,60%,0.15);color:hsl(355,95%,80%);border-color:hsla(355,80%,65%,0.3);font-size:11px;font-weight:600">
                    📉 ${song.uniqueIps} unique listener IP${song.uniqueIps === 1 ? '' : 's'}
                  </span>
                  ${timingBadgesHtml}
                </div>

                <div style="display:flex;align-items:center;gap:14px;margin-top:5px;font-size:12px;color:var(--text-secondary);flex-wrap:wrap">
                  <div>
                    ⏱️ Playtime when left: <strong class="mono" style="color:var(--accent-amber);font-weight:600">${song.avgPlaytimeWhenLeftSec > 0 ? formatDurationClock(song.avgPlaytimeWhenLeftSec) : '--:--'}</strong>
                    <span style="color:var(--text-muted);font-size:11px">${song.avgPlaytimeWhenLeftSec > 0 ? `(${formatDurationHuman(song.avgPlaytimeWhenLeftSec)} into track)` : ''}</span>
                  </div>
                  <div>
                    📻 Previous station stay: <strong class="mono" style="color:var(--accent-emerald);font-weight:600">${formatDurationHuman(song.avgStationStaySec)}</strong>
                    ${minMaxStay}
                  </div>
                  <div>
                    📉 Total listening lost: <strong class="mono" style="color:var(--text-primary);font-weight:600">${(song.totalLostListeningSec / 3600).toFixed(2)} hrs</strong>
                  </div>
                </div>

                <!-- Relative Intensity Meter -->
                <div style="width:100%;height:3px;background:hsla(210,20%,90%,0.08);border-radius:2px;margin-top:7px;overflow:hidden">
                  <div style="width:${pctOfTop}%;height:100%;background:linear-gradient(90deg, var(--accent-amber), var(--accent-crimson));border-radius:2px"></div>
                </div>
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
              <div style="text-align:right" class="mono">
                <div style="font-size:13.5px;font-weight:700;color:var(--accent-crimson)">${song.uniqueIps} Unique IP${song.uniqueIps === 1 ? '' : 's'}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:3px">${formatRelativeTime(song.lastDropTs)}</div>
              </div>
              <button type="button" class="btn ignore-detractor-btn" data-track="${escapeHtml(song.track)}" title="Exclude &quot;${escapeHtml(song.track)}&quot; from detractor stats (e.g. downtime / test placeholder)" style="padding:4px 8px;font-size:11px;border-color:hsla(355,84%,60%,0.3);color:hsl(355,95%,80%);background:hsla(355,84%,60%,0.1)">
                🚫 Exclude
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    // Attach click handlers to row exclude buttons
    listEl.querySelectorAll('.ignore-detractor-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const track = btn.getAttribute('data-track');
        if (!track) return;
        if (!confirm(`Exclude "${track}" from detractor rankings?\n\nThis will ignore this title (e.g. downtime / test stream placeholder) across detractor charts and KPIs.`)) {
          return;
        }
        try {
          btn.disabled = true;
          btn.textContent = 'Excluding...';
          const res = await fetch('/api/detractor-songs/ignore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ track, reason: 'Excluded by user from leaderboard' }),
          });
          const data = await res.json();
          if (data.ok) {
            showToast(`Excluded "${track}" from detractor statistics`);
            await fetchDashboard();
          } else {
            showToast(data.error || 'Failed to exclude track', 'error');
            btn.disabled = false;
            btn.textContent = '🚫 Exclude';
          }
        } catch (err) {
          console.error('Error excluding track:', err);
          showToast('Error excluding track', 'error');
          btn.disabled = false;
          btn.textContent = '🚫 Exclude';
        }
      });
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
        const hasDivergentConns = item.uniqueIps && item.uniqueIps !== item.count;
        const countDisplay = hasDivergentConns
          ? `${item.uniqueIps} unique (${item.count} conns)`
          : `${item.count}`;
        return `
          <div class="dist-item">
            <div class="dist-item-header">
              <div class="dist-label">${label}</div>
              <div class="dist-metrics">
                <span>avg ${formatDurationHuman(item.avgDurationSec)}</span>
                <strong style="color:var(--text-primary)">${countDisplay} • ${item.sharePct}%</strong>
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

  function getDynamicYScale(rawMax) {
    if (rawMax <= 1) return { maxVal: 2, steps: 2 };
    if (rawMax <= 2) return { maxVal: 3, steps: 3 };
    if (rawMax <= 4) return { maxVal: 4, steps: 4 };
    if (rawMax <= 6) return { maxVal: 8, steps: 4 };
    if (rawMax <= 8) return { maxVal: 10, steps: 5 };
    if (rawMax <= 10) return { maxVal: 12, steps: 4 };
    if (rawMax <= 12) return { maxVal: 15, steps: 5 };
    if (rawMax <= 16) return { maxVal: 20, steps: 4 };
    if (rawMax <= 20) return { maxVal: 24, steps: 4 };
    if (rawMax <= 25) return { maxVal: 30, steps: 5 };
    if (rawMax <= 32) return { maxVal: 40, steps: 4 };
    if (rawMax <= 45) return { maxVal: 50, steps: 5 };
    if (rawMax <= 60) return { maxVal: 75, steps: 5 };
    if (rawMax <= 80) return { maxVal: 100, steps: 4 };
    if (rawMax <= 100) return { maxVal: 120, steps: 4 };

    // Generic formula for larger numbers
    const targetSteps = 4;
    const roughStep = (rawMax * 1.15) / targetSteps;
    const pow = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const fraction = roughStep / pow;
    let niceFactor = 1;
    if (fraction > 5) niceFactor = 10;
    else if (fraction > 2) niceFactor = 5;
    else if (fraction > 1) niceFactor = 2;
    const step = niceFactor * pow;
    const maxVal = Math.ceil((rawMax * 1.08) / step) * step;
    const steps = Math.round(maxVal / step);
    return { maxVal, steps };
  }

  function renderHistoryChart(historySeries, trackChangesList) {
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

    currentHistoryData = Array.isArray(historySeries) ? historySeries : [];
    if (trackChangesList !== undefined) {
      currentTrackChanges = Array.isArray(trackChangesList) ? trackChangesList : [];
    }
    const pts = currentHistoryData;
    if (pts.length === 0) {
      ctx.fillStyle = 'hsl(214, 12%, 48%)';
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText('Collecting time-series snapshots...', 20, h / 2);
      const tip = document.getElementById('historyTooltip');
      if (tip) tip.classList.add('hidden');
      const badge = document.getElementById('historyTrackCountBadge');
      if (badge) badge.textContent = '🎵 0 track changes';
      return;
    }

    const padLeft = 38;
    const padRight = 14;
    const padTop = 18;
    const padBottom = 26;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    // Scale dynamically to the actual peak in the specified interval
    const intervalMax = Math.max(1, ...pts.map(p => Math.max(Number(p.listener_count) || 0, Number(p.unique_ips) || 0)));
    const { maxVal, steps } = getDynamicYScale(intervalMax);

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';

    // Horizontal reference lines
    ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.08)' : 'hsla(210, 20%, 90%, 0.06)';
    ctx.lineWidth = 1;
    ctx.fillStyle = isLight ? '#64748b' : 'hsl(214, 12%, 48%)';
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

    const minTs = pts[0].ts;
    const maxTs = pts[pts.length - 1].ts;

    const getX = idx =>
      pts.length === 1 ? padLeft + plotW / 2 : padLeft + (idx / (pts.length - 1)) * plotW;
    const getY = val => padTop + plotH - (Math.min(maxVal, Math.max(0, val)) / maxVal) * plotH;

    // Draw area fill under listener_count curve
    const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    grad.addColorStop(0, isLight ? 'hsla(28, 95%, 48%, 0.20)' : 'hsla(28, 95%, 56%, 0.34)');
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

    // -------------------------------------------------------------
    // Track Change Transitions Resolution & Deduplication
    // -------------------------------------------------------------
    const allTransitions = [];

    // 1. From server track changes
    for (const t of currentTrackChanges) {
      if (t && t.track && t.ts >= minTs - 60000 && t.ts <= maxTs + 60000) {
        allTransitions.push({
          ts: t.ts,
          track: t.track,
          listener_count: t.listener_count || 0,
        });
      }
    }

    // 2. From snapshots current_track transitions
    let lastSnapTrack = '';
    for (const p of pts) {
      if (p.current_track && p.current_track !== lastSnapTrack) {
        lastSnapTrack = p.current_track;
        const exists = allTransitions.some(t => t.track === p.current_track && Math.abs(t.ts - p.ts) < 45000);
        if (!exists) {
          allTransitions.push({
            ts: p.ts,
            track: p.current_track,
            listener_count: p.listener_count || 0,
          });
        }
      }
    }

    allTransitions.sort((a, b) => a.ts - b.ts);

    // Deduplicate identical tracks occurring within 45s
    const visibleTracks = [];
    for (const t of allTransitions) {
      const prev = visibleTracks[visibleTracks.length - 1];
      if (!prev || prev.track !== t.track || Math.abs(t.ts - prev.ts) > 45000) {
        visibleTracks.push(t);
      }
    }

    // Update track counter badge in panel header
    const trackBadge = document.getElementById('historyTrackCountBadge');
    if (trackBadge) {
      const n = visibleTracks.length;
      trackBadge.textContent = `🎵 ${n} track ${n === 1 ? 'change' : 'changes'}`;
    }

    // Map each track transition to exact X and listener curve Y
    const mappedTracks = visibleTracks.map(tr => {
      let trX = padLeft;
      let curveCount = pts[0].listener_count || 0;

      if (pts.length === 1) {
        trX = padLeft + plotW / 2;
        curveCount = pts[0].listener_count;
      } else if (tr.ts <= pts[0].ts) {
        trX = getX(0);
        curveCount = pts[0].listener_count;
      } else if (tr.ts >= pts[pts.length - 1].ts) {
        trX = getX(pts.length - 1);
        curveCount = pts[pts.length - 1].listener_count;
      } else {
        for (let i = 0; i < pts.length - 1; i++) {
          if (tr.ts >= pts[i].ts && tr.ts <= pts[i + 1].ts) {
            const segSpan = Math.max(1, pts[i + 1].ts - pts[i].ts);
            const segFrac = (tr.ts - pts[i].ts) / segSpan;
            const x0 = getX(i);
            const x1 = getX(i + 1);
            trX = x0 + segFrac * (x1 - x0);
            curveCount = (pts[i].listener_count || 0) + segFrac * ((pts[i + 1].listener_count || 0) - (pts[i].listener_count || 0));
            break;
          }
        }
      }
      return {
        ...tr,
        trX: Math.max(padLeft, Math.min(w - padRight, trX)),
        curveY: getY(curveCount),
        curveCount: Math.round(curveCount),
      };
    });

    // -------------------------------------------------------------
    // Render Track Markers when enabled
    // -------------------------------------------------------------
    if (showTracksSetting) {
      const canShowTitles = mappedTracks.length <= 10 && (plotW / Math.max(1, mappedTracks.length)) >= 45;

      mappedTracks.forEach(tr => {
        // 1. Vertical track marker dashed line
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'hsla(280, 80%, 65%, 0.42)';
        ctx.lineWidth = 1.3;
        ctx.moveTo(tr.trX, padTop + 14);
        ctx.lineTo(tr.trX, padTop + plotH);
        ctx.stroke();
        ctx.restore();

        // 2. Glowing pin rooted on the listener curve
        ctx.beginPath();
        ctx.arc(tr.trX, tr.curveY, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = 'hsla(280, 90%, 65%, 0.28)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(tr.trX, tr.curveY, 3.8, 0, Math.PI * 2);
        ctx.fillStyle = 'hsl(280, 88%, 66%)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(tr.trX, tr.curveY, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // 3. Music note badge at top of line
        ctx.beginPath();
        ctx.arc(tr.trX, padTop + 7, 7.5, 0, Math.PI * 2);
        ctx.fillStyle = 'hsla(280, 60%, 18%, 0.92)';
        ctx.fill();
        ctx.strokeStyle = 'hsla(280, 85%, 68%, 0.8)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.fillStyle = 'hsl(280, 95%, 92%)';
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('♪', tr.trX, padTop + 7.5);

        // 4. Clean rotated song title label if spacing permits
        if (canShowTitles) {
          ctx.save();
          ctx.translate(tr.trX + 3.5, padTop + 22);
          ctx.rotate(Math.PI / 2);
          ctx.font = '500 9.5px "JetBrains Mono", monospace';
          ctx.fillStyle = 'hsla(280, 80%, 88%, 0.82)';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          let label = tr.track;
          if (label.length > 22) label = label.substring(0, 20) + '…';
          ctx.fillText(label, 0, 0);
          ctx.restore();
        }
      });
    }

    // X-axis time labels
    ctx.fillStyle = isLight ? '#64748b' : 'hsl(214, 12%, 48%)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const labelCount = Math.min(6, pts.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / Math.max(1, labelCount - 1)) * (pts.length - 1));
      const p = pts[idx];
      const x = getX(idx);
      const label = new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(label, x, h - 6);
    }

    // -------------------------------------------------------------
    // Hover Tracking Overlay & Tooltip
    // -------------------------------------------------------------
    const tooltip = document.getElementById('historyTooltip');
    if (historyHoverIdx !== null && pts[historyHoverIdx]) {
      const p = pts[historyHoverIdx];
      const ptX = getX(historyHoverIdx);
      const ptY1 = getY(p.listener_count);
      const ptY2 = getY(p.unique_ips || p.listener_count);

      // Check proximity to any track transition
      let closestTr = null;
      let closestDist = Infinity;
      if (mappedTracks.length > 0) {
        for (const tr of mappedTracks) {
          const dist = Math.abs(tr.trX - ptX);
          if (dist < closestDist) {
            closestDist = dist;
            closestTr = tr;
          }
        }
      }
      const isNearTrack = showTracksSetting && closestTr && closestDist <= 16;

      // 1. Vertical guideline
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.35)' : 'hsla(210, 20%, 90%, 0.45)';
      ctx.lineWidth = 1;
      ctx.moveTo(ptX, padTop);
      ctx.lineTo(ptX, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // 2. Highlight track marker if hovering near transition
      if (isNearTrack) {
        ctx.beginPath();
        ctx.arc(closestTr.trX, closestTr.curveY, 11, 0, Math.PI * 2);
        ctx.strokeStyle = 'hsl(280, 95%, 75%)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(closestTr.trX, padTop + 7, 10.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'hsl(280, 95%, 75%)';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      // 3. Active Listeners dot (amber)
      ctx.beginPath();
      ctx.arc(ptX, ptY1, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = 'hsla(28, 95%, 56%, 0.32)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ptX, ptY1, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(28, 95%, 56%)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ptX, ptY1, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // 4. Unique IPs dot (cyan)
      ctx.beginPath();
      ctx.arc(ptX, ptY2, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = 'hsla(196, 88%, 54%, 0.32)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ptX, ptY2, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(196, 88%, 54%)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ptX, ptY2, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // 5. Update and position HTML tooltip
      if (tooltip) {
        const isMultiDay = selectedRangeMinutes > 1440;
        const timeStr = isMultiDay
          ? new Date(p.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // Resolve current track playing at this timestamp
        let playingTrack = p.current_track;
        if (!playingTrack && mappedTracks.length > 0) {
          for (let i = mappedTracks.length - 1; i >= 0; i--) {
            if (mappedTracks[i].ts <= p.ts) {
              playingTrack = mappedTracks[i].track;
              break;
            }
          }
        }

        let trackSectionHtml = '';
        if (isNearTrack) {
          const trackTimeStr = new Date(closestTr.ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          trackSectionHtml = `
            <div style="margin-top:8px;padding:6px 9px;background:hsla(280,75%,45%,0.2);border:1px solid hsla(280,85%,65%,0.45);border-radius:6px">
              <div style="font-size:10px;font-weight:700;color:hsl(280,95%,85%);text-transform:uppercase;letter-spacing:0.06em;display:flex;align-items:center;justify-content:space-between;gap:6px">
                <span>✨ TRACK CHANGED HERE</span>
                <span style="color:var(--text-muted);font-weight:400;font-family:'JetBrains Mono',monospace">${trackTimeStr}</span>
              </div>
              <div style="font-weight:600;font-size:12px;color:#ffffff;margin-top:3px;max-width:270px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(closestTr.track)}">
                🎵 ${escapeHtml(closestTr.track)}
              </div>
              <div style="font-size:11px;color:hsl(280,80%,85%);margin-top:2px;font-family:'JetBrains Mono',monospace">
                Concurrence at transition: <strong>${closestTr.curveCount}</strong> listeners
              </div>
            </div>
          `;
        } else if (playingTrack) {
          trackSectionHtml = `
            <div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border-subtle);font-size:11.5px;color:var(--text-secondary);max-width:270px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(playingTrack)}">
              🎵 <span style="color:hsl(280,90%,85%)">${escapeHtml(playingTrack)}</span>
            </div>
          `;
        }

        tooltip.innerHTML = `
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.04em;margin-bottom:6px">
            ${timeStr}
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:3px">
            <span style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);font-size:12px">
              <span style="width:8px;height:8px;border-radius:50%;background:hsl(28,95%,56%);display:inline-block"></span>
              Active Listeners
            </span>
            <strong style="color:var(--accent-amber);font-family:'JetBrains Mono',monospace;font-size:13px">${p.listener_count}</strong>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
            <span style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);font-size:12px">
              <span style="width:8px;height:2px;background:hsl(196,88%,54%);display:inline-block"></span>
              Unique IPs
            </span>
            <strong style="color:hsl(196,88%,54%);font-family:'JetBrains Mono',monospace;font-size:13px">${p.unique_ips || p.listener_count}</strong>
          </div>
          ${trackSectionHtml}
        `;

        const containerW = rect.width;
        let left = Math.max(110, Math.min(containerW - 110, ptX));

        if (ptY1 < 85) {
          tooltip.style.transform = 'translate(-50%, 0)';
          tooltip.style.marginTop = '14px';
          tooltip.style.left = left + 'px';
          tooltip.style.top = ptY1 + 'px';
        } else {
          tooltip.style.transform = 'translate(-50%, -100%)';
          tooltip.style.marginTop = '-12px';
          tooltip.style.left = left + 'px';
          tooltip.style.top = ptY1 + 'px';
        }
        tooltip.classList.remove('hidden');
      }
    } else if (tooltip) {
      tooltip.classList.add('hidden');
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

    let rows = (dashboardState.listeners || []).map(l => {
      const liveConnectedSeconds = (l.connectedSeconds || 0) + elapsedSec;
      const badges = getListenerBadges(l, liveConnectedSeconds);
      const badgesText = badges.map(b => `${b.label} ${b.shortLabel || ''} ${b.type} ${b.id}`).join(' ').toLowerCase();
      return {
        ...l,
        liveConnectedSeconds,
        badges,
        badgesText,
      };
    });

    if (excludeBotsSetting) {
      rows = rows.filter(r => !r.isBot);
    }

    if (tableCategoryFilter !== 'ALL') {
      rows = rows.filter(r => r.ua?.category === tableCategoryFilter);
    }

    if (tableBadgeFilter !== 'ALL') {
      rows = rows.filter(r => r.badges.some(b => b.type === tableBadgeFilter || b.id === tableBadgeFilter));
    }

    if (q) {
      rows = rows.filter(
        r =>
          r.ip.toLowerCase().includes(q) ||
          (r.friendlyName || '').toLowerCase().includes(q) ||
          (r.notes || '').toLowerCase().includes(q) ||
          (r.badgesText || '').includes(q) ||
          (r.geo?.city || '').toLowerCase().includes(q) ||
          (r.geo?.countryName || '').toLowerCase().includes(q) ||
          (r.geo?.countryCode || '').toLowerCase().includes(q) ||
          (r.ua?.player || '').toLowerCase().includes(q) ||
          (r.ua?.os || '').toLowerCase().includes(q) ||
          (r.userAgent || '').toLowerCase().includes(q)
      );
    }

    const totalRawStreams = rows.length;
    let duplicateStreamsCount = 0;

    if (dedupeListenersSetting) {
      const groupMap = new Map();
      for (const r of rows) {
        // Group by (IP + Player / User-Agent):
        // If listeners are on the same IP and player user agent, count as 1.
        // Unless under the same IP there are two separate players or agents!
        const key = getListenerDeviceKey(r);
        if (!groupMap.has(key)) {
          groupMap.set(key, {
            ...r,
            streams: [r],
            allClientIds: [String(r.clientId)],
          });
        } else {
          const group = groupMap.get(key);
          group.streams.push(r);
          group.allClientIds.push(String(r.clientId));
          duplicateStreamsCount++;
          // Keep highest connected seconds as primary row representation
          if (r.liveConnectedSeconds > group.liveConnectedSeconds) {
            group.liveConnectedSeconds = r.liveConnectedSeconds;
            group.connectedSeconds = r.connectedSeconds;
            group.clientId = r.clientId;
            group.badges = r.badges;
            group.badgesText = r.badgesText;
            if (r.ua?.player && r.ua.player !== 'Audio Client') {
              group.ua = r.ua;
              group.userAgent = r.userAgent;
            }
          }
          group.connectionsFromIp = group.streams.length;
        }
      }
      rows = Array.from(groupMap.values());
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
      if (dedupeListenersSetting) {
        if (excludeBotsSetting) {
          const botCount = (dashboardState.kpis?.botListenersCount ?? (dashboardState.listeners || []).filter(l => l.isBot).length);
          const streamInfo = duplicateStreamsCount > 0 ? ` (${totalRawStreams} streams, ${botCount} bots excluded)` : ` (${botCount} bots excluded)`;
          countBadge.textContent = `${rows.length} unique human ${rows.length === 1 ? 'listener' : 'listeners'}${streamInfo}`;
        } else {
          const streamInfo = duplicateStreamsCount > 0 ? ` (${totalRawStreams} streams total)` : '';
          countBadge.textContent = `${rows.length} unique ${rows.length === 1 ? 'listener' : 'listeners'}${streamInfo}`;
        }
      } else {
        if (excludeBotsSetting) {
          const botCount = (dashboardState.kpis?.botListenersCount ?? (dashboardState.listeners || []).filter(l => l.isBot).length);
          countBadge.textContent = `${rows.length} human connections (${botCount} bots excluded)`;
        } else {
          countBadge.textContent = `${rows.length} of ${dashboardState.listeners.length} clients`;
        }
      }
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
        const streamCount = r.streams ? r.streams.length : (r.connectionsFromIp || 1);
        let dupHtml = '';
        if (streamCount > 1) {
          const streamDetails = (r.streams || [r])
            .map((s, idx) => `• Stream #${idx + 1}: ${formatDurationClock(s.liveConnectedSeconds)} (${s.liveConnectedSeconds}s) [Client #${s.clientId}]`)
            .join('&#10;');
          dupHtml = `<span class="dup-badge" title="${streamCount} simultaneous streams from this IP:&#10;${streamDetails}">${streamCount}x</span>`;
        }
        const isBot = Boolean(r.isBot || r.isManualBot || r.ua?.isRipper || r.ua?.category === 'Bot / Ripper');
        const catClass = isBot ? 'ripper' : '';
        const botBtnHtml = isBot
          ? `<button type="button" class="btn btn-warning-ghost" style="padding:4px 8px;font-size:11.5px" data-bot-ip="${escapeHtml(r.ip)}" data-bot-state="1" title="Marked as Bot / Ripper. Click to remove bot classification">🤖 Unmark Bot</button>`
          : `<button type="button" class="btn" style="padding:4px 8px;font-size:11.5px" data-bot-ip="${escapeHtml(r.ip)}" data-bot-state="0" title="Flag this IP as a Bot or Stream Ripper">🤖 Mark Bot</button>`;
        const friendlyBadgeHtml = r.friendlyName
          ? `<button type="button" data-inspect-ip="${escapeHtml(r.ip)}" style="background:hsla(28,95%,56%,0.16);color:var(--accent-amber);border:1px solid hsla(28,95%,56%,0.42);border-radius:4px;padding:2px 7px;font-size:12px;font-weight:600;cursor:pointer;text-align:left" title="Click to edit friendly name or inspect IP">${escapeHtml(r.friendlyName)}</button>`
          : '';

        const allIdsAttr = (r.allClientIds || [String(r.clientId)]).join(',');
        const kickLabel = streamCount > 1 ? `Kick All (${streamCount})` : 'Kick';
        const extraStreamNote = streamCount > 1
          ? `<div style="font-size:10.5px;color:var(--accent-amber);margin-top:2px;font-family:var(--font-mono)" title="${streamCount} simultaneous connections from this IP">⚡ ${streamCount} active streams</div>`
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
                ${renderListenerBadgesHtml(r.badges)}
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
              ${extraStreamNote}
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
                <button type="button" class="btn btn-danger-ghost" data-kick-id="${escapeHtml(r.clientId)}" data-kick-ip="${escapeHtml(r.ip)}" data-client-ids="${escapeHtml(allIdsAttr)}" title="Disconnect listener from Icecast">${kickLabel}</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  function renderBotCard(botActivity) {
    const container = document.getElementById('botsAccordion');
    const activeBadge = document.getElementById('botActiveBadge');
    const trackedBadge = document.getElementById('bot24hBadge');
    if (!container) return;

    const data = botActivity || { activeCount: 0, total24hCount: 0, categories: [], bots: [] };
    const bots = data.bots || [];
    const activeCount = data.activeCount ?? bots.filter(b => b.isActive).length;
    const totalCount = data.total24hCount ?? bots.length;

    if (activeBadge) {
      activeBadge.textContent = `${activeCount} Active Live`;
      activeBadge.className = activeCount > 0 ? 'time-bound-badge live' : 'time-bound-badge';
    }
    if (trackedBadge) {
      trackedBadge.textContent = `${totalCount} tracked IP${totalCount === 1 ? '' : 's'} (24h)`;
    }

    if (bots.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="text-align:center;padding:32px 16px;color:var(--text-muted)">
          🛡️ No automated bots, scrapers, or stream rippers detected in the past 24 hours.
        </div>
      `;
      return;
    }

    let categories = data.categories;
    if (!categories || categories.length === 0) {
      const catMap = new Map();
      for (const b of bots) {
        const catId = b.categoryGroup?.id || 'other';
        if (!catMap.has(catId)) {
          catMap.set(catId, {
            id: catId,
            name: b.categoryGroup?.name || 'Automated Probes',
            icon: b.categoryGroup?.icon || '🤖',
            description: b.categoryGroup?.description || '',
            activeCount: 0,
            totalCount: 0,
            bots: [],
          });
        }
        const grp = catMap.get(catId);
        grp.totalCount++;
        if (b.isActive) grp.activeCount++;
        grp.bots.push(b);
      }
      categories = Array.from(catMap.values());
    }

    container.innerHTML = categories
      .map(cat => {
        // Collapsed by default unless explicitly opened by user
        const isOpen = expandedBotCategories.has(cat.id);
        const liveTag = cat.activeCount > 0
          ? `<span class="bot-cat-live-tag"><span class="status-dot" style="background:#10b981;box-shadow:0 0 6px #10b981;width:6px;height:6px"></span> ${cat.activeCount} Live</span>`
          : '';

        const rowsHtml = (cat.bots || [])
          .map(b => {
            const friendlyBadgeHtml = b.friendlyName
              ? `<button type="button" data-inspect-ip="${escapeHtml(b.ip)}" style="background:hsla(28,95%,56%,0.16);color:var(--accent-amber);border:1px solid hsla(28,95%,56%,0.42);border-radius:4px;padding:2px 7px;font-size:12px;font-weight:600;cursor:pointer;text-align:left" title="Click to edit friendly name">${escapeHtml(b.friendlyName)}</button>`
              : '';

            const isExplicit = Boolean(b.isExplicitBot);
            const actionBtnHtml = isExplicit
              ? `<button type="button" class="btn btn-warning-ghost" style="padding:4px 8px;font-size:11.5px" data-bot-ip="${escapeHtml(b.ip)}" data-bot-state="1" title="Flagged explicitly. Click to remove bot classification">🤖 Unmark Bot</button>`
              : `<button type="button" class="btn" style="padding:4px 8px;font-size:11.5px" data-bot-ip="${escapeHtml(b.ip)}" data-bot-state="0" title="Classified by signature. Click to pin as explicit bot IP">📌 Pin Bot Flag</button>`;

            const statusPill = b.isActive
              ? `<span class="status-badge" style="background:hsla(142,71%,45%,0.15);color:var(--accent-emerald);border:1px solid hsla(142,71%,45%,0.35);padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:5px"><span class="status-dot" style="background:#10b981;box-shadow:0 0 6px #10b981"></span> Live</span>`
              : `<span style="font-size:11px;color:var(--text-muted);font-weight:500">Offline</span>`;

            const sessionsText = b.sessionCount > 0
              ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${b.sessionCount} session${b.sessionCount === 1 ? '' : 's'} (${formatDurationHuman(b.totalDurationSeconds)})</div>`
              : '';

            const locationText = b.city && b.city !== b.countryName && !b.city.startsWith('Unresolved') && b.city !== 'Unknown City' && b.city !== 'Unknown'
              ? `${escapeHtml(b.city)}, <span style="color:var(--text-secondary)">${escapeHtml(b.countryName || '')}</span>`
              : escapeHtml(b.countryName || 'Unknown');

            const ispText = b.isp
              ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;font-family:var(--font-mono)">${escapeHtml(b.isp)}</div>`
              : '';

            const lastSeenAgo = b.lastSeen
              ? formatRelativeTime(b.lastSeen)
              : 'Unknown';

            return `
              <tr data-bot-ip-row="${escapeHtml(b.ip)}">
                <td>
                  <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start">
                    ${friendlyBadgeHtml}
                    <div class="ip-cell">
                      <button type="button" class="ip-link" data-inspect-ip="${escapeHtml(b.ip)}" title="Inspect IP history &amp; geolocation">
                        ${escapeHtml(b.ip)}
                      </button>
                      <button type="button" class="copy-ip-btn" data-copy-ip="${escapeHtml(b.ip)}" title="Copy IP address">Copy</button>
                    </div>
                  </div>
                </td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    ${renderCountryFlag(b.countryCode, b.countryName, 18)}
                    <span>${locationText}</span>
                  </div>
                  ${ispText}
                </td>
                <td class="ua-cell">
                  <div class="ua-parsed-row" style="font-weight:600">
                    <span>${escapeHtml(b.player || 'Bot / Ripper')}</span>
                  </div>
                  <div class="ua-raw-sub" title="${escapeHtml(b.userAgent)}">${escapeHtml(b.userAgent || 'Unknown')}</div>
                </td>
                <td>
                  <span class="cat-tag ripper">${escapeHtml(b.reason || 'Bot / Ripper')}</span>
                </td>
                <td>
                  ${statusPill}
                  ${sessionsText}
                </td>
                <td>
                  <span style="font-size:12px;color:var(--text-secondary)" title="${b.lastSeen ? new Date(b.lastSeen).toLocaleString() : ''}">${lastSeenAgo}</span>
                </td>
                <td>
                  <div style="display:flex;align-items:center;gap:6px">
                    <button type="button" class="btn" style="padding:4px 8px;font-size:11.5px" data-inspect-ip="${escapeHtml(b.ip)}" title="View full connection dossier">Dossier</button>
                    ${actionBtnHtml}
                  </div>
                </td>
              </tr>
            `;
          })
          .join('');

        return `
          <details class="bot-category-group" ${isOpen ? 'open' : ''} data-category-id="${escapeHtml(cat.id)}">
            <summary class="bot-category-header">
              <div class="bot-category-info">
                <span class="bot-cat-icon">${cat.icon || '🤖'}</span>
                <div>
                  <div class="bot-cat-name">
                    <span>${escapeHtml(cat.name)}</span>
                    <span class="bot-cat-count-tag">${cat.totalCount} ${cat.totalCount === 1 ? 'IP' : 'IPs'}</span>
                    ${liveTag}
                  </div>
                  <div class="bot-cat-desc">${escapeHtml(cat.description || '')}</div>
                </div>
              </div>
              <div class="bot-cat-chevron">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </summary>
            <div class="table-scroll">
              <table class="clients-table">
                <thead>
                  <tr>
                    <th>Bot / Scanner IP</th>
                    <th>Location &amp; ISP</th>
                    <th>Detected Agent / Player</th>
                    <th>Category / Reason</th>
                    <th>Status / Sessions</th>
                    <th>Last Seen</th>
                    <th>Admin Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml}
                </tbody>
              </table>
            </div>
          </details>
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
    content.innerHTML = `
      <div style="padding:28px 16px;text-align:center;color:var(--text-secondary)">
        <div style="margin:0 auto 12px;width:24px;height:24px;border:2.5px solid var(--border-subtle);border-top-color:var(--accent-amber);border-radius:50%;animation:spin 0.8s linear infinite"></div>
        <div style="font-size:13px">Loading session history and telemetry for <span class="mono" style="color:var(--text-primary);font-weight:600">${escapeHtml(ip)}</span>...</div>
      </div>
    `;
    backdrop.classList.remove('hidden');

    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), 4500);
      const res = await fetch(`/api/ip/${encodeURIComponent(ip)}`, { signal: abortCtrl.signal });
      clearTimeout(timer);

      const data = await res.json();
      if (!data || !data.ok) {
        content.innerHTML = `
          <div style="padding:16px;background:var(--bg-elevated);border-radius:8px;border:1px solid hsla(355,84%,60%,0.3)">
            <div style="color:var(--accent-crimson);font-weight:600">Failed to load dossier for ${escapeHtml(ip)}.</div>
            <button type="button" class="btn btn-primary" style="margin-top:12px" id="retryLoadDossierBtn">Retry</button>
          </div>
        `;
        document.getElementById('retryLoadDossierBtn')?.addEventListener('click', () => openIpInspector(ip));
        return;
      }

      const { geo = {}, activeConnections = [], history = {}, friendlyName, currentTrack: liveTrack, currentTrackProgressSec: liveTrackProgressSec } = data;
      const sum = history?.summary || {};
      const sessions = history?.sessions || [];
      const currentName = friendlyName || history?.friendlyName || '';
      const isBot = Boolean(history?.isBot);
      const isCurrentlyConnected = activeConnections.length > 0;
      const currentStreamTrack = liveTrack || dashboardState?.stream?.title || '';
      const exitTrack = history?.lastExitTrack || sessions[0]?.last_track || '';
      const exitProgressSec = Number(history?.lastExitTrackProgressSec || sessions[0]?.last_track_progress_sec || 0);
      const activeProgressSec = Number(liveTrackProgressSec || 0);

      const displayTrack = isCurrentlyConnected
        ? (currentStreamTrack || exitTrack || 'Live Stream')
        : (exitTrack || 'No track metadata recorded at disconnect');

      const displayProgressSec = isCurrentlyConnected ? activeProgressSec : exitProgressSec;
      const progressBadge = displayProgressSec > 0
        ? `<span class="duration-pill" style="font-size:11px;padding:2px 8px;background:hsla(28,95%,54%,0.16);color:var(--accent-amber);border:1px solid hsla(28,95%,54%,0.35);font-family:var(--font-mono);white-space:nowrap" title="Track progress when left">${formatDurationClock(displayProgressSec)} into song (${formatDurationHuman(displayProgressSec)})</span>`
        : '';

      const isMeAdmin = Boolean(
        currentName && (
          currentName.trim().toLowerCase() === 'me' ||
          currentName.trim().toLowerCase().startsWith('me ') ||
          currentName.trim().toLowerCase() === 'admin'
        )
      );

      const dossierListener = {
        ip,
        friendlyName: currentName,
        isBot,
        sessionCount: sum.session_count,
        totalDurationSeconds: sum.total_seconds,
        longestSessionSeconds: sum.longest_session,
        firstSeen: sum.first_ever_seen,
        allTimeRank: sum.all_time_rank,
      };
      const dossierBadges = getListenerBadges(dossierListener, activeProgressSec);

      title.textContent = currentName ? `${currentName} (${ip})` : `Listener Dossier — ${ip}`;

      content.innerHTML = `
        <form id="ipAliasForm" style="background:var(--bg-elevated);padding:12px 14px;border-radius:8px;border:1px solid var(--border-strong);display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <label for="ipFriendlyNameInput" style="font-size:11.5px;font-weight:700;color:var(--accent-amber);letter-spacing:0.04em">FRIENDLY NAME &amp; ADMIN TAG FOR ${escapeHtml(ip)}</label>
            <span style="font-size:11px;color:var(--text-muted)">Saved in SQLite</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="text" id="ipFriendlyNameInput" class="form-input" placeholder="e.g. Me, Studio Monitor, DJ Alex..." value="${escapeHtml(currentName)}" style="flex:1;min-width:180px" autocomplete="off" />
            <button type="submit" class="btn btn-primary" style="white-space:nowrap">Save Name</button>
            <button type="button" id="markAsMeBtn" class="btn" style="white-space:nowrap;background:hsla(210,100%,60%,0.15);color:hsl(210,100%,75%);border-color:hsla(210,100%,60%,0.35)" title="Mark this IP as Station Admin ('Me') so it is completely ignored in track drop-outs and detractor telemetry">👑 Mark as "Me"</button>
            ${
              currentName
                ? `<button type="button" id="clearIpAliasBtn" class="btn btn-danger-ghost" style="white-space:nowrap">Remove</button>`
                : ''
            }
          </div>
          ${
            isMeAdmin
              ? `<div style="font-size:11.5px;color:hsl(210,100%,75%);display:flex;align-items:center;gap:6px;margin-top:2px;background:hsla(210,100%,60%,0.1);padding:5px 10px;border-radius:4px;border:1px solid hsla(210,100%,60%,0.25)">
                  <span>👑</span>
                  <span><strong>Station Admin IP ("Me"):</strong> Ignored in Detractor Songs and Track Drop-Outs.</span>
                 </div>`
              : `<div style="font-size:11px;color:var(--text-muted);margin-top:1px">Tip: Name your own IP <code>Me</code> to automatically exclude your listening sessions from track drop-outs.</div>`
          }
        </form>

        <div style="background:var(--bg-elevated);padding:10px 14px;border-radius:8px;border:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.04em">LISTENER BADGES &amp; LOYALTY PROFILE</span>
            <span style="font-size:11.5px;color:var(--accent-amber);font-weight:600">${sum.all_time_rank ? `🌟 Rank #${sum.all_time_rank} Station-Wide` : 'Station Visitor'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${renderListenerBadgesHtml(dossierBadges, 10)}
          </div>
        </div>

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

        <div style="background:var(--bg-elevated);padding:11px 14px;border-radius:8px;border:1px solid ${isCurrentlyConnected ? 'hsla(158,82%,54%,0.35)' : 'hsla(28,95%,54%,0.35)'};display:flex;align-items:center;gap:12px">
          <div style="width:36px;height:36px;border-radius:6px;background:${isCurrentlyConnected ? 'hsla(158,82%,54%,0.15)' : 'hsla(28,95%,54%,0.15)'};border:1px solid ${isCurrentlyConnected ? 'hsla(158,82%,54%,0.4)' : 'hsla(28,95%,54%,0.4)'};display:flex;align-items:center;justify-content:center;color:${isCurrentlyConnected ? 'var(--accent-emerald)' : 'var(--accent-amber)'};font-size:16px;flex-shrink:0">
            ${isCurrentlyConnected ? '📻' : '🎵'}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.04em">
              ${isCurrentlyConnected ? 'NOW PLAYING (LISTENER CURRENTLY CONNECTED)' : 'TRACK PLAYED WHEN LISTENER LEFT'}
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:2px;flex-wrap:wrap">
              <span style="font-size:13.5px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px" title="${escapeHtml(displayTrack)}">
                ${escapeHtml(displayTrack)}
              </span>
              ${progressBadge}
            </div>
          </div>
          ${
            isCurrentlyConnected
              ? '<span class="status-badge live" style="padding:2px 8px;font-size:11px">Live Now</span>'
              : ''
          }
        </div>

        <div class="form-grid-2" style="background:var(--bg-canvas);padding:12px 14px;border-radius:8px;border:1px solid var(--border-subtle)">
          <div>
            <div style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;justify-content:space-between">
              <span>LOCATION &amp; NETWORK</span>
              <span class="mount-tag" style="font-size:10px;padding:1px 5px">${escapeHtml(geo.source || 'GeoIP')}</span>
            </div>
            <div style="font-weight:600;margin-top:2px;display:flex;align-items:center;gap:6px">${renderCountryFlag(geo.countryCode, geo.countryName, 18)} <span>${escapeHtml(geo.hasCity && geo.city && geo.city !== geo.countryName && !geo.city.startsWith('Unresolved') ? `${geo.city}, ${geo.countryName}` : `${geo.countryName || 'Unknown'}`)}</span></div>
            <div class="mono" style="font-size:11.5px;color:var(--text-secondary);margin-top:2px">Coords: ${geo.lat}, ${geo.lon} • TZ: ${escapeHtml(geo.timezone)}</div>
            ${geo.isp ? `<div style="font-size:11.5px;color:var(--accent-amber);margin-top:3px;font-weight:600">📡 ISP: ${escapeHtml(geo.isp)}</div>` : ''}
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted)">CUMULATIVE SQLITE STATS</div>
            <div class="mono" style="font-weight:600;margin-top:2px">${sum.session_count || 1} recorded session(s)</div>
            <div class="mono" style="font-size:11.5px;color:var(--accent-emerald);margin-top:2px">
              Total Listen Time: ${formatDurationHuman(sum.total_seconds || 0)} • Active Now: ${activeConnections.length}
            </div>
          </div>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
          <div style="font-size:12.5px;font-weight:600">Recorded Sessions &amp; Disconnect Tracks</div>
          <div class="mono" style="font-size:11px;color:var(--text-muted)">${sessions.length} recorded session${sessions.length === 1 ? '' : 's'}</div>
        </div>
        <div class="dossier-sessions-list" style="display:flex;flex-direction:column;gap:8px">
          ${
            sessions.length === 0
              ? `<div style="color:var(--text-muted);font-size:12px;padding:12px;background:var(--bg-canvas);border-radius:6px;border:1px solid var(--border-subtle);text-align:center">No stored sessions yet for this IP.</div>`
              : sessions
                  .map((s, idx) => {
                    const trackText = s.last_track || 'No track metadata recorded';
                    const trackLabel = s.is_active ? 'Listening to:' : 'Left during:';
                    const progSec = Number(s.last_track_progress_sec || 0);
                    const progPill = progSec > 0
                      ? `<span class="mono" style="font-size:11px;color:var(--accent-amber);background:hsla(28,95%,54%,0.14);padding:2px 7px;border-radius:3px;border:1px solid hsla(28,95%,54%,0.3);white-space:nowrap" title="Progress into song when session ended">at ${formatDurationClock(progSec)} (${formatDurationHuman(progSec)})</span>`
                      : '';
                    const isOverflow = idx >= 15;
                    return `
                  <div class="event-row ${isOverflow ? 'dossier-session-overflow hidden' : ''}" style="padding:10px 14px;border-radius:6px;background:var(--bg-canvas);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:space-between;gap:14px">
                    <div style="flex:1;min-width:0">
                      <div style="display:flex;align-items:center;gap:6px">
                        <span style="font-weight:600">${escapeHtml(s.player)}</span>
                        <span style="font-size:11.5px;color:var(--text-muted)">(${escapeHtml(s.os)})</span>
                        ${s.is_active ? '<span class="status-badge live" style="padding:1px 6px;font-size:10px">Active</span>' : ''}
                      </div>
                      <div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:12px;flex-wrap:wrap" title="${escapeHtml(trackText)}">
                        <span style="color:var(--accent-amber);font-size:12px">🎵</span>
                        <span style="font-size:11px;font-weight:600;color:var(--accent-amber)">${trackLabel}</span>
                        <span style="color:var(--text-primary);font-weight:500">${escapeHtml(trackText)}</span>
                        ${progPill}
                      </div>
                      <div class="mono" style="font-size:10.5px;color:var(--text-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(s.user_agent)}">${escapeHtml(s.user_agent)}</div>
                    </div>
                    <div style="text-align:right;flex-shrink:0" class="mono">
                      <div style="color:var(--accent-emerald);font-weight:600">${formatDurationHuman(s.duration_seconds)}</div>
                      <div style="font-size:10.5px;color:var(--text-muted);margin-top:3px">${new Date(s.last_seen).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  </div>
                `;
                  })
                  .join('')
          }
          ${
            sessions.length > 15
              ? `<div style="text-align:center;padding:4px 0">
                   <button type="button" id="dossierShowAllSessionsBtn" class="btn" style="font-size:11.5px;padding:6px 14px;background:var(--bg-canvas);border:1px solid var(--border-strong)">
                     Show all ${sessions.length} recorded sessions (${sessions.length - 15} more)
                   </button>
                 </div>`
              : ''
          }
        </div>
      `;

      const showAllBtn = document.getElementById('dossierShowAllSessionsBtn');
      if (showAllBtn) {
        showAllBtn.addEventListener('click', () => {
          content.querySelectorAll('.dossier-session-overflow').forEach(el => el.classList.remove('hidden'));
          showAllBtn.parentElement?.remove();
        });
      }

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

      document.getElementById('markAsMeBtn')?.addEventListener('click', async () => {
        const saveRes = await fetch(`/api/ip/${encodeURIComponent(ip)}/alias`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ friendlyName: 'Me' }),
        });
        const saveData = await saveRes.json();
        if (saveData.ok) {
          showToast(`Marked ${ip} as "Me" (Station Admin - Ignored in Track Drop-Outs)`);
          title.textContent = `Me (${ip})`;
          await fetchDashboard();
          openIpInspector(ip);
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
      const isTimeout = err.name === 'AbortError' || err.message.includes('abort');
      const msg = isTimeout
        ? 'Dossier query timed out. The server or network is slow to respond.'
        : escapeHtml(err.message);
      content.innerHTML = `
        <div style="padding:16px;background:var(--bg-elevated);border-radius:8px;border:1px solid hsla(355,84%,60%,0.3)">
          <div style="color:var(--accent-crimson);font-weight:600">Error loading dossier: ${msg}</div>
          <button type="button" class="btn btn-primary" style="margin-top:12px" id="retryCatchDossierBtn">Retry</button>
        </div>
      `;
      document.getElementById('retryCatchDossierBtn')?.addEventListener('click', () => openIpInspector(ip));
    }
  }

  // Open Ignored Downtime & Test Stream Placeholders Modal
  async function openIgnoredTracksModal() {
    const backdrop = document.getElementById('ignoredTracksModalBackdrop');
    const tbody = document.getElementById('ignoredTracksTableBody');
    if (!backdrop || !tbody) return;

    backdrop.classList.remove('hidden');
    tbody.innerHTML = '<tr><td colspan="3" style="padding:14px;text-align:center;color:var(--text-secondary)">Loading excluded titles...</td></tr>';

    try {
      const res = await fetch('/api/detractor-songs/ignored');
      const data = await res.json();
      const list = data.ignoredTracks || [];

      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="padding:14px;text-align:center;color:var(--text-muted)">No excluded titles. All track titles are active in detractor analysis.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(item => `
        <tr style="border-bottom:1px solid var(--border-subtle)">
          <td style="padding:8px 10px;font-weight:600;color:var(--text-primary)">
            ${escapeHtml(item.track)}
          </td>
          <td style="padding:8px 10px;color:var(--text-secondary);font-size:11.5px">
            ${escapeHtml(item.reason || 'Downtime / Test stream placeholder')}
          </td>
          <td style="padding:8px 10px;text-align:right">
            <button type="button" class="btn unignore-track-btn" data-track="${escapeHtml(item.track)}" style="padding:3px 8px;font-size:11px" title="Restore this title to detractor analysis">
              Restore
            </button>
          </td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.unignore-track-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const track = btn.getAttribute('data-track');
          if (!track) return;
          try {
            btn.disabled = true;
            btn.textContent = 'Restoring...';
            const unres = await fetch('/api/detractor-songs/unignore', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ track }),
            });
            const undata = await unres.json();
            if (undata.ok) {
              showToast(`Restored "${track}" to detractor analysis`);
              await openIgnoredTracksModal();
              await fetchDashboard();
            } else {
              showToast(undata.error || 'Failed to restore track', 'error');
              btn.disabled = false;
              btn.textContent = 'Restore';
            }
          } catch (err) {
            console.error('Error restoring track:', err);
            showToast('Error restoring track', 'error');
            btn.disabled = false;
            btn.textContent = 'Restore';
          }
        });
      });
    } catch (err) {
      console.error('Error loading ignored detractor tracks:', err);
      tbody.innerHTML = `<tr><td colspan="3" style="padding:14px;text-align:center;color:var(--accent-crimson)">Failed to load excluded titles: ${escapeHtml(err.message)}</td></tr>`;
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

    // Audience Breakdown Scope Tabs
    document.querySelectorAll('#breakdownScopeTabs .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const scope = btn.getAttribute('data-scope') || 'live';
        breakdownScopeMode = scope;
        localStorage.setItem('ozonecast_breakdown_scope', scope);
        updateScopeBadges();
        renderKpiCards();
        if (dashboardState) {
          const activeBreakdowns = getActiveBreakdowns();
          renderGeoBreakdown(activeBreakdowns);
          renderRetentionAndEvents(activeBreakdowns.durationBuckets, dashboardState.recentEvents);
          renderDetractorSongs(activeBreakdowns.detractorSongs, activeBreakdowns.detractorSummary);
          renderDistributionList('playersDistList', activeBreakdowns.players, 'amber');
          renderDistributionList('categoriesDistList', activeBreakdowns.categories, 'cyan');
          renderDistributionList('platformsDistList', activeBreakdowns.platforms, 'emerald');

          const svgEl = document.getElementById('worldMapSvg');
          const tooltipEl = document.getElementById('mapTooltip');
          if (window.OzoneWorldMap && svgEl) {
            let mapLocations = [];
            if (scope === 'live') {
              mapLocations = (dashboardState.listeners || []).filter(l => !l.isBot);
            } else if (activeBreakdowns && activeBreakdowns.mapLocations) {
              mapLocations = activeBreakdowns.mapLocations.filter(l => !l.isBot);
            } else {
              mapLocations = [];
            }
            window.OzoneWorldMap.renderWorldMap(svgEl, tooltipEl, mapLocations, mapViewMode, ip => openIpInspector(ip));
          }
        }
        const scopeNames = {
          live: 'Live Active Connections',
          '24h': 'Past 24 Hours (SQLite)',
          '7d': 'Past 7 Days (SQLite)',
          all: 'All-Time Station History',
        };
        showToast(`Period scope switched to: ${scopeNames[scope] || scope}`);
      });
    });

    // Detractor Songs Scope Tabs
    document.querySelectorAll('#detractorScopeTabs .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const scope = btn.getAttribute('data-scope') || 'past_24h';
        detractorScopeMode = scope;
        localStorage.setItem('ozonecast_detractor_scope', scope);
        const activeBreakdowns = getActiveBreakdowns();
        renderDetractorSongs(activeBreakdowns?.detractorSongs, activeBreakdowns?.detractorSummary);
        const scopeNames = {
          past_24h: 'Past 24 Hours',
          past_7d: 'Past 7 Days',
          all_time: 'All-Time Station History',
        };
        showToast(`Detractor songs scope: ${scopeNames[scope] || scope}`);
      });
    });

    // Time-of-Day Audience Profile Day of Week Tabs
    document.querySelectorAll('#timeOfDayDayTabs .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const day = btn.getAttribute('data-day') || 'all';
        timeOfDayDayMode = day;
        localStorage.setItem('ozonecast_time_of_day_day', day);
        if (dashboardState) {
          renderTimeOfDayAndConnectedStats(dashboardState.timeOfDay, dashboardState.kpis);
        }
        const dayLabels = {
          all: 'All Week (7-Day Average)',
          weekdays: 'Weekdays (Mon–Fri Average)',
          weekend: 'Weekend (Sat–Sun Average)',
          mon: 'Monday Audience Schedule',
          tue: 'Tuesday Audience Schedule',
          wed: 'Wednesday Audience Schedule',
          thu: 'Thursday Audience Schedule',
          fri: 'Friday Audience Schedule',
          sat: 'Saturday Audience Schedule',
          sun: 'Sunday Audience Schedule',
        };
        showToast(`Audience schedule: ${dayLabels[day] || day}`);
      });
    });

    // Day of Week Mini Performance Strip click delegation
    document.getElementById('dayOfWeekOverviewStrip')?.addEventListener('click', e => {
      const card = e.target.closest('[data-select-day]');
      if (!card) return;
      const day = card.getAttribute('data-select-day');
      if (!day) return;
      timeOfDayDayMode = day;
      localStorage.setItem('ozonecast_time_of_day_day', day);
      if (dashboardState) {
        renderTimeOfDayAndConnectedStats(dashboardState.timeOfDay, dashboardState.kpis);
      }
      const dayLabels = {
        mon: 'Monday',
        tue: 'Tuesday',
        wed: 'Wednesday',
        thu: 'Thursday',
        fri: 'Friday',
        sat: 'Saturday',
        sun: 'Sunday',
      };
      showToast(`Showing hourly curve & dayparts for ${dayLabels[day] || day}`);
    });

    // Geo Breakdown Tabs
    document.getElementById('geoTabCountriesBtn')?.addEventListener('click', e => {
      geoTabMode = 'countries';
      e.currentTarget.classList.add('active');
      document.getElementById('geoTabCitiesBtn')?.classList.remove('active');
      const b = getActiveBreakdowns() || dashboardState?.breakdowns;
      if (b) renderGeoBreakdown(b);
    });
    document.getElementById('geoTabCitiesBtn')?.addEventListener('click', e => {
      geoTabMode = 'cities';
      e.currentTarget.classList.add('active');
      document.getElementById('geoTabCountriesBtn')?.classList.remove('active');
      const b = getActiveBreakdowns() || dashboardState?.breakdowns;
      if (b) renderGeoBreakdown(b);
    });

    // Historical Track Markers Toggle
    const showTracksCb = document.getElementById('historyShowTracksCheckbox');
    const showTracksWrap = document.getElementById('historyShowTracksWrap');
    if (showTracksCb) {
      showTracksCb.checked = showTracksSetting;
      if (showTracksWrap) showTracksWrap.classList.toggle('checked', showTracksSetting);
      showTracksCb.addEventListener('change', () => {
        showTracksSetting = showTracksCb.checked;
        localStorage.setItem('ozonecast_show_tracks', showTracksSetting ? '1' : '0');
        if (showTracksWrap) showTracksWrap.classList.toggle('checked', showTracksSetting);
        showToast(
          showTracksSetting
            ? '🎵 Showing track change markers on historical curve'
            : '🎵 Hidden track change markers on historical curve'
        );
        renderHistoryChart(currentHistoryData, currentTrackChanges);
      });
    }

    // Historical Range Tabs
    document.querySelectorAll('#historyRangeTabs .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#historyRangeTabs .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedRangeMinutes = parseInt(btn.getAttribute('data-range') || '60', 10);
        historyHoverIdx = null;

        const historyScopeBadge = document.getElementById('historyTimeScopeBadge');
        if (historyScopeBadge) {
          const rangeMap = {
            15: '⏱️ 15m Window',
            60: '⏱️ 1h Window',
            360: '⏱️ 6h Window',
            1440: '⏱️ 24h Window',
            10080: '📅 7d Window',
          };
          historyScopeBadge.textContent = rangeMap[selectedRangeMinutes] || `⏱️ ${selectedRangeMinutes}m Window`;
          historyScopeBadge.className = selectedRangeMinutes > 1440 ? 'time-bound-badge time-7d' : 'time-bound-badge time-24h';
        }

        fetchDashboard();
      });
    });

    // Historical Chart Hover Interaction
    const histCanvas = document.getElementById('historyChartCanvas');
    const histTooltip = document.getElementById('historyTooltip');

    function handleHistPointer(e) {
      if (!histCanvas || currentHistoryData.length === 0) return;
      const rect = histCanvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      const padLeft = 38;
      const padRight = 14;
      const plotW = rect.width - padLeft - padRight;

      if (x < padLeft - 10 || x > rect.width - padRight + 10 || y < 0 || y > rect.height) {
        handleHistLeave();
        return;
      }

      const frac = Math.max(0, Math.min(1, (x - padLeft) / Math.max(1, plotW)));
      const nearestIdx = Math.round(frac * (currentHistoryData.length - 1));

      if (historyHoverIdx !== nearestIdx) {
        historyHoverIdx = nearestIdx;
        renderHistoryChart(currentHistoryData);
      }
    }

    function handleHistLeave() {
      if (historyHoverIdx !== null) {
        historyHoverIdx = null;
        renderHistoryChart(currentHistoryData);
      }
      if (histTooltip) {
        histTooltip.classList.add('hidden');
      }
    }

    if (histCanvas) {
      histCanvas.addEventListener('mousemove', handleHistPointer);
      histCanvas.addEventListener('mouseleave', handleHistLeave);
      histCanvas.addEventListener('touchmove', handleHistPointer, { passive: true });
      histCanvas.addEventListener('touchend', handleHistLeave);
    }

    // Retention vs Event Feed Tabs
    document.getElementById('tabRetentionBtn')?.addEventListener('click', e => {
      rightMidTabMode = 'retention';
      e.currentTarget.classList.add('active');
      document.getElementById('tabEventFeedBtn')?.classList.remove('active');
      document.getElementById('rightMidPanelTitle').textContent = 'Listener Retention & Tune-In Duration';
      document.getElementById('rightMidPanelSub').textContent = 'Distribution of active listener loyalty cohorts';
      const b = getActiveBreakdowns() || dashboardState?.breakdowns;
      if (b && dashboardState) renderRetentionAndEvents(b.durationBuckets, dashboardState.recentEvents);
      updateScopeBadges();
    });
    document.getElementById('tabEventFeedBtn')?.addEventListener('click', e => {
      rightMidTabMode = 'events';
      e.currentTarget.classList.add('active');
      document.getElementById('tabRetentionBtn')?.classList.remove('active');
      document.getElementById('rightMidPanelTitle').textContent = 'Real-Time Join / Leave Activity Log';
      document.getElementById('rightMidPanelSub').textContent = 'Audit trail of listener connections and disconnections (Last 24h)';
      const retBadge = document.getElementById('retentionTimeScopeBadge');
      if (retBadge) {
        retBadge.className = 'time-bound-badge time-24h';
        retBadge.textContent = '⏱️ Last 24h Log';
      }
      const b = getActiveBreakdowns() || dashboardState?.breakdowns;
      if (b && dashboardState) renderRetentionAndEvents(b.durationBuckets, dashboardState.recentEvents);
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
    document.getElementById('badgeFilterSelect')?.addEventListener('change', e => {
      tableBadgeFilter = e.target.value || 'ALL';
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

    // Table row actions delegation (Inspect IP, Copy IP, Kick Client, Mark/Unmark Bot)
    const handleTableRowAction = async e => {
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
        const clientIdsAttr = kickBtn.getAttribute('data-client-ids');
        const clientIds = clientIdsAttr ? clientIdsAttr.split(',').filter(Boolean) : (clientId ? [clientId] : []);
        kickBtn.disabled = true;
        kickBtn.textContent = 'Kicking...';
        try {
          const res = await fetch('/api/kick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, clientIds, ip }),
          });
          const data = await res.json();
          if (data.ok) {
            showToast(data.message || `Disconnected listener ${ip || clientId}`);
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
    };

    document.getElementById('clientsTableBody')?.addEventListener('click', handleTableRowAction);

    const botsAccordion = document.getElementById('botsAccordion');
    if (botsAccordion) {
      botsAccordion.addEventListener('click', handleTableRowAction);
      // 'toggle' does not bubble, so listen on capture phase
      botsAccordion.addEventListener('toggle', e => {
        const details = e.target.closest('details[data-category-id]');
        if (!details) return;
        const catId = details.getAttribute('data-category-id');
        if (!catId) return;
        if (details.open) {
          expandedBotCategories.add(catId);
        } else {
          expandedBotCategories.delete(catId);
        }
        localStorage.setItem('ozonecast_expanded_bots', JSON.stringify(Array.from(expandedBotCategories)));
      }, true);
    }

    document.getElementById('botsExpandAllBtn')?.addEventListener('click', () => {
      document.querySelectorAll('#botsAccordion details.bot-category-group').forEach(d => {
        const catId = d.getAttribute('data-category-id');
        if (catId) expandedBotCategories.add(catId);
        d.open = true;
      });
      localStorage.setItem('ozonecast_expanded_bots', JSON.stringify(Array.from(expandedBotCategories)));
      showToast('Expanded all bot categories');
    });

    document.getElementById('botsCollapseAllBtn')?.addEventListener('click', () => {
      expandedBotCategories.clear();
      localStorage.setItem('ozonecast_expanded_bots', JSON.stringify([]));
      document.querySelectorAll('#botsAccordion details.bot-category-group').forEach(d => {
        d.open = false;
      });
      showToast('Collapsed all bot categories');
    });

    // Theme Switcher (Auto based on time of day, Day / White, Dark)
    document.getElementById('themeSwitchGroup')?.addEventListener('click', e => {
      const btn = e.target.closest('.theme-btn');
      if (!btn) return;
      const mode = btn.getAttribute('data-theme-mode');
      if (mode) applyTheme(mode, true);
    });

    // Minute ticker to check if time of day changes in Auto theme mode
    setInterval(() => {
      if (themeMode === 'auto') {
        const currentEffective = document.documentElement.getAttribute('data-theme');
        const expected = resolveEffectiveTheme('auto');
        if (currentEffective !== expected) {
          applyTheme('auto', true);
        } else {
          const autoLabel = document.getElementById('themeAutoLabel');
          if (autoLabel) {
            autoLabel.textContent = `Auto (${isDaytime() ? 'Day' : 'Night'})`;
          }
        }
      }
    }, 60000);

    // Deduplicate Listeners toggle in table toolbar
    const dedupeCb = document.getElementById('dedupeListenersCheckbox');
    const dedupeWrap = document.getElementById('dedupeToggleWrap');
    if (dedupeCb) {
      dedupeCb.checked = dedupeListenersSetting;
      if (dedupeWrap) dedupeWrap.classList.toggle('checked', dedupeListenersSetting);
      dedupeCb.addEventListener('change', () => {
        dedupeListenersSetting = dedupeCb.checked;
        localStorage.setItem('ozonecast_dedupe_listeners', dedupeListenersSetting ? '1' : '0');
        if (dedupeWrap) dedupeWrap.classList.toggle('checked', dedupeListenersSetting);
        showToast(
          dedupeListenersSetting
            ? '✨ Grouping simultaneous connections (1 row per listener)'
            : '📡 Showing all raw Icecast client connections'
        );
        renderClientsTable();
      });
    }

    // Exclude Bots checkbox toggle in Connected Clients toolbar
    const excludeBotsCb = document.getElementById('excludeBotsCheckbox');
    const excludeBotsWrap = document.getElementById('excludeBotsWrap');
    if (excludeBotsCb) {
      excludeBotsCb.checked = excludeBotsSetting;
      if (excludeBotsWrap) excludeBotsWrap.classList.toggle('checked', excludeBotsSetting);
      excludeBotsCb.addEventListener('change', () => {
        excludeBotsSetting = excludeBotsCb.checked;
        localStorage.setItem('ozonecast_exclude_bots', excludeBotsSetting ? '1' : '0');
        if (excludeBotsWrap) excludeBotsWrap.classList.toggle('checked', excludeBotsSetting);
        showToast(
          excludeBotsSetting
            ? '🤖 Flagged bots hidden from connected clients table'
            : '👥 Flagged bots shown in connected clients table'
        );
        renderClientsTable();
      });
    }

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

    // Returning Listeners Sort By quick selector
    document.getElementById('returningSortByQuickSelect')?.addEventListener('change', async e => {
      const val = e.target.value === 'sessions' ? 'sessions' : 'total_time';
      returningSortMode = val;
      localStorage.setItem('ozonecast_returning_sort', val);
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returningSortBy: val }),
      });
      showToast(`Top Returning ranked by: ${val === 'sessions' ? 'Session Reconnects' : 'Total Listening Time'}`);
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

    // Helper: deduplicate raw listeners array by (IP + Player / User-Agent)
    function getDeduplicatedListeners(listeners) {
      const groupMap = new Map();
      for (const l of listeners || []) {
        const key = getListenerDeviceKey(l);
        if (!groupMap.has(key)) {
          groupMap.set(key, {
            ...l,
            streams: [l],
            allClientIds: [String(l.clientId)],
            connectionsFromIp: l.connectionsFromIp || 1,
          });
        } else {
          const group = groupMap.get(key);
          group.streams.push(l);
          group.allClientIds.push(String(l.clientId));
          if ((l.connectedSeconds || 0) > (group.connectedSeconds || 0)) {
            group.connectedSeconds = l.connectedSeconds;
            group.clientId = l.clientId;
            if (l.ua?.player && l.ua.player !== 'Audio Client') {
              group.ua = l.ua;
              group.userAgent = l.userAgent;
            }
          }
          group.connectionsFromIp = group.streams.length;
        }
      }
      return Array.from(groupMap.values());
    }

    // Export CSV & JSON
    document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
      if (!dashboardState || !dashboardState.listeners) return;
      const headers = ['ClientID', 'IP', 'FriendlyName', 'CountryCode', 'Country', 'City', 'ConnectedSeconds', 'ActiveStreams', 'Player', 'Category', 'OS', 'Mount', 'UserAgent'];
      const lines = [headers.join(',')];
      let exportRows = dedupeListenersSetting ? getDeduplicatedListeners(dashboardState.listeners) : dashboardState.listeners;
      if (excludeBotsSetting) exportRows = exportRows.filter(r => !r.isBot);
      for (const l of exportRows) {
        const row = [
          l.clientId,
          l.ip,
          `"${(l.friendlyName || '').replace(/"/g, '""')}"`,
          l.geo?.countryCode || '',
          `"${(l.geo?.countryName || '').replace(/"/g, '""')}"`,
          `"${(l.geo?.city || '').replace(/"/g, '""')}"`,
          l.connectedSeconds,
          l.connectionsFromIp || (l.streams ? l.streams.length : 1),
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
        if (document.getElementById('cfgReturningSortBy')) {
          document.getElementById('cfgReturningSortBy').value = data.config.returningSortBy || 'total_time';
        }
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
        returningSortBy: document.getElementById('cfgReturningSortBy')?.value || 'total_time',
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

    // Ignored / Downtime Stream Placeholders Modal
    const ignoredBackdrop = document.getElementById('ignoredTracksModalBackdrop');
    document.getElementById('manageIgnoredTracksBtn')?.addEventListener('click', openIgnoredTracksModal);
    document.getElementById('closeIgnoredTracksModalBtn')?.addEventListener('click', () => ignoredBackdrop?.classList.add('hidden'));
    document.getElementById('closeIgnoredTracksModalFooterBtn')?.addEventListener('click', () => ignoredBackdrop?.classList.add('hidden'));

    ignoredBackdrop?.addEventListener('click', (e) => {
      if (e.target === ignoredBackdrop) {
        ignoredBackdrop.classList.add('hidden');
      }
    });

    document.getElementById('addIgnoredTrackForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const trackInput = document.getElementById('newIgnoredTrackInput');
      const reasonInput = document.getElementById('newIgnoredReasonInput');
      const track = (trackInput?.value || '').trim();
      const reason = (reasonInput?.value || 'User excluded downtime / test placeholder').trim();
      if (!track) return;

      try {
        const res = await fetch('/api/detractor-songs/ignore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ track, reason }),
        });
        const data = await res.json();
        if (data.ok) {
          showToast(`Excluded "${track}" from detractor statistics`);
          if (trackInput) trackInput.value = '';
          if (reasonInput) reasonInput.value = '';
          await openIgnoredTracksModal();
          await fetchDashboard();
        } else {
          showToast(data.error || 'Failed to exclude track', 'error');
        }
      } catch (err) {
        console.error('Error adding ignored track:', err);
        showToast('Error excluding track', 'error');
      }
    });

    window.addEventListener('resize', () => {
      if (dashboardState) {
        renderHistoryChart(dashboardState.history, dashboardState.trackChanges);
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
