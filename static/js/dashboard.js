/* ════════════════════════════════════════════════════════════════
   Dashboard wiring · metric toggle, layers, drawers, priority list
   ════════════════════════════════════════════════════════════════ */

(function () {
  const F = window.FALAK;

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
