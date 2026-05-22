/* ════════════════════════════════════════════════════════════════
   Bottom stats strip + sparkline charts (no IRI, no Crop)
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
        scales: { x: { display: false }, y: { display: false, beginAtZero: false } },
      },
    });
  }

  function initSparks() {
    const colorByKey = {
      ndvi:        "#22c55e",
      moisture:    "#4cb7ff",
      rainfall:    "#facc15",
      temperature: "#ef4444",
      et:          "#f97316",
    };
    document.querySelectorAll(".sc-spark").forEach((canvas) => {
      const key = canvas.dataset.spark;
      charts[key] = makeSpark(canvas, colorByKey[key] || "#4cb7ff");
    });
  }
  initSparks();

  const STRESS_LABEL = { HIGH: "YUQORI", MEDIUM: "O'RTACHA", LOW: "PAST" };

  function update(stats) {
    // Stress class card (textual + 3-segment pill keeps the strip's visual rhythm)
    setValue("card-stress", STRESS_LABEL[stats.stress_class] || stats.stress_class, stats.stress_class);
    const pill = document.getElementById("stressPill");
    if (pill) pill.setAttribute("data-active", stats.stress_class);
    setFoot("card-stress",
      `${stats.district} · ${stats.area_ha} ga · ${
        stats.inspection_window_h ? stats.inspection_window_h + " soat ichida" : "tezkor harakat shart emas"
      }`
    );

    setValue("card-ndvi",     stats.ndvi.toFixed(2));
    setValue("card-moisture", stats.soil_moisture_pct.toFixed(1));
    setValue("card-rain",     stats.rainfall_30d_mm.toFixed(1));
    setValue("card-temp",     stats.temperature_c.toFixed(1));
    setValue("card-et",       stats.et_mm_day.toFixed(2));

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
      tag.textContent = STRESS_LABEL[cls] || cls;
      tag.className = `sc-tag ${cls}`;
    }
  }
  function setFoot(cardId, text) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const f = card.querySelector("[data-foot]");
    if (f) f.textContent = text;
  }

  window.FalakStats = { update };
})();
