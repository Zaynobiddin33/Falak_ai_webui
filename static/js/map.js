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
  canvas.style.zIndex = "420";
  map.getPanes().overlayPane.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: true });

  let cells = [];
  let field = {};
  let selectedCell = null;
  let currentMetric = "h7";
  let gridOpacity = 0.65;
  let drawTimer = null;
  const cachedCells = new Map();

  function n(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= -999) return fallback;
    return number;
  }

  function v(cell, name, fallback = 0) {
    const index = field[name];
    return index == null ? fallback : n(cell[index], fallback);
  }

  function scoreToColor(score) {
    const stops = [
      [0.0, [22, 163, 74]],
      [0.2, [74, 222, 128]],
      [0.45, [250, 204, 21]],
      [0.7, [249, 115, 22]],
      [1.0, [185, 28, 28]],
    ];
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

  function metricScore(cell) {
    if (currentMetric === "h14") return v(cell, "h14", 50) / 100;
    if (currentMetric === "ndvi") return Math.max(0, Math.min(1, v(cell, "ndvi", 0.35)));
    if (currentMetric === "moisture") return Math.max(0, Math.min(1, v(cell, "sm", 0.18) / 0.45));
    return v(cell, "h7", 50) / 100;
  }

  function lodConfig() {
    const zoom = map.getZoom();
    if (zoom < 8.8) return { stride: 180, shape: "dot", size: 2.2, alpha: 0.14 };
    if (zoom < 9.7) return { stride: 95, shape: "dot", size: 2.4, alpha: 0.20 };
    if (zoom < 10.7) return { stride: 45, shape: "dot", size: 2.8, alpha: 0.28 };
    if (zoom < 11.7) return { stride: 18, shape: "dot", size: 3.2, alpha: 0.38 };
    if (zoom < 12.6) return { stride: 7, shape: "rect", size: 6, alpha: 0.56 };
    if (zoom < 13.4) return { stride: 3, shape: "rect", size: 8, alpha: 0.66 };
    return { stride: 1, shape: "rect", size: null, alpha: 0.78 };
  }

  function sampleCell(cell, stride) {
    if (stride <= 1) return true;
    const latKey = Math.round(v(cell, "lat") * 1000);
    const lonKey = Math.round(v(cell, "lon") * 1000);
    const hash = Math.abs((latKey * 73856093) ^ (lonKey * 19349663));
    return hash % stride === 0;
  }

  function cellSizePx(config) {
    if (config.size) return config.size;
    const zoom = map.getZoom();
    const center = map.getCenter();
    const a = map.latLngToContainerPoint(center);
    const b = map.latLngToContainerPoint([center.lat, center.lng + 0.01]);
    return Math.max(8, Math.min(28, Math.abs(b.x - a.x) * 0.9));
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
    if (!cells.length) return;

    const bounds = map.getBounds().pad(0.08);
    const config = lodConfig();
    const px = cellSizePx(config);
    const half = px / 2;
    const alpha = gridOpacity * config.alpha;

    ctx.globalAlpha = alpha;
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (!sampleCell(cell, config.stride)) continue;
      const lat = v(cell, "lat");
      const lon = v(cell, "lon");
      if (!bounds.contains([lat, lon])) continue;
      const point = map.latLngToContainerPoint([lat, lon]);
      if (point.x < -px || point.y < -px || point.x > size.x + px || point.y > size.y + px) continue;
      ctx.fillStyle = scoreToColor(metricScore(cell));
      if (config.shape === "dot") {
        ctx.beginPath();
        ctx.arc(point.x, point.y, px, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(Math.round(point.x - half), Math.round(point.y - half), px, px);
      }
    }

    if (selectedCell) {
      const p = map.latLngToContainerPoint([v(selectedCell, "lat"), v(selectedCell, "lon")]);
      const selectedSize = Math.max(12, px + 4);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        Math.round(p.x - selectedSize / 2),
        Math.round(p.y - selectedSize / 2),
        selectedSize,
        selectedSize
      );
    }

    ctx.globalAlpha = 1;
  }

  async function loadGrid() {
    try {
      const res = await fetch(F.suvradarGrid);
      if (!res.ok) throw new Error(`grid fetch failed: ${res.status}`);
      const data = await res.json();
      field = Object.fromEntries(data.fields.map((name, index) => [name, index]));
      cells = data.cells || [];
      drawGrid();
    } catch (e) {
      console.error(e);
    }
  }

  function riskClass(rawIri) {
    if (rawIri >= 55) return "HIGH";
    if (rawIri >= 40) return "MEDIUM";
    return "LOW";
  }

  function stressLabel(cls) {
    return { HIGH: "YUQORI", MEDIUM: "O'RTACHA", LOW: "PAST" }[cls] || cls;
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

  function series(base, spread) {
    return Array.from({ length: 30 }, (_, i) => Number((base + Math.sin(i * 0.42) * spread).toFixed(3)));
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
        ndvi: series(v(cell, "ndvi", 0.35), 0.035),
        moisture: series(moisture, 2.2),
        rainfall: series(rainfall / 30, 0.4),
        temperature: series(temp, 1.4),
        et: series(v(cell, "et", 4), 0.35),
      },
    };
  }

  async function enrichStats(stats) {
    const horizon = currentMetric === "h14" ? 14 : 7;
    const cacheKey = `${stats.lat.toFixed(4)},${stats.lng.toFixed(4)},${horizon}`;
    if (cachedCells.has(cacheKey)) return cachedCells.get(cacheKey);
    try {
      const res = await fetch(`${F.apiCell}?lat=${stats.lat}&lng=${stats.lng}&horizon=${horizon}`);
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
    const h7 = Number(s.forecast_iri_h7 || 0).toFixed(1);
    const h14 = Number(s.forecast_iri_h14 || 0).toFixed(1);
    card.innerHTML = `
      <div class="cc-head">
        <span class="cc-id">${s.id}</span>
        <span class="${cls}">${stressLabel(s.stress_class)}</span>
      </div>
      <div class="cc-body">
        <div class="cc-row"><span>Tuman</span><span>${s.district}</span></div>
        <div class="cc-row"><span>7/14 kun IRI</span><span>${h7} / ${h14}</span></div>
        <div class="cc-row"><span>Tuproq namligi</span><span>${Number(s.soil_moisture_pct || 0).toFixed(1)}%</span></div>
        <div class="cc-row"><span>NDVI</span><span>${Number(s.ndvi || 0).toFixed(2)}</span></div>
        <div class="cc-row"><span>Eng yaqin suv</span><span>${s.nearest_water} · ${Number(s.distance_to_water_km || 0).toFixed(1)} km</span></div>
      </div>
      <div class="cc-foot">
        ${s.inspection_window_h ? `${s.inspection_window_h} soat ichida tekshiring` : "Tezkor harakat shart emas"}
      </div>
    `;
  }

  function updateLegend(metric) {
    const label = {
      h7: "7 kunlik IRI prognoz",
      h14: "14 kunlik IRI prognoz",
      ndvi: "NDVI · o'simlik",
      moisture: "Tuproq namligi",
    }[metric] || metric;
    document.getElementById("legendLabel").textContent = label;
  }

  window.FalakMap = {
    setMetric(metric) {
      currentMetric = metric;
      updateLegend(metric);
      drawGrid();
      if (selectedCell) selectCell(selectedCell);
    },
    setBackground(name) {
      if (!tilesByName[name] || name === currentBg) return;
      map.removeLayer(tilesByName[currentBg]);
      tilesByName[name].addTo(map);
      currentBg = name;
    },
    setOpacity(pct) {
      gridOpacity = pct / 100;
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
    const cell = nearestCell(event.latlng);
    if (cell) selectCell(cell);
  });

  const months = ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];
  const d = new Date();
  document.getElementById("topbarDate").textContent =
    `${String(d.getDate()).padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;

  loadGrid();
})();
