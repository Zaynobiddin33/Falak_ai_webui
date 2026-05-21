/* ════════════════════════════════════════════════════════════════
   Bottom stats strip + sparkline charts
   ════════════════════════════════════════════════════════════════ */

(function () {
  const charts = {};

  function makeSpark(canvas, color) {
    return new Chart(canvas, {
      type: "line",
      data: {
        labels: Array(30).fill(""),
        datasets: [{
          data: [],
          borderColor: color,
          backgroundColor: color + "22",
          borderWidth: 1.6,
          tension: 0.34,
          pointRadius: 0,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: false },
        },
      },
    });
  }

  function initSparks() {
    const colorByKey = {
      iri:         "#f97316",
      ndvi:        "#22c55e",
      moisture:    "#4cb7ff",
      rainfall:    "#facc15",
      temperature: "#ef4444",
    };
    document.querySelectorAll(".sc-spark").forEach((canvas) => {
      const key = canvas.dataset.spark;
      charts[key] = makeSpark(canvas, colorByKey[key] || "#4cb7ff");
    });
  }
  initSparks();

  function update(stats) {
    setValue("card-iri",      stats.iri_score.toFixed(2), stats.stress_class);
    setValue("card-ndvi",     stats.ndvi.toFixed(2));
    setValue("card-moisture", stats.soil_moisture_pct.toFixed(1));
    setValue("card-rain",     stats.rainfall_30d_mm.toFixed(1));
    setValue("card-temp",     stats.temperature_c.toFixed(1));
    setValue("card-crop",     stats.dominant_crop);

    const cropCard = document.getElementById("card-crop");
    const foot = cropCard.querySelector("[data-foot]");
    if (foot) {
      foot.textContent = `${stats.district} · ${stats.area_ha} ha · ${stats.nearest_water} ${stats.distance_to_water_km.toFixed(1)} km`;
    }

    // sparklines
    if (stats.history) {
      Object.entries(stats.history).forEach(([k, arr]) => {
        if (charts[k]) {
          charts[k].data.datasets[0].data = arr;
          charts[k].update();
        }
      });
    }
  }

  function setValue(cardId, value, cls) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const v = card.querySelector("[data-value]");
    if (v) v.textContent = value;
    const tag = card.querySelector("[data-class]");
    if (tag && cls != null) {
      tag.textContent = cls;
      tag.className = `sc-tag ${cls}`;
    }
  }

  window.FalakStats = { update };
})();
