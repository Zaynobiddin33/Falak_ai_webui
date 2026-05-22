/* ════════════════════════════════════════════════════════════════
   Dashboard wiring · metric toggle, layers, drawers, priority list
   ════════════════════════════════════════════════════════════════ */

(function () {
  const F = window.FALAK;

  // ─── Real model summary ─────────────────────────────────────
  const modelStatus = document.getElementById("modelStatus");
  if (modelStatus && F.apiSuvradarSummary) {
    fetch(F.apiSuvradarSummary)
      .then((r) => r.json())
      .then((summary) => {
        if (!summary || summary.status === "missing") {
          modelStatus.innerHTML = `<div class="ms-row"><span>Kesh</span><b>Yo'q</b></div>`;
          return;
        }
        const h7 = summary.h7?.metrics || {};
        const h14 = summary.h14?.metrics || {};
        modelStatus.innerHTML = `
          <div class="ms-row"><span>Kataklar</span><b>${Number(summary.full_fergana_cells || 0).toLocaleString()}</b></div>
          <div class="ms-row"><span>7 kun MAE</span><b>${h7.mae_test ?? "—"}</b></div>
          <div class="ms-row"><span>7 kun ±5</span><b>${h7.within5_test_percent ?? "—"}%</b></div>
          <div class="ms-row"><span>14 kun MAE</span><b>${h14.mae_test ?? "—"}</b></div>
          <div class="ms-row"><span>14 kun ±5</span><b>${h14.within5_test_percent ?? "—"}%</b></div>
          <p class="ms-note">Jonli inference · 1 km tarmoq · 2018-2025 growing-season model</p>
        `;
      })
      .catch((e) => {
        modelStatus.innerHTML = `<div class="ms-row"><span>Kesh</span><b>Xato</b></div>`;
        console.error(e);
      });
  }

  // ─── Metric toggle ───────────────────────────────────────────
  document.querySelectorAll("#metricToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#metricToggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      window.FalakMap.setMetric(btn.dataset.metric);
    });
  });

  // ─── Background toggle ───────────────────────────────────────
  document.querySelectorAll("#bgToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#bgToggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      window.FalakMap.setBackground(btn.dataset.bg);
    });
  });

  // ─── Grid opacity ────────────────────────────────────────────
  const op = document.getElementById("opacityRange");
  op.addEventListener("input", () => window.FalakMap.setOpacity(parseInt(op.value)));

  // ─── Priority list ───────────────────────────────────────────
  const listEl = document.getElementById("priorityList");
  const RISK_UZ = { HIGH: "YUQORI", MEDIUM: "O'RTACHA", LOW: "PAST" };
  fetch(F.apiPriority)
    .then((r) => r.json())
    .then(({ districts }) => {
      if (!districts || !districts.length) {
        listEl.textContent = "Ma'lumot yo'q";
        return;
      }
      listEl.innerHTML = districts.slice(0, 8).map((d) => `
        <div class="pl-row" data-district="${d.district}">
          <span class="pl-name">${d.district}</span>
          <span class="pl-risk pl-risk-${d.risk}">${RISK_UZ[d.risk] || d.risk}</span>
          <span class="pl-ha">${d.hectares_at_risk.toLocaleString()} ga</span>
        </div>
      `).join("");
      listEl.querySelectorAll(".pl-row").forEach((row) => {
        row.addEventListener("click", () => {
          window.FalakMap.focusDistrict(row.dataset.district);
          closeMobilePanels();
        });
      });
    })
    .catch((e) => { listEl.textContent = "Yuklab bo'lmadi."; console.error(e); });

  // ─── Mobile drawers ──────────────────────────────────────────
  const backdrop = document.getElementById("dashBackdrop");
  const layersPanel = document.getElementById("layersPanel");
  const chatPanel = document.getElementById("chatPanel");

  function openLayers()  { layersPanel.classList.add("open"); backdrop.style.display = "block"; }
  function openChat()    { chatPanel.classList.add("open");   backdrop.style.display = "block"; }
  function closeMobilePanels() {
    layersPanel.classList.remove("open");
    chatPanel.classList.remove("open");
    backdrop.style.display = "none";
  }

  document.getElementById("layerToggleMobile").addEventListener("click", openLayers);
  document.getElementById("chatToggleMobile").addEventListener("click", openChat);
  document.getElementById("layersClose").addEventListener("click", closeMobilePanels);
  document.getElementById("chatClose").addEventListener("click", closeMobilePanels);
  backdrop.addEventListener("click", closeMobilePanels);

  // close drawers when resizing back to desktop
  window.addEventListener("resize", () => {
    if (window.innerWidth > 1080) closeMobilePanels();
  });
})();
