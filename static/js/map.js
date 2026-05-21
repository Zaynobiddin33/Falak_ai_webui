/* ════════════════════════════════════════════════════════════════
   Map · Leaflet + 1 km IRI grid overlay
   ════════════════════════════════════════════════════════════════ */

(function () {
  const F = window.FALAK;
  const CELL_DEG = 0.01; // 1 km

  // ─── Map init ────────────────────────────────────────────────
  const map = L.map("map", {
    zoomControl: true,
    minZoom: 7,
    maxZoom: 16,
    preferCanvas: true,
  }).setView([F.aoi.center.lat, F.aoi.center.lng], F.aoi.default_zoom);

  L.control.attribution({ prefix: false }).addTo(map);

  // tile layers
  const tileDark = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { attribution: "© OpenStreetMap, © CARTO", maxZoom: 19, subdomains: "abcd" }
  );
  const tileSat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "© Esri World Imagery", maxZoom: 19 }
  );
  const tileStreet = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: "© OpenStreetMap", maxZoom: 19 }
  );

  const tilesByName = { dark: tileDark, satellite: tileSat, street: tileStreet };
  let currentBg = "dark";
  tileDark.addTo(map);

  // AOI hint rectangle
  const b = F.aoi.bounds;
  L.rectangle([[b.south, b.west], [b.north, b.east]], {
    color: "#4cb7ff",
    weight: 1.5,
    fill: false,
    opacity: 0.4,
    dashArray: "6 4",
  }).addTo(map);

  // District markers
  F.districts.forEach((d) => {
    L.circleMarker([d.lat, d.lng], {
      radius: 4,
      color: "#a855f7",
      fillColor: "#a855f7",
      fillOpacity: 0.7,
      weight: 1,
    })
      .bindTooltip(d.name, {
        permanent: false,
        className: "dist-tip",
        direction: "top",
        offset: [0, -6],
      })
      .addTo(map);
  });

  // ─── Grid layer + state ──────────────────────────────────────
  const gridLayer = L.layerGroup().addTo(map);
  let gridOpacity = 0.65;
  let currentMetric = "iri";
  let selectedRect = null;
  let cachedCells = new Map(); // id -> stats

  // shared color scale: green → yellow → red
  function scoreToColor(s) {
    const stops = [
      [0.0, [22, 163, 74]],
      [0.2, [74, 222, 128]],
      [0.45, [250, 204, 21]],
      [0.7, [249, 115, 22]],
      [1.0, [185, 28, 28]],
    ];
    s = Math.max(0, Math.min(1, s));
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (s >= stops[i][0] && s <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    const t = lo[0] === hi[0] ? 0 : (s - lo[0]) / (hi[0] - lo[0]);
    const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * t);
    const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * t);
    const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * t);
    return `rgb(${r},${g},${b})`;
  }

  // Lightweight per-cell preview score so we don't need to hit the API for every visible cell.
  // (Approximation of the server-side ml_mock — visually identical patches.)
  function previewScore(lat, lng, metric) {
    const freq1 = 18, freq2 = 12, freq3 = 8;
    const ph1 = 1.7, ph2 = 3.1, ph3 = 0.6;
    function smooth(la, ln, freq, phase) {
      return (
        Math.sin(la * freq + phase) * Math.cos(ln * freq * 0.9 - phase * 0.7) +
        0.4 * Math.sin(la * freq * 2.3 - phase) * Math.cos(ln * freq * 1.7)
      ) / 1.4;
    }
    function bound(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function seed(la, ln, salt) {
      const s = `${la.toFixed(4)},${ln.toFixed(4)},${salt}`;
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return ((h >>> 0) % 10000) / 10000;
    }

    const ndviField = 0.45 + 0.35 * smooth(lat, lng, freq1, ph1);
    const moistField = 0.30 + 0.25 * smooth(lat, lng, freq2, ph2);
    const heat = 0.5 + 0.3 * smooth(lat, lng, freq3, ph3);
    const rain = 0.5 + 0.4 * smooth(lat, lng, 6, 2.4);

    const moisture = bound(moistField + (seed(lat, lng, "m") - 0.5) * 0.08, 0.04, 0.45);
    const ndvi = bound(ndviField + (moisture - 0.25) * 0.4, 0.05, 0.9);
    const iri = bound(
      0.45 * (1 - moisture / 0.45) +
      0.20 * (1 - ndvi) +
      0.20 * Math.max(0, -(-100 + (rain * 50) / 35 * 100)) / 100 +
      0.10 * (2 + heat * 5) / 7 +
      0.05 * 0.3
    );

    if (metric === "ndvi")     return ndvi;
    if (metric === "moisture") return moisture / 0.45;
    if (metric === "stress")   return iri; // same color scale
    return iri;
  }

  // ─── Render visible grid ─────────────────────────────────────
  let renderTimer = null;
  function renderGrid() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(_doRender, 60);
  }
  function _doRender() {
    gridLayer.clearLayers();
    selectedRect = null;

    const zoom = map.getZoom();
    if (zoom < 9) {
      L.popup({ closeButton: false, autoClose: true })
        .setLatLng(map.getCenter())
        .setContent(`<div style="font-size:12px">Zoom in to see the 1 km grid</div>`);
      return;
    }

    // Sub-sample big areas to keep DOM cheap
    const bounds = map.getBounds();
    let step = CELL_DEG;
    if (zoom <= 10) step = CELL_DEG * 2;
    if (zoom <= 9) step = CELL_DEG * 4;

    // Limit to AOI ± buffer
    const aoi = F.aoi.bounds;
    const latMin = Math.max(bounds.getSouth(), aoi.south - 0.05);
    const latMax = Math.min(bounds.getNorth(), aoi.north + 0.05);
    const lngMin = Math.max(bounds.getWest(),  aoi.west  - 0.05);
    const lngMax = Math.min(bounds.getEast(),  aoi.east  + 0.05);

    // snap to grid
    const startLat = Math.floor(latMin / CELL_DEG) * CELL_DEG;
    const startLng = Math.floor(lngMin / CELL_DEG) * CELL_DEG;

    for (let lat = startLat; lat < latMax; lat += step) {
      for (let lng = startLng; lng < lngMax; lng += step) {
        const cy = lat + step / 2;
        const cx = lng + step / 2;
        const score = previewScore(cy, cx, currentMetric);
        const color = scoreToColor(score);

        const rect = L.rectangle(
          [[lat, lng], [lat + step, lng + step]],
          {
            color: "rgba(255,255,255,0.06)",
            weight: 0.4,
            fillColor: color,
            fillOpacity: gridOpacity,
            interactive: true,
          }
        );

        rect._cellLat = cy;
        rect._cellLng = cx;
        rect.on("mouseover", function () { this.setStyle({ weight: 1.4, color: "rgba(255,255,255,0.7)" }); });
        rect.on("mouseout",  function () {
          if (this !== selectedRect) this.setStyle({ weight: 0.4, color: "rgba(255,255,255,0.06)" });
        });
        rect.on("click", function () { selectCell(this); });

        gridLayer.addLayer(rect);
      }
    }
  }

  // ─── Cell selection ──────────────────────────────────────────
  async function selectCell(rect) {
    if (selectedRect && selectedRect !== rect) {
      selectedRect.setStyle({ weight: 0.4, color: "rgba(255,255,255,0.06)" });
    }
    selectedRect = rect;
    rect.setStyle({ weight: 3, color: "#ffffff" }).bringToFront();

    const lat = rect._cellLat;
    const lng = rect._cellLng;

    // Fetch full stats
    let stats;
    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (cachedCells.has(cacheKey)) {
      stats = cachedCells.get(cacheKey);
    } else {
      try {
        const res = await fetch(`${F.apiCell}?lat=${lat}&lng=${lng}`);
        if (!res.ok) throw new Error("api failed");
        stats = await res.json();
        cachedCells.set(cacheKey, stats);
      } catch (e) {
        console.error(e);
        return;
      }
    }

    // Update floating cell card
    renderCellCard(stats);

    // Update bottom stats
    if (window.FalakStats) window.FalakStats.update(stats);

    // Update chat context + send over WS
    if (window.FalakChat) window.FalakChat.setCellContext(stats);
  }

  function renderCellCard(s) {
    const card = document.getElementById("cellCard");
    const cls = `cc-risk-pill pl-risk-${s.stress_class}`;
    card.innerHTML = `
      <div class="cc-head">
        <span class="cc-id">${s.id}</span>
        <span class="${cls}">${s.stress_class}</span>
      </div>
      <div class="cc-body">
        <div class="cc-row"><span>District</span><span>${s.district}</span></div>
        <div class="cc-row"><span>Crop</span><span>${s.dominant_crop}</span></div>
        <div class="cc-row"><span>IRI score</span><span>${s.iri_score.toFixed(2)}</span></div>
        <div class="cc-row"><span>Soil moisture</span><span>${s.soil_moisture_pct.toFixed(1)}%</span></div>
        <div class="cc-row"><span>NDVI</span><span>${s.ndvi.toFixed(2)}</span></div>
        <div class="cc-row"><span>Nearest water</span><span>${s.nearest_water} · ${s.distance_to_water_km.toFixed(1)} km</span></div>
      </div>
      <div class="cc-foot">
        ${s.inspection_window_h ? `⚠️ Inspect within ${s.inspection_window_h}h` : "✓ No immediate action"}
      </div>
    `;
  }

  // ─── Public controls ─────────────────────────────────────────
  window.FalakMap = {
    setMetric(m) { currentMetric = m; renderGrid(); updateLegend(m); },
    setBackground(name) {
      if (!tilesByName[name] || name === currentBg) return;
      map.removeLayer(tilesByName[currentBg]);
      tilesByName[name].addTo(map);
      currentBg = name;
    },
    setOpacity(pct) {
      gridOpacity = pct / 100;
      gridLayer.eachLayer((l) => l.setStyle({ fillOpacity: gridOpacity }));
    },
    focusDistrict(name) {
      const d = F.districts.find((x) => x.name === name);
      if (!d) return;
      map.flyTo([d.lat, d.lng], 12, { duration: 0.8 });
    },
    leafletMap: map,
  };

  function updateLegend(m) {
    const lbl = {
      iri: "Irrigation Risk Index",
      ndvi: "NDVI (vegetation)",
      moisture: "Soil moisture",
      stress: "Stress class",
    }[m] || m;
    document.getElementById("legendLabel").textContent = lbl;
  }

  // ─── Events ──────────────────────────────────────────────────
  map.on("moveend zoomend", renderGrid);
  renderGrid();

  // Date display
  const fmt = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "2-digit" });
  document.getElementById("topbarDate").textContent = fmt.format(new Date());
})();
