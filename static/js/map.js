/* SuvRadar map: Leaflet base map + canvas-rendered 1 km forecast grid. */

(function () {
  const F = window.FALAK;

  const map = L.map("map", {
    zoomControl: true,
    minZoom: 7,
    maxZoom: 16,
    preferCanvas: true,
  }).setView([F.aoi.center.lat, F.aoi.center.lng], F.aoi.default_zoom);

  L.control.attribution({ prefix: false }).addTo(map);

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

  const b = F.aoi.bounds;
  L.rectangle([[b.south, b.west], [b.north, b.east]], {
    color: "#4cb7ff",
    weight: 1.5,
    fill: false,
    opacity: 0.35,
    dashArray: "6 4",
  }).addTo(map);

  F.districts.forEach((d) => {
    L.circleMarker([d.lat, d.lng], {
      radius: 4,
      color: "#a855f7",
      fillColor: "#a855f7",
      fillOpacity: 0.7,
      weight: 1,
    })
      .bindTooltip(d.name, { permanent: false, direction: "top", offset: [0, -6] })
      .addTo(map);
  });

  const canvas = L.DomUtil.create("canvas", "suvradar-canvas-layer");
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "430";
  map.getPanes().overlayPane.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: true });

  let cells = [];
  let field = {};
  let selectedCell = null;
  let currentMetric = "current";
  let gridOpacity = 0.65;
  let drawTimer = null;
  let metricDomains = {};
  let gridStep = { lat: 0.00898, lon: 0.00898 };
  const cachedCells = new Map();
  const overlayBoundsConfig = F.suvradarOverlayBounds || F.aoi.bounds;
  const overlayBounds = [
    [overlayBoundsConfig.south, overlayBoundsConfig.west],
    [overlayBoundsConfig.north, overlayBoundsConfig.east],
  ];
  const rasterOverlay = L.imageOverlay(
    F.suvradarOverlays?.[currentMetric] || F.suvradarOverlays?.current,
    overlayBounds,
    {
      opacity: gridOpacity,
      zIndex: 420,
      className: "suvradar-raster-overlay",
      interactive: false,
    }
  ).addTo(map);

  function n(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= -999) return fallback;
    return number;
  }

  function v(cell, name, fallback = 0) {
    const index = field[name];
    return index == null ? fallback : n(cell[index], fallback);
  }

  function rampColor(score, stops) {
    score = Math.max(0, Math.min(1, score));
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (score >= stops[i][0] && score <= stops[i + 1][0]) {
        lo = stops[i];
        hi = stops[i + 1];
        break;
      }
    }
    const t = lo[0] === hi[0] ? 0 : (score - lo[0]) / (hi[0] - lo[0]);
    const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * t);
    const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * t);
    const blue = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * t);
    return `rgb(${r},${g},${blue})`;
  }

  function stressColor(score) {
    return rampColor(score, [
      [0.0, [22, 163, 74]],
      [0.2, [74, 222, 128]],
      [0.45, [250, 204, 21]],
      [0.7, [249, 115, 22]],
      [1.0, [185, 28, 28]],
    ]);
  }

  function metricValue(cell, metric = currentMetric) {
    if (metric === "h14") return v(cell, "h14", 50);
    if (metric === "ndvi") return v(cell, "ndvi", 0.35);
    if (metric === "moisture") return v(cell, "sm", 0.18);
    return v(cell, "h7", 50);
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
    return sorted[index];
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function computeGridStep() {
    const lats = Array.from(new Set(cells.map((cell) => Number(v(cell, "lat").toFixed(5))))).sort((a, b) => a - b);
    const lons = Array.from(new Set(cells.map((cell) => Number(v(cell, "lon").toFixed(5))))).sort((a, b) => a - b);
    const latDiffs = [];
    const lonDiffs = [];
    for (let i = 0; i < lats.length - 1; i++) {
      const diff = lats[i + 1] - lats[i];
      if (diff > 0.001 && diff < 0.02) latDiffs.push(diff);
    }
    for (let i = 0; i < lons.length - 1; i++) {
      const diff = lons[i + 1] - lons[i];
      if (diff > 0.001 && diff < 0.02) lonDiffs.push(diff);
    }
    gridStep = {
      lat: median(latDiffs) || 0.00898,
      lon: median(lonDiffs) || 0.00898,
    };
  }

  function computeMetricDomains() {
    const domains = {};
    ["h7", "h14", "ndvi", "moisture"].forEach((metric) => {
      const values = cells
        .map((cell) => metricValue(cell, metric))
        .filter((value) => Number.isFinite(value) && value > -999);
      values.sort((a, b) => a - b);
      let lo = percentile(values, metric === "h7" || metric === "h14" ? 0.02 : 0.04);
      let hi = percentile(values, metric === "h7" || metric === "h14" ? 0.98 : 0.96);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || Math.abs(hi - lo) < 0.001) {
        lo = Math.min(...values, 0);
        hi = Math.max(...values, 1);
      }
      if (Math.abs(hi - lo) < 0.001) hi = lo + 1;
      domains[metric] = { lo, hi };
    });
    metricDomains = domains;
  }

  function normalizedMetricScore(cell, metric = currentMetric) {
    const domain = metricDomains[metric] || { lo: 0, hi: metric === "h7" || metric === "h14" ? 100 : 1 };
    return Math.max(0, Math.min(1, (metricValue(cell, metric) - domain.lo) / (domain.hi - domain.lo)));
  }

  function metricColor(score) {
    if (currentMetric === "ndvi") {
      return rampColor(score, [
        [0.0, [120, 83, 44]],
        [0.45, [234, 179, 8]],
        [1.0, [22, 163, 74]],
      ]);
    }
    if (currentMetric === "moisture") {
      return rampColor(score, [
        [0.0, [185, 28, 28]],
        [0.45, [250, 204, 21]],
        [1.0, [14, 165, 233]],
      ]);
    }
    return stressColor(score);
  }

  function lodConfig() {
    const zoom = map.getZoom();
    if (zoom < 8.4) return { alpha: 0.72 };
    if (zoom < 10.2) return { alpha: 0.66 };
    if (zoom < 12.2) return { alpha: 0.60 };
    return { alpha: 0.54 };
  }

  function cellRect(cell) {
    const lat = Array.isArray(cell) ? v(cell, "lat") : n(cell.lat);
    const lon = Array.isArray(cell) ? v(cell, "lon") : n(cell.lng ?? cell.lon);
    const nw = map.latLngToContainerPoint([lat + gridStep.lat / 2, lon - gridStep.lon / 2]);
    const se = map.latLngToContainerPoint([lat - gridStep.lat / 2, lon + gridStep.lon / 2]);
    return {
      x: Math.floor(Math.min(nw.x, se.x)),
      y: Math.floor(Math.min(nw.y, se.y)),
      w: Math.max(1, Math.ceil(Math.abs(se.x - nw.x))),
      h: Math.max(1, Math.ceil(Math.abs(se.y - nw.y))),
    };
  }

  function drawCellGrid(bounds, size, config) {
    ctx.globalAlpha = gridOpacity * config.alpha;
    for (const cell of cells) {
      const lat = v(cell, "lat");
      const lon = v(cell, "lon");
      if (!bounds.contains([lat, lon])) continue;
      const { x, y, w, h } = cellRect(cell);
      if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
      ctx.fillStyle = metricColor(normalizedMetricScore(cell));
      ctx.fillRect(x, y, w, h);
    }
    ctx.globalAlpha = 1;
    const center = map.getCenter();
    const nw = map.latLngToContainerPoint([center.lat + gridStep.lat / 2, center.lng - gridStep.lon / 2]);
    const se = map.latLngToContainerPoint([center.lat - gridStep.lat / 2, center.lng + gridStep.lon / 2]);
    return Math.max(8, Math.min(72, Math.max(Math.abs(se.x - nw.x), Math.abs(se.y - nw.y))));
  }

  function resizeCanvas() {
    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, topLeft);
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    canvas.width = Math.max(1, Math.floor(size.x * ratio));
    canvas.height = Math.max(1, Math.floor(size.y * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function scheduleDraw() {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(drawGrid, 35);
  }

  function drawGrid() {
    resizeCanvas();
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    if (!selectedCell) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size.x, size.y);
    ctx.clip();

    const rect = cellRect(selectedCell);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  async function loadGrid() {
    drawGrid();
  }

  function riskClass(rawIri) {
    if (rawIri >= 55) return "HIGH";
    if (rawIri >= 40) return "MEDIUM";
    return "LOW";
  }

  function stressLabel(cls) {
    return { HIGH: "YUQORI", MEDIUM: "O'RTACHA", LOW: "PAST" }[cls] || cls;
  }

  function changeClass(delta) {
    if (delta >= 5) return "trend-worse";
    if (delta <= -5) return "trend-better";
    return "trend-stable";
  }

  function signed(value) {
    const number = Number(value || 0);
    return `${number >= 0 ? "+" : ""}${number.toFixed(1)}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function cropLabel(cell) {
    const crop = v(cell, "crop");
    const water = v(cell, "water");
    const built = v(cell, "built");
    if (water >= 0.25) return "Water / canal edge";
    if (crop >= 0.30) return "Cropland";
    if (built >= 0.25) return "Built / settlement";
    if (crop >= 0.08) return "Mixed agriculture";
    return "Bare / pasture";
  }

  function flatSeries(base) {
    return Array(30).fill(Number(base.toFixed(3)));
  }

  function cellToStats(cell) {
    const horizon = currentMetric === "h14" ? 14 : 7;
    const rawIri = horizon === 14 ? v(cell, "h14", 50) : v(cell, "h7", 50);
    const moisture = v(cell, "sm", 0.18) * 100;
    const rainfall = v(cell, "rain", 0);
    const temp = v(cell, "temp", 25);
    const stress = riskClass(rawIri);
    return {
      id: `UZB_${v(cell, "lat").toFixed(4)}_${v(cell, "lon").toFixed(4)}`,
      lat: v(cell, "lat"),
      lng: v(cell, "lon"),
      district: "Farg'ona AOI",
      oblast: "O'zbekiston",
      area_ha: 100,
      iri_score: Number((rawIri / 100).toFixed(3)),
      forecast_iri_h7: Number(v(cell, "h7", rawIri).toFixed(2)),
      forecast_iri_h14: Number(v(cell, "h14", rawIri).toFixed(2)),
      model_horizon_days: horizon,
      stress_class: stress,
      priority_class: stress,
      inspection_window_h: rawIri >= 55 ? 72 : rawIri >= 45 ? 120 : null,
      ndvi: Number(v(cell, "ndvi", 0).toFixed(3)),
      ndmi: Number(v(cell, "ndmi", 0).toFixed(3)),
      ndwi: Number(v(cell, "ndwi", 0).toFixed(3)),
      soil_moisture_pct: Number(moisture.toFixed(1)),
      rainfall_30d_mm: Number(rainfall.toFixed(1)),
      rainfall_anomaly_pct: Number(v(cell, "rain_anom", 0).toFixed(1)),
      temperature_c: Number(temp.toFixed(1)),
      et_mm_day: Number(v(cell, "et", 4).toFixed(2)),
      elevation_m: 0,
      distance_to_water_km: 0,
      nearest_water: "Farg'ona irrigation network",
      dominant_crop: cropLabel(cell),
      history: {
        ndvi: flatSeries(v(cell, "ndvi", 0.35)),
        moisture: flatSeries(moisture),
        rainfall: flatSeries(rainfall / 30),
        temperature: flatSeries(temp),
        et: flatSeries(v(cell, "et", 4)),
      },
    };
  }

  async function enrichStats(stats) {
    const horizon = currentMetric === "h14" || currentMetric === "change14" ? 14 : 7;
    const cacheKey = `${stats.lat.toFixed(4)},${stats.lng.toFixed(4)},${horizon},${currentMetric}`;
    if (cachedCells.has(cacheKey)) return cachedCells.get(cacheKey);
    try {
      const res = await fetch(`${F.apiCell}?lat=${stats.lat}&lng=${stats.lng}&horizon=${horizon}&view=${currentMetric}`);
      if (!res.ok) return stats;
      const enriched = await res.json();
      cachedCells.set(cacheKey, enriched);
      return enriched;
    } catch (e) {
      console.error(e);
      return stats;
    }
  }

  async function selectCell(cell) {
    selectedCell = cell;
    drawGrid();
    const baseStats = cellToStats(cell);
    renderCellCard(baseStats);
    if (window.FalakStats) window.FalakStats.update(baseStats);
    if (window.FalakChat) window.FalakChat.setCellContext(baseStats);

    const stats = await enrichStats(baseStats);
    renderCellCard(stats);
    if (window.FalakStats) window.FalakStats.update(stats);
    if (window.FalakChat) window.FalakChat.setCellContext(stats);
  }

  async function selectLatLng(latlng) {
    const horizon = currentMetric === "h14" || currentMetric === "change14" ? 14 : 7;
    try {
      const res = await fetch(`${F.apiCell}?lat=${latlng.lat}&lng=${latlng.lng}&horizon=${horizon}&view=${currentMetric}`);
      if (!res.ok) return;
      const stats = await res.json();
      selectedCell = { lat: stats.lat, lng: stats.lng };
      drawGrid();
      renderCellCard(stats);
      if (window.FalakStats) window.FalakStats.update(stats);
      if (window.FalakChat) window.FalakChat.setCellContext(stats);
    } catch (e) {
      console.error(e);
    }
  }

  function nearestCell(latlng) {
    if (!cells.length) return null;
    const click = map.latLngToContainerPoint(latlng);
    const bounds = map.getBounds().pad(0.08);
    let best = null;
    let bestD2 = Infinity;
    const maxD = map.getZoom() < 10 ? 18 : 28;
    for (const cell of cells) {
      const lat = v(cell, "lat");
      const lon = v(cell, "lon");
      if (!bounds.contains([lat, lon])) continue;
      const p = map.latLngToContainerPoint([lat, lon]);
      const dx = p.x - click.x;
      const dy = p.y - click.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = cell;
      }
    }
    return bestD2 <= maxD * maxD ? best : null;
  }

  function renderCellCard(s) {
    const card = document.getElementById("cellCard");
    const cls = `cc-risk-pill pl-risk-${s.stress_class}`;
    const current = Number(s.current_iri ?? 0);
    const h7 = Number(s.forecast_iri_h7 || 0).toFixed(1);
    const h14 = Number(s.forecast_iri_h14 || 0).toFixed(1);
    const delta7 = Number(s.delta_iri_h7 ?? Number(h7) - current);
    const delta14 = Number(s.delta_iri_h14 ?? Number(h14) - current);
    const drivers = (s.drivers || []).slice(0, 4).map((d) => {
      const tone = escapeHtml(d.tone || "neutral");
      return `<span class="driver-chip ${tone}">${escapeHtml(d.label || d)}</span>`;
    }).join("");
    card.innerHTML = `
      <div class="cc-head">
        <span class="cc-id">${s.id}</span>
        <span class="${cls}">${stressLabel(s.stress_class)}</span>
      </div>
      <div class="cc-compare">
        <div><small>Kuzatilgan</small><b>${current.toFixed(1)}</b></div>
        <div><small>Model +7</small><b>${h7}</b></div>
        <div><small>Model +14</small><b>${h14}</b></div>
      </div>
      <div class="cc-delta">
        <span class="delta-pill ${changeClass(delta7)}"><span>Δ 7 kun</span><b>${signed(delta7)}</b></span>
        <span class="delta-pill ${changeClass(delta14)}"><span>Δ 14 kun</span><b>${signed(delta14)}</b></span>
      </div>
      <div class="cc-body">
        <div class="cc-row"><span>Tuman</span><span>${s.district}</span></div>
        <div class="cc-row"><span>Tuproq namligi</span><span>${Number(s.soil_moisture_pct || 0).toFixed(1)}%</span></div>
        <div class="cc-row"><span>NDVI</span><span>${Number(s.ndvi || 0).toFixed(2)}</span></div>
        <div class="cc-row"><span>Prognoz yog'in</span><span>${Number(s.forecast_rain_7d_mm || 0).toFixed(1)} / ${Number(s.forecast_rain_14d_mm || 0).toFixed(1)} mm</span></div>
        <div class="cc-row"><span>Eng yaqin suv</span><span>${s.nearest_water} · ${Number(s.distance_to_water_km || 0).toFixed(1)} km</span></div>
      </div>
      ${drivers ? `<div class="cc-drivers">${drivers}</div>` : ""}
      <div class="cc-foot">
        ${s.inspection_window_h ? `${s.inspection_window_h} soat ichida tekshiring` : "Tezkor harakat shart emas"}
      </div>
    `;
  }

  function updateLegend(metric) {
    const config = {
      current: ["Kuzatilgan suv stressi", "Pastroq stress", "Yuqoriroq stress", "stress"],
      h7: ["Model prognozi · 7 kun", "Pastroq stress", "Yuqoriroq stress", "stress"],
      h14: ["Model prognozi · 14 kun", "Pastroq stress", "Yuqoriroq stress", "stress"],
      change7: ["Model Δ · 7 kun", "Yengillashadi", "Yomonlashadi", "change"],
      change14: ["Model Δ · 14 kun", "Yengillashadi", "Yomonlashadi", "change"],
      ndvi: ["NDVI · o'simlik", "Zaif", "Kuchli", "ndvi"],
      moisture: ["Tuproq namligi", "Quruq", "Nam", "moisture"],
    }[metric] || [metric, "Past", "Yuqori", "stress"];
    document.getElementById("legendLabel").textContent = config[0];
    document.getElementById("legendLow").textContent = config[1];
    document.getElementById("legendHigh").textContent = config[2];
    document.getElementById("legend").dataset.kind = config[3];
  }

  window.FalakMap = {
    setMetric(metric) {
      currentMetric = metric;
      if (F.suvradarOverlays?.[metric]) rasterOverlay.setUrl(F.suvradarOverlays[metric]);
      updateLegend(metric);
      drawGrid();
      if (selectedCell) selectLatLng(selectedCell);
    },
    setBackground(name) {
      if (!tilesByName[name] || name === currentBg) return;
      map.removeLayer(tilesByName[currentBg]);
      tilesByName[name].addTo(map);
      currentBg = name;
    },
    setOpacity(pct) {
      gridOpacity = pct / 100;
      rasterOverlay.setOpacity(gridOpacity);
      drawGrid();
    },
    focusDistrict(name) {
      const d = F.districts.find((x) => x.name === name);
      if (!d) return;
      map.flyTo([d.lat, d.lng], 12, { duration: 0.8 });
    },
    leafletMap: map,
  };

  map.on("moveend zoomend resize", scheduleDraw);
  map.on("click", (event) => {
    selectLatLng(event.latlng);
  });

  const months = ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];
  const d = new Date();
  document.getElementById("topbarDate").textContent =
    `${String(d.getDate()).padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;

  updateLegend(currentMetric);
  loadGrid();
})();
