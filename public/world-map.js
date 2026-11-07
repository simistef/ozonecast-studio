/**
 * Interactive Vector World & Europe Map Renderer for OzoneCast
 * Projects (lat, lon) onto an 800x400 equirectangular SVG canvas,
 * supports World vs Europe zoom focus, and renders live listener clusters.
 */
(function () {
  // Simplified high-recognition continental & regional SVG polygon paths (800x400 equirectangular)
  // Using lon [-180..180] -> x [0..800], lat [90..-90] -> y [0..400]
  const CONTINENT_POLYGONS = [
    // North America
    'M 52,58 L 118,52 L 165,62 L 222,76 L 265,98 L 245,126 L 218,148 L 195,165 L 182,188 L 160,175 L 138,150 L 122,124 L 96,102 L 58,86 Z',
    // Greenland
    'M 275,34 L 332,30 L 348,54 L 315,76 L 280,68 Z',
    // Central America & Caribbean
    'M 182,188 L 210,192 L 224,208 L 204,214 L 186,202 Z',
    // South America
    'M 214,210 L 258,214 L 298,242 L 306,278 L 280,322 L 252,366 L 236,362 L 228,312 L 212,265 L 204,234 Z',
    // UK & Ireland
    'M 384,88 L 398,85 L 402,102 L 386,105 Z',
    // Continental Europe & Scandinavia
    'M 412,52 L 448,46 L 478,56 L 495,78 L 488,108 L 498,128 L 472,138 L 456,142 L 442,132 L 424,136 L 402,138 L 384,134 L 386,118 L 404,106 L 418,92 L 410,72 Z',
    // Eurasia / Russia / Asia
    'M 488,56 L 568,48 L 664,54 L 748,66 L 772,92 L 732,124 L 712,158 L 686,184 L 656,196 L 634,216 L 614,192 L 586,208 L 566,182 L 538,176 L 512,162 L 496,136 L 488,108 Z',
    // Japan
    'M 728,126 L 742,122 L 746,144 L 730,148 Z',
    // Southeast Asia & Indonesia
    'M 636,218 L 678,224 L 712,240 L 698,256 L 642,248 Z',
    // Africa & Madagascar
    'M 382,144 L 434,142 L 472,152 L 502,168 L 518,204 L 496,246 L 482,292 L 456,318 L 432,312 L 422,272 L 408,226 L 376,204 L 366,174 Z',
    'M 508,266 L 520,264 L 518,292 L 506,290 Z',
    // Australia & New Zealand
    'M 656,268 L 722,264 L 744,296 L 728,328 L 672,324 L 650,298 Z',
    'M 762,332 L 778,326 L 774,352 L 758,348 Z',
  ];

  function latLonToXY(lat, lon) {
    const clampedLat = Math.max(-85, Math.min(85, Number(lat) || 0));
    const clampedLon = Math.max(-180, Math.min(180, Number(lon) || 0));
    const x = ((clampedLon + 180) / 360) * 800;
    const y = ((90 - clampedLat) / 180) * 400;
    return { x, y };
  }

  function renderWorldMap(svgEl, tooltipEl, listeners, viewMode = 'world', onSelectIp) {
    if (!svgEl) return;

    // Set viewBox based on viewMode ('world' vs 'europe')
    if (viewMode === 'europe') {
      svgEl.setAttribute('viewBox', '355 55 170 105');
    } else {
      svgEl.setAttribute('viewBox', '0 20 800 360');
    }

    // Group listeners by close coordinates so overlapping pins in the same city cluster cleanly
    const clusters = new Map();
    for (const l of listeners) {
      const lat = l.geo?.lat ?? 44.43;
      const lon = l.geo?.lon ?? 26.1;
      const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
      if (!clusters.has(key)) {
        clusters.set(key, {
          lat,
          lon,
          city: l.geo?.city || 'Unknown',
          countryCode: l.geo?.countryCode || 'UN',
          countryName: l.geo?.countryName || '',
          clients: [],
        });
      }
      clusters.get(key).clients.push(l);
    }

    const strokeScale = viewMode === 'europe' ? 0.35 : 1;

    // Build graticule lines
    let graticuleHtml = '';
    for (let lon = -150; lon <= 150; lon += 30) {
      const { x } = latLonToXY(0, lon);
      graticuleHtml += `<line class="map-graticule" x1="${x}" y1="0" x2="${x}" y2="400" style="stroke-width:${0.5 * strokeScale}" />`;
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const { y } = latLonToXY(lat, 0);
      graticuleHtml += `<line class="map-graticule" x1="0" y1="${y}" x2="800" y2="${y}" style="stroke-width:${0.5 * strokeScale}" />`;
    }

    const landHtml = CONTINENT_POLYGONS.map(
      d => `<path class="map-land" d="${d}" style="stroke-width:${0.6 * strokeScale}" />`
    ).join('');

    let pinsHtml = '';
    const clusterList = Array.from(clusters.values());
    clusterList.forEach((cluster, idx) => {
      const { x, y } = latLonToXY(cluster.lat, cluster.lon);
      const count = cluster.clients.length;
      const baseRadius = Math.min(9, 3.6 + Math.sqrt(count) * 1.4) * (viewMode === 'europe' ? 0.38 : 1);
      const pulseRadius = baseRadius * 2.1;

      pinsHtml += `
        <g class="map-pin-group" data-cluster-idx="${idx}" transform="translate(${x.toFixed(2)}, ${y.toFixed(2)})">
          <circle class="map-pin-pulse" r="${pulseRadius.toFixed(2)}" cx="0" cy="0" />
          <circle class="map-pin-core" r="${baseRadius.toFixed(2)}" cx="0" cy="0" style="stroke-width:${1.1 * strokeScale}" />
        </g>
      `;
    });

    svgEl.innerHTML = `
      <g class="graticules">${graticuleHtml}</g>
      <g class="continents">${landHtml}</g>
      <g class="pins">${pinsHtml}</g>
    `;

    // Attach hover & click listeners to pins
    const pinGroups = svgEl.querySelectorAll('.map-pin-group');
    pinGroups.forEach(group => {
      const idx = Number(group.getAttribute('data-cluster-idx'));
      const cluster = clusterList[idx];
      if (!cluster) return;

      group.addEventListener('mouseenter', e => {
        if (!tooltipEl) return;
        const topClients = cluster.clients.slice(0, 3);
        const clientLines = topClients
          .map(
            c =>
              `<div class="mono" style="font-size:11px;color:var(--text-secondary)">${c.ip} • ${c.ua.player}</div>`
          )
          .join('');
        const extra =
          cluster.clients.length > 3
            ? `<div style="font-size:11px;color:var(--text-muted)">+${cluster.clients.length - 3} more in ${cluster.city}</div>`
            : '';

        tooltipEl.innerHTML = `
          <div style="font-weight:600;color:var(--text-primary);margin-bottom:3px">
            ${cluster.city}, ${cluster.countryCode}
            <span style="color:var(--accent-amber);margin-left:6px" class="mono">${cluster.clients.length} listener${cluster.clients.length > 1 ? 's' : ''}</span>
          </div>
          ${clientLines}
          ${extra}
        `;
        tooltipEl.classList.remove('hidden');
      });

      group.addEventListener('mousemove', e => {
        if (!tooltipEl) return;
        const rect = svgEl.parentElement.getBoundingClientRect();
        let left = e.clientX - rect.left + 14;
        let top = e.clientY - rect.top - 10;
        if (left + 190 > rect.width) left = e.clientX - rect.left - 195;
        if (top + 90 > rect.height) top = rect.height - 95;
        tooltipEl.style.left = `${Math.max(8, left)}px`;
        tooltipEl.style.top = `${Math.max(8, top)}px`;
      });

      group.addEventListener('mouseleave', () => {
        if (tooltipEl) tooltipEl.classList.add('hidden');
      });

      group.addEventListener('click', () => {
        if (onSelectIp && cluster.clients[0]) {
          onSelectIp(cluster.clients[0].ip);
        }
      });
    });
  }

  window.OzoneWorldMap = {
    renderWorldMap,
  };
})();
