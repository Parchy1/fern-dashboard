/* =============================================================
   Cinematic ambient background — Command Center only.
   Layered Canvas atmosphere: drifting particles, slow orbital arcs with
   occasional traveling energy pulses, soft fog blobs, gentle pointer
   parallax on desktop, and a day/night tint pulled from time-theme.js's
   existing html[data-time-theme] attribute (no new storage, no new state).

   design-system.css's body::before/::after (grid + ambient glow) keep
   running underneath this on every page, including this one — this file
   adds a richer *additional* layer specific to the homepage rather than
   replacing the shared base every page already gets.

   Respects prefers-reduced-motion (skips entirely, leaving the existing
   static CSS backdrop) and pauses the render loop while the tab is
   hidden. Particle count and pointer parallax both scale down on narrow
   viewports.
   ============================================================= */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!document.querySelector('.cc-page')) return; // Command Center only.

  const isNarrow = () => window.innerWidth <= 640;
  const isFinePointer = () => window.matchMedia && window.matchMedia('(pointer: fine)').matches;

  const canvas = document.createElement('canvas');
  canvas.id = 'jarvisBg';
  canvas.setAttribute('aria-hidden', 'true');
  // No negative z-index: body has its own explicit background-color, and a
  // negative z-index here ends up painting behind that (verified — the
  // canvas was drawing correctly but was completely invisible on screen).
  // Since this canvas is inserted as body's first child, plain DOM paint
  // order already puts it behind every other z-index:auto element without
  // needing z-index at all.
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
  document.body.insertBefore(canvas, document.body.firstChild);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = 0, height = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    width = window.innerWidth; height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // ---- Particle field: 3 depth layers, each drifting at its own speed. ----
  function buildParticles() {
    const perLayer = isNarrow() ? 14 : 34;
    const layers = [];
    for (let l = 0; l < 3; l++) {
      const speed = 0.06 + l * 0.05;
      const size = 1.3 + l * 0.9;
      const points = [];
      for (let i = 0; i < perLayer; i++) {
        points.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: size + Math.random() * size,
          drift: (Math.random() * 0.6 + 0.4) * speed * (Math.random() < 0.5 ? -1 : 1),
          twinkle: Math.random() * Math.PI * 2,
        });
      }
      layers.push({ points, speed });
    }
    return layers;
  }
  let particleLayers = buildParticles();

  // ---- Orbital arcs: large slow-rotating ellipses with occasional traveling pulses. ----
  const arcs = [
    { rxRatio: 0.42, ryRatio: 0.24, tilt: -0.18, period: 130, pulse: null, nextPulseAt: 4 },
    { rxRatio: 0.30, ryRatio: 0.30, tilt: 0.32, period: 95, pulse: null, nextPulseAt: 9 },
  ];

  // ---- Soft fog blobs, drifting very slowly. ----
  const fogBlobs = [
    { xr: 0.78, yr: 0.12, radiusRatio: 0.42, driftX: 0.015, driftY: 0.01, phase: 0 },
    { xr: 0.10, yr: 0.85, radiusRatio: 0.36, driftX: -0.012, driftY: -0.014, phase: 2 },
  ];

  function hudColor() {
    const night = document.documentElement.dataset.timeTheme !== 'day';
    return night ? { r: 34, g: 211, b: 245 } : { r: 60, g: 220, b: 255 };
  }

  // ---- Gentle pointer parallax (desktop only), eased toward target. ----
  let targetOffsetX = 0, targetOffsetY = 0, offsetX = 0, offsetY = 0;
  function onPointerMove(e) {
    if (!isFinePointer() || isNarrow()) return;
    const nx = (e.clientX / width) * 2 - 1;
    const ny = (e.clientY / height) * 2 - 1;
    targetOffsetX = nx * 10;
    targetOffsetY = ny * 8;
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  let t = 0;
  let running = true;
  let rafId = null;

  function draw() {
    t += 1 / 60;
    offsetX += (targetOffsetX - offsetX) * 0.04;
    offsetY += (targetOffsetY - offsetY) * 0.04;
    const color = hudColor();
    const rgb = color.r + ',' + color.g + ',' + color.b;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(offsetX, offsetY);

    // Technical grid — a real drawn layer (not just the near-invisible CSS
    // background line), so the "faint technical grid" from the brief
    // actually reads as present rather than being a rounding error.
    const gridSize = 64;
    ctx.strokeStyle = 'rgba(' + rgb + ',0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = -gridSize; gx < width + gridSize; gx += gridSize) { ctx.moveTo(gx, 0); ctx.lineTo(gx, height); }
    for (let gy = -gridSize; gy < height + gridSize; gy += gridSize) { ctx.moveTo(0, gy); ctx.lineTo(width, gy); }
    ctx.stroke();

    // Fog blobs
    fogBlobs.forEach(b => {
      const cx = width * b.xr + Math.sin(t * b.driftX + b.phase) * width * 0.03;
      const cy = height * b.yr + Math.cos(t * b.driftY + b.phase) * height * 0.03;
      const r = Math.min(width, height) * b.radiusRatio;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(' + rgb + ',0.16)');
      g.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    });

    // Orbital arcs + traveling pulses
    const cx = width / 2, cy = height * 0.38;
    arcs.forEach(arc => {
      const rx = width * arc.rxRatio, ry = height * arc.ryRatio;
      const rotation = arc.tilt + (t / arc.period) * Math.PI * 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.strokeStyle = 'rgba(' + rgb + ',0.38)';
      ctx.lineWidth = 1.4;
      ctx.shadowColor = 'rgba(' + rgb + ',0.6)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (t >= arc.nextPulseAt && arc.pulse === null) {
        arc.pulse = { start: t, duration: 2.6 + Math.random() * 1.2 };
      }
      if (arc.pulse) {
        const progress = (t - arc.pulse.start) / arc.pulse.duration;
        if (progress >= 1) {
          arc.pulse = null;
          arc.nextPulseAt = t + 6 + Math.random() * 6;
        } else {
          const angle = progress * Math.PI * 2;
          const px = Math.cos(angle) * rx, py = Math.sin(angle) * ry;
          const fade = Math.sin(progress * Math.PI);
          ctx.shadowColor = 'rgba(' + rgb + ',0.9)';
          ctx.shadowBlur = 10;
          ctx.fillStyle = 'rgba(' + rgb + ',' + (0.95 * fade) + ')';
          ctx.beginPath(); ctx.arc(px, py, 3.2, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(' + rgb + ',' + (0.3 * fade) + ')';
          ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
    });

    // Particle layers
    particleLayers.forEach(layer => {
      layer.points.forEach(p => {
        p.x += layer.speed * (p.drift > 0 ? 0.15 : -0.15);
        if (p.x < -5) p.x = width + 5;
        if (p.x > width + 5) p.x = -5;
        const twinkle = 0.5 + 0.5 * Math.sin(t * 0.6 + p.twinkle);
        ctx.fillStyle = 'rgba(' + rgb + ',' + (0.25 + twinkle * 0.65) + ')';
        ctx.shadowColor = 'rgba(' + rgb + ',0.8)';
        ctx.shadowBlur = p.r * 2.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      });
    });

    ctx.restore();
    if (running) rafId = requestAnimationFrame(draw);
  }

  function start() { if (!rafId) { running = true; rafId = requestAnimationFrame(draw); } }
  function stop() { running = false; if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  document.addEventListener('visibilitychange', () => { document.hidden ? stop() : start(); });
  window.addEventListener('resize', () => { particleLayers = buildParticles(); });

  start();
})();
