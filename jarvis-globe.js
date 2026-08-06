/* =============================================================
   Today's AI Core: a rotating holographic Earth, replacing the flat
   progress ring — visually only. The ring stays in the DOM and IS the
   fallback: if WebGL is unsupported, prefers-reduced-motion is set, or
   the Three.js CDN import fails for any reason (offline, blocked, CDN
   down), this module simply never mounts and the existing ring renders
   exactly as it always has. No score logic lives here — index.html's
   renderTodayScore() still owns the number/tier/breakdown text; this
   only paints the visual behind it and exposes window.__jarvisGlobePulse
   for it to call on each update instead of an instant, silent change.
   ============================================================= */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  const mount = document.getElementById('scoreRing');
  if (!mount) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let canvas;
  try {
    canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return;
  } catch (e) { return; }

  import('https://unpkg.com/three@0.160.0/build/three.module.js')
    .then(THREE => initGlobe(THREE))
    .catch(() => { /* CDN unreachable or blocked — the existing ring stays as-is. */ });

  function initGlobe(THREE) {
    const size = mount.clientWidth || 166;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    canvas.setAttribute('aria-hidden', 'true');
    mount.insertBefore(canvas, mount.firstChild);
    mount.classList.add('has-globe');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0.15, 3.1);

    const hudCyan = 0x22d3f5;
    const amber = 0xffb84d;

    // Base sphere: dim solid fill so the wireframe reads as a surface, not
    // just floating lines.
    const globeGroup = new THREE.Group();
    scene.add(globeGroup);

    const solid = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x03141c, transparent: true, opacity: 0.55 })
    );
    globeGroup.add(solid);

    const wireframe = new THREE.Mesh(
      new THREE.SphereGeometry(1.001, 24, 16),
      new THREE.MeshBasicMaterial({ color: hudCyan, wireframe: true, transparent: true, opacity: 0.28 })
    );
    globeGroup.add(wireframe);

    // "City lights" — a scattered point cloud biased toward a handful of
    // dense clusters so it reads as populated regions, not uniform noise.
    const LIGHT_COUNT = 260;
    const lightPositions = new Float32Array(LIGHT_COUNT * 3);
    const clusters = 6;
    const clusterCenters = Array.from({ length: clusters }, () => randomOnSphere());
    for (let i = 0; i < LIGHT_COUNT; i++) {
      const center = clusterCenters[i % clusters];
      const jitter = randomOnSphere();
      const blend = 0.82;
      const v = new THREE.Vector3(
        center.x * blend + jitter.x * (1 - blend),
        center.y * blend + jitter.y * (1 - blend),
        center.z * blend + jitter.z * (1 - blend)
      ).normalize().multiplyScalar(1.005);
      lightPositions[i * 3] = v.x; lightPositions[i * 3 + 1] = v.y; lightPositions[i * 3 + 2] = v.z;
    }
    const lightsGeo = new THREE.BufferGeometry();
    lightsGeo.setAttribute('position', new THREE.BufferAttribute(lightPositions, 3));
    const lights = new THREE.Points(lightsGeo, new THREE.PointsMaterial({ color: hudCyan, size: 0.018, transparent: true, opacity: 0.9 }));
    globeGroup.add(lights);

    // One amber marker — a stand-in "priority signal" node. Its intensity
    // is driven by real alert count (see updateAlertState below), not
    // decorative-only: quiet cyan when nothing needs attention, amber once
    // something does.
    const markerGeo = new THREE.SphereGeometry(0.028, 12, 12);
    const markerMat = new THREE.MeshBasicMaterial({ color: hudCyan, transparent: true, opacity: 0.85 });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    const markerPos = randomOnSphere();
    marker.position.copy(markerPos).multiplyScalar(1.02);
    globeGroup.add(marker);

    function orbitalRing(radius, tiltX, tiltZ, opacity) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius - 0.006, radius + 0.006, 96),
        new THREE.MeshBasicMaterial({ color: hudCyan, transparent: true, opacity, side: THREE.DoubleSide })
      );
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      g.add(dot);
      g.rotation.x = tiltX; g.rotation.z = tiltZ;
      scene.add(g);
      return { group: g, dot, radius };
    }
    const ringA = orbitalRing(1.45, 0.35, 0.1, 0.22);
    const ringB = orbitalRing(1.7, -0.22, 0.5, 0.14);

    function randomOnSphere() {
      const u = Math.random(), v = Math.random();
      const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
      return new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));
    }

    // A thin glow band that sweeps top-to-bottom across the globe every
    // ~9s — the "periodic scanline crossing the Earth" from the spec.
    const scan = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 0.05),
      new THREE.MeshBasicMaterial({ color: hudCyan, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    scene.add(scan);

    let alertLevel = 0; // 0..1, driven by real alert count
    window.__jarvisGlobeSetAlertLevel = function (count) {
      alertLevel = count > 0 ? Math.min(1, 0.4 + count * 0.2) : 0;
    };

    let pulseStart = null;
    window.__jarvisGlobePulse = function () {
      pulseStart = clock.getElapsedTime();
    };

    const clock = new THREE.Clock();
    let raf = null;
    const SCAN_PERIOD = 9;
    const ROTATE_PERIOD = 26; // seconds per revolution — within the 20-30s spec band.
    const RING_PERIOD_A = 10; // within the 8-12s spec band.
    const RING_PERIOD_B = 8.4;

    function animate() {
      raf = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();

      globeGroup.rotation.y = (elapsed / ROTATE_PERIOD) * Math.PI * 2;

      ringA.group.rotation.y = (elapsed / RING_PERIOD_A) * Math.PI * 2;
      ringB.group.rotation.y = -(elapsed / RING_PERIOD_B) * Math.PI * 2;
      positionOnRing(ringA);
      positionOnRing(ringB);

      const scanPhase = (elapsed % SCAN_PERIOD) / SCAN_PERIOD;
      if (scanPhase < 0.35) {
        const local = scanPhase / 0.35;
        scan.position.y = 1.1 - local * 2.2;
        scan.material.opacity = Math.sin(local * Math.PI) * 0.35;
      } else {
        scan.material.opacity = 0;
      }

      markerMat.color.set(alertLevel > 0 ? amber : hudCyan);
      markerMat.opacity = 0.6 + Math.sin(elapsed * 2) * 0.15 * (alertLevel > 0 ? 1.6 : 1);

      if (pulseStart != null) {
        const p = elapsed - pulseStart;
        if (p > 1.1) { pulseStart = null; globeGroup.scale.setScalar(1); }
        else {
          const s = 1 + Math.sin((p / 1.1) * Math.PI) * 0.045;
          globeGroup.scale.setScalar(s);
        }
      }

      renderer.render(scene, camera);
    }
    function positionOnRing(r) {
      const t = clock.getElapsedTime() / (r === ringA ? RING_PERIOD_A : RING_PERIOD_B);
      const a = t * Math.PI * 2;
      r.dot.position.set(Math.cos(a) * r.radius, 0, Math.sin(a) * r.radius);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = null; }
      else if (!raf) animate();
    });
    window.addEventListener('resize', () => {
      const s = mount.clientWidth || 166;
      renderer.setSize(s, s, false);
    });

    animate();
  }
})();
