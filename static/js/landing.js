/* ════════════════════════════════════════════════════════════════
   Landing hero — animated satellite-grid backdrop
   ════════════════════════════════════════════════════════════════ */
(() => {
  const canvas = document.getElementById("heroCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  let w, h, dpr;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  // Grid cells with NDVI-style colors for the hero
  const cells = [];
  const CELL_SIZE = 56;
  function buildGrid() {
    cells.length = 0;
    const cols = Math.ceil(w / CELL_SIZE) + 2;
    const rows = Math.ceil(h / CELL_SIZE) + 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Smooth pseudo-NDVI patches via sin/cos
        const cx = c / cols, ry = r / rows;
        const v = 0.5 + 0.4 * Math.sin(cx * 6.0 + ry * 3.5) * Math.cos(ry * 4.5 - cx * 2.2)
                      + 0.2 * Math.sin(cx * 14.0) * Math.cos(ry * 11.0);
        cells.push({
          x: c * CELL_SIZE - CELL_SIZE,
          y: r * CELL_SIZE - CELL_SIZE,
          v: Math.max(0, Math.min(1, v)),
          phase: Math.random() * Math.PI * 2,
        });
      }
    }
  }
  buildGrid();
  window.addEventListener("resize", buildGrid);

  function scoreColor(v) {
    // green → yellow → red gradient (high v = green/healthy)
    if (v > 0.7) return [34, 197, 94];
    if (v > 0.55) return [132, 204, 22];
    if (v > 0.4) return [250, 204, 21];
    if (v > 0.25) return [249, 115, 22];
    return [185, 28, 28];
  }

  // Satellite dot
  const sat = { x: 0, y: 0, t: 0 };

  function draw(t) {
    ctx.clearRect(0, 0, w, h);

    // Background gradient
    const bg = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h));
    bg.addColorStop(0, "rgba(10,14,23,0.0)");
    bg.addColorStop(1, "rgba(7,9,15,1)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Cells
    for (const cell of cells) {
      const breathe = 0.5 + 0.5 * Math.sin(cell.phase + t * 0.0006);
      const alpha = 0.06 + 0.08 * breathe * cell.v;
      const [r, g, b] = scoreColor(cell.v);
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(cell.x + 1, cell.y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    }

    // Grid lines
    ctx.strokeStyle = "rgba(76, 183, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -CELL_SIZE; x < w + CELL_SIZE; x += CELL_SIZE) {
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    for (let y = -CELL_SIZE; y < h + CELL_SIZE; y += CELL_SIZE) {
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();

    // Orbiting satellite scan
    sat.t = t * 0.0004;
    const cx = w / 2, cy = h * 0.45;
    const rx = w * 0.45, ry = h * 0.35;
    sat.x = cx + Math.cos(sat.t) * rx;
    sat.y = cy + Math.sin(sat.t) * ry;

    // scan cone
    const grad = ctx.createRadialGradient(sat.x, sat.y, 0, sat.x, sat.y, 220);
    grad.addColorStop(0, "rgba(76,183,255,0.22)");
    grad.addColorStop(1, "rgba(76,183,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sat.x, sat.y, 220, 0, Math.PI * 2);
    ctx.fill();

    // satellite body
    ctx.fillStyle = "#4cb7ff";
    ctx.beginPath();
    ctx.arc(sat.x, sat.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "rgba(76,183,255,0.9)";
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(sat.x, sat.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
