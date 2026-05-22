/* ════════════════════════════════════════════════════════════════
   Landing — quiet motion.
   1. Hero cascade on load (eyebrow → headline → lead → CTAs → meta)
   2. Hairline rules draw in on scroll (scaleX 0→1)
   3. Cards / figures fade up slightly on intersection
   No animation on prefers-reduced-motion.
   ════════════════════════════════════════════════════════════════ */

(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── 1. Hero cascade ─────────────────────────────────────────────
  const heroChain = [
    document.querySelector(".hero .eyebrow"),
    document.querySelector(".hero-headline"),
    document.querySelector(".hero .lead"),
    document.querySelector(".hero .cta-row"),
    document.querySelector(".hero-meta"),
  ].filter(Boolean);

  if (!reduce) {
    heroChain.forEach((el, i) => {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      el.style.transition = "opacity 700ms cubic-bezier(0.16, 1, 0.3, 1), transform 700ms cubic-bezier(0.16, 1, 0.3, 1)";
      el.style.transitionDelay = `${80 + i * 90}ms`;
    });
    requestAnimationFrame(() => {
      heroChain.forEach((el) => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });
    });
  }

  // ── 2. Hairline rules draw in on intersection ───────────────────
  if (!reduce && "IntersectionObserver" in window) {
    document.querySelectorAll(".rule").forEach((r) => {
      r.style.transform = "scaleX(0)";
      r.style.transformOrigin = "left";
      r.style.transition = "transform 900ms cubic-bezier(0.22, 1, 0.36, 1)";
    });

    const ruleIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.style.transform = "scaleX(1)";
        ruleIO.unobserve(e.target);
      });
    }, { threshold: 0.5 });
    document.querySelectorAll(".rule").forEach((r) => ruleIO.observe(r));
  }

  // ── 3. Cards / figures fade up on intersect ─────────────────────
  const fadeTargets = document.querySelectorAll(".card, .figure, .steps li, .pt-row, .timeline-pill");
  if (reduce || !("IntersectionObserver" in window)) {
    fadeTargets.forEach((el) => { el.style.opacity = 1; });
  } else {
    fadeTargets.forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "translateY(10px)";
      el.style.transition = "opacity 600ms cubic-bezier(0.16, 1, 0.3, 1), transform 600ms cubic-bezier(0.16, 1, 0.3, 1)";
    });
    let i = 0;
    const fadeIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.style.transitionDelay = `${(i++ % 4) * 60}ms`;
        e.target.style.opacity = "1";
        e.target.style.transform = "translateY(0)";
        fadeIO.unobserve(e.target);
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -8% 0px" });
    fadeTargets.forEach((el) => fadeIO.observe(el));
  }
})();
