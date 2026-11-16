/*
 * ABM 3D medallion — a layered, real-geometry rebuild of the Akademi Basket Medan logo.
 *
 * Layers (back → front), so tilting the coin produces genuine parallax:
 *   disc (z 0) → orange ring → extruded skyline + water tower → basketball (sphere) → floating wordmark
 *
 * Motion (Emil Kowalski rules applied):
 *   - Pointer tilt runs through a spring, not a direct mapping: it has momentum and stays interruptible.
 *   - Click / Enter flips the coin 360° on a slightly under-damped spring; clicking mid-flip retargets.
 *   - Idle sway is slow and small. Touch devices get idle + tap-to-flip only (no fake hover).
 *   - prefers-reduced-motion: one static, slightly angled frame. No idle, no flip.
 *   - Rendering pauses when the hero is off-screen or the tab is hidden.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const ORANGE = 0xf07822;
const INK = 0x0a0a0b;

export async function mountLogo3D(host) {
  const canvas = host.querySelector('canvas');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    return false; // No WebGL: the static <img> fallback stays visible.
  }

  // The wordmark is drawn with the page font, so wait for it (with a timeout so a slow font never blocks the logo).
  await Promise.race([
    Promise.all([
      document.fonts.load('italic 800 200px "Barlow Condensed"'),
      document.fonts.load('italic 700 200px "Barlow Condensed"'),
    ]),
    new Promise((r) => setTimeout(r, 1500)),
  ]);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral keeps the brand orange's hue; ACES pushed it toward peach.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.95;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 4.6);

  // Lights: soft key from top-left, warm orange rim from behind-right for the "arena light" feel.
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-2.5, 3, 4);
  scene.add(key);
  const rim = new THREE.PointLight(0xff8a33, 14, 8, 2);
  rim.position.set(2.2, 1.2, -1.2);
  scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  // "Flashlight" that follows the cursor: highlights slide across the metal as you move.
  const cursorLight = new THREE.PointLight(0xffe6c8, 6, 6, 1.6);
  cursorLight.position.set(0.6, 0.6, 1.8);
  scene.add(cursorLight);

  const coin = buildMedallion();
  const pivot = new THREE.Group(); // pivot = tilt/flip/scale, coin = float
  pivot.add(coin.group);
  pivot.scale.setScalar(0.82);
  scene.add(pivot);

  const shadow = buildShadow();
  scene.add(shadow);
  const sparks = buildSparks(window.matchMedia('(max-width: 860px)').matches ? 140 : 260);
  scene.add(sparks.points);

  const hero = host.closest('section') || document.body;
  let heroH = 1; // cached so the frame loop never forces layout

  // ---------- sizing ----------
  function resize() {
    heroH = Math.max(hero.offsetHeight, 1);
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Keep the whole coin in frame whatever the aspect ratio.
    const fitR = 1.3;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const distV = fitR / Math.tan(vFov / 2);
    const distH = fitR / (Math.tan(vFov / 2) * camera.aspect);
    camera.position.z = Math.max(distV, distH);
    camera.updateProjectionMatrix();
    if (!running) renderer.render(scene, camera);
  }
  new ResizeObserver(resize).observe(host);

  // ---------- motion state ----------
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const s = {
    rx: 0.18, vx: 0,          // tilt X
    ry: -0.85, vy: 0,         // tilt Y (enters from an angle and springs home)
    flip: -Math.PI * 2, vflip: 0, flipTarget: 0, // entrance: one full spin into place
    sc: 0.82, vsc: 0,         // entrance scale
    lx: 0.6, vlx: 0, ly: 0.6, vly: 0, // cursor light
    px: 0, py: 0,             // pointer, -1..1
    hasPointer: false,
  };

  function spring(x, v, target, stiffness, dampingRatio, dt) {
    const c = 2 * Math.sqrt(stiffness) * dampingRatio;
    v += (stiffness * (target - x) - c * v) * dt;
    return [x + v * dt, v];
  }

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !finePointer.matches) return;
    s.px = (e.clientX / window.innerWidth) * 2 - 1;
    s.py = (e.clientY / window.innerHeight) * 2 - 1;
    s.hasPointer = true;
  }, { passive: true });

  function flip() {
    if (reduce.matches || paused) return;
    s.flipTarget += Math.PI * 2;
    start();
  }
  host.addEventListener('click', flip);

  // Bass hit from the dot-matrix mic analyser: kick the scale spring (it settles on its own).
  window.addEventListener('abm:beat', (e) => {
    if (reduce.matches || paused) return;
    s.vsc += 1.6 * (e.detail || 0.5);
    start();
  });

  // ---------- loop ----------
  let running = false;
  let visible = true;
  let paused = false; // user-controlled "Jeda gerak" toggle
  let last = 0;
  const clock = new THREE.Clock();

  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000 || 0.016, 1 / 30);
    last = now;
    const t = clock.getElapsedTime();

    // Scroll: as the hero leaves, the coin turns away and settles back slightly.
    const scroll = Math.min(Math.max(window.scrollY / heroH, 0), 1);

    const idleY = Math.sin(t * 0.55) * 0.22;
    const idleX = Math.sin(t * 0.8 + 1.3) * 0.06;
    const targetY = s.px * 0.5 + idleY + scroll * 1.6;
    const targetX = s.py * 0.32 + idleX + 0.06 - scroll * 0.35;
    const targetScale = 1 - scroll * 0.12;

    // Light: follows the cursor on desktop, slowly orbits on touch.
    const lightX = s.hasPointer ? s.px * 1.7 : Math.cos(t * 0.5) * 1.3;
    const lightY = s.hasPointer ? -s.py * 1.3 : Math.sin(t * 0.7) * 0.8 + 0.3;

    // Two half-steps keep the integration stable at low frame rates.
    for (let i = 0; i < 2; i++) {
      const h = dt / 2;
      [s.ry, s.vy] = spring(s.ry, s.vy, targetY, 38, 0.62, h);
      [s.rx, s.vx] = spring(s.rx, s.vx, targetX, 38, 0.62, h);
      [s.flip, s.vflip] = spring(s.flip, s.vflip, s.flipTarget, 22, 0.6, h);
      [s.sc, s.vsc] = spring(s.sc, s.vsc, targetScale, 60, 0.55, h);
      [s.lx, s.vlx] = spring(s.lx, s.vlx, lightX, 30, 0.9, h);
      [s.ly, s.vly] = spring(s.ly, s.vly, lightY, 30, 0.9, h);
    }

    pivot.rotation.set(s.rx, s.ry + s.flip, 0);
    pivot.scale.setScalar(s.sc);
    const float = Math.sin(t * 1.1) * 0.035;
    coin.group.position.y = float;
    coin.ball.rotation.y += dt * 0.35;
    coin.ball.rotation.x = Math.sin(t * 0.4) * 0.15;
    cursorLight.position.set(s.lx, s.ly, 1.8);

    // Shadow tightens and darkens as the coin dips toward it.
    const k = 1 - (float + 0.035) * 3;
    shadow.scale.set(s.sc * (0.9 + k * 0.1), 1, 1);
    shadow.material.opacity = 0.55 + k * 0.15;

    sparks.update(dt, t);

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  function start() {
    if (running || paused || reduce.matches || !visible || document.hidden) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }
  function stop() { running = false; }

  function renderStatic() {
    pivot.rotation.set(0.1, -0.32, 0);
    pivot.scale.setScalar(1);
    coin.group.position.y = 0;
    sparks.points.visible = false;
    renderer.render(scene, camera);
  }

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    visible ? start() : stop();
  }).observe(host);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduce.addEventListener('change', () => { if (reduce.matches) { stop(); renderStatic(); } else start(); });

  resize();
  if (reduce.matches) renderStatic(); else start();

  // Controller for the page's pause toggle. Pausing freezes the current frame where it is.
  return {
    setPaused(value) {
      paused = value;
      if (paused) stop(); else start();
    },
  };
}

/* =====================================================================
 * Geometry
 * ===================================================================== */
function buildMedallion() {
  const group = new THREE.Group();

  const orangeMetal = new THREE.MeshStandardMaterial({ color: ORANGE, metalness: 0.55, roughness: 0.32 });
  const orangeMatte = new THREE.MeshStandardMaterial({ color: ORANGE, metalness: 0.1, roughness: 0.6 });

  // --- Disc: orange metallic edge, black faces (front has a soft vignette, back carries the monogram)
  const discDepth = 0.14;
  const capMat = new THREE.MeshStandardMaterial({ color: INK, metalness: 0.2, roughness: 0.7 });
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, discDepth, 160, 1).rotateX(Math.PI / 2),
    [orangeMetal, capMat, capMat],
  );
  group.add(disc);
  const front = discDepth / 2;

  // Faces are separate circles: cylinder cap UVs are rotated 90°, CircleGeometry maps upright.
  const faceGeo = new THREE.CircleGeometry(0.999, 160);
  const faceFront = new THREE.Mesh(faceGeo, new THREE.MeshStandardMaterial({ map: faceTexture(), metalness: 0.2, roughness: 0.7 }));
  faceFront.position.z = front + 0.001;
  group.add(faceFront);
  const faceBack = new THREE.Mesh(faceGeo, new THREE.MeshStandardMaterial({ map: backTexture(), metalness: 0.2, roughness: 0.7 }));
  faceBack.position.z = -front - 0.001;
  faceBack.rotation.y = Math.PI; // reads correctly (not mirrored) when the coin is turned around
  group.add(faceBack);

  // Rounded lip on both faces so the edge catches light like a struck coin.
  for (const z of [front, -front]) {
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.985, 0.026, 16, 200), orangeMetal);
    lip.position.z = z;
    group.add(lip);
  }

  // --- Inner ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.89, 0.016, 12, 200), orangeMetal);
  ring.position.z = front + 0.006;
  group.add(ring);

  // --- Skyline (extruded stepped silhouette)
  const base = -0.12;
  const buildings = [
    // [x0, x1, top]
    [-0.68, -0.53, 0.06],
    [-0.53, -0.38, 0.22],
    [-0.38, -0.24, 0.13],
    [-0.24, -0.02, 0.38], // carries the water tower
    [-0.02, 0.12, 0.27],
    [0.12, 0.27, 0.47],
    [0.27, 0.41, 0.2],
    [0.41, 0.55, 0.33],
    [0.55, 0.68, 0.1],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(buildings[0][0], base);
  for (const [x0, x1, top] of buildings) {
    shape.lineTo(x0, top);
    shape.lineTo(x1, top);
  }
  shape.lineTo(buildings.at(-1)[1], base);
  shape.closePath();

  const skyDepth = 0.06;
  const skyline = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: skyDepth, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 2 }),
    orangeMatte,
  );
  skyline.position.z = front;
  group.add(skyline);
  const skyFront = front + skyDepth + 0.009;

  // Windows: dark grid, a few warm lit ones (instanced = 2 draw calls total).
  const win = new THREE.PlaneGeometry(0.026, 0.036);
  const dark = [];
  const lit = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [x0, x1, top] of buildings) {
    const cols = Math.max(1, Math.floor((x1 - x0 - 0.03) / 0.048));
    const span = (cols - 1) * 0.048;
    const cx = (x0 + x1) / 2;
    for (let y = base + 0.05; y < top - 0.045; y += 0.064) {
      for (let c = 0; c < cols; c++) {
        const p = new THREE.Vector3(cx - span / 2 + c * 0.048, y, skyFront + 0.001);
        (rand() < 0.14 ? lit : dark).push(p);
      }
    }
  }
  const addWindows = (list, material) => {
    const mesh = new THREE.InstancedMesh(win, material, list.length);
    const m = new THREE.Matrix4();
    list.forEach((p, i) => mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    group.add(mesh);
  };
  addWindows(dark, new THREE.MeshBasicMaterial({ color: INK }));
  addWindows(lit, new THREE.MeshBasicMaterial({ color: 0xffe2b8 }));

  // --- Water tower (Medan landmark silhouette) on the tower building
  const tower = new THREE.Group();
  const tx = -0.13;
  const roof = 0.38;
  const legGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.17, 6);
  for (const dx of [-0.055, 0.055]) {
    const leg = new THREE.Mesh(legGeo, orangeMatte);
    leg.position.set(tx + dx, roof + 0.085, front + 0.03);
    tower.add(leg);
  }
  const brace = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.008, 0.008), orangeMatte);
  brace.position.set(tx, roof + 0.08, front + 0.03);
  tower.add(brace);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.13, 32), orangeMetal);
  tank.position.set(tx, roof + 0.235, front + 0.03);
  tower.add(tank);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.095, 0.07, 32), orangeMetal);
  cap.position.set(tx, roof + 0.335, front + 0.03);
  tower.add(cap);
  group.add(tower);

  // --- Basketball: a real sphere, squashed in depth so it reads as relief, slowly spinning.
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.27, 64, 48),
    new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.62, metalness: 0.05 }),
  );
  const ballHolder = new THREE.Group();
  ballHolder.position.set(0, -0.6, front + 0.02);
  ballHolder.scale.set(1, 1, 0.62);
  ballHolder.add(ball);
  group.add(ballHolder);

  // --- Wordmark: floats in front of everything → strongest parallax layer.
  const wordTex = wordmarkTexture();
  const wordW = 1.72;
  const wordH = (wordW * wordTex.image.height) / wordTex.image.width;
  const word = new THREE.Mesh(
    new THREE.PlaneGeometry(wordW, wordH),
    new THREE.MeshBasicMaterial({ map: wordTex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  word.position.set(0, -0.115, front + 0.2);
  word.renderOrder = 2;
  group.add(word);

  return { group, ball };
}

/* Soft contact shadow under the coin (a blurred ellipse, cheaper than real shadow maps). */
function buildShadow() {
  const tex = canvasTexture(256, 64, (ctx, w, h) => {
    // Draw a circle, squashed vertically into an ellipse.
    ctx.translate(w / 2, h / 2);
    ctx.scale(1, h / w);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.9)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-w / 2, -w / 2, w, w);
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 0.32),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.6 }),
  );
  mesh.position.set(0, -1.2, -0.3);
  mesh.renderOrder = -1;
  return mesh;
}

/* Embers drifting up through the arena light. World-space, so they don't spin with the coin. */
function buildSparks(count) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  const phase = new Float32Array(count);
  const base = new THREE.Color(0xff8a33);

  const spawn = (i, anywhere) => {
    const a = Math.random() * Math.PI * 2;
    const r = 1.05 + Math.random() * 0.75;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = anywhere ? -1.3 + Math.random() * 2.8 : -1.3;
    pos[i * 3 + 2] = Math.sin(a) * r * 0.6 - 0.2;
    speed[i] = 0.07 + Math.random() * 0.2;
    phase[i] = Math.random() * Math.PI * 2;
    const b = 0.35 + Math.random() * 0.65;
    col[i * 3] = base.r * b;
    col[i * 3 + 1] = base.g * b;
    col[i * 3 + 2] = base.b * b;
  };
  for (let i = 0; i < count; i++) spawn(i, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const dot = canvasTexture(64, 64, (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,220,180,0.8)');
    g.addColorStop(1, 'rgba(255,140,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
  });
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.045, map: dot, vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, toneMapped: false,
  }));

  function update(dt, t) {
    for (let i = 0; i < count; i++) {
      pos[i * 3 + 1] += speed[i] * dt;
      pos[i * 3] += Math.sin(t * 0.8 + phase[i]) * 0.02 * dt;
      if (pos[i * 3 + 1] > 1.5) spawn(i, false);
    }
    geo.attributes.position.needsUpdate = true;
  }
  return { points, update };
}

/* =====================================================================
 * Canvas textures
 * ===================================================================== */
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function faceTexture() {
  return canvasTexture(1024, 1024, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, '#1d1d20');
    g.addColorStop(1, '#060607');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

function backTexture() {
  return canvasTexture(1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#f07822';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.44, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#f07822';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'italic 800 300px "Barlow Condensed", sans-serif';
    ctx.fillText('ABM', w / 2, h * 0.47);
    ctx.font = 'italic 700 70px "Barlow Condensed", sans-serif';
    ctx.fillStyle = '#f4f1ec';
    ctx.fillText('MEDAN', w / 2, h * 0.66);
  });
}

function wordmarkTexture() {
  return canvasTexture(2048, 640, (ctx, w) => {
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';

    const line = (text, size, y, maxW, spacing) => {
      ctx.font = `italic 800 ${size}px "Barlow Condensed", sans-serif`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
      const measured = ctx.measureText(text).width;
      if (measured > maxW) {
        size = Math.floor((size * maxW) / measured);
        ctx.font = `italic 800 ${size}px "Barlow Condensed", sans-serif`;
      }
      const stroke = size * 0.15;
      ctx.lineWidth = stroke * 2;
      ctx.strokeStyle = '#0a0a0b';
      ctx.strokeText(text, w / 2, y);
      ctx.lineWidth = stroke;
      ctx.strokeStyle = '#f07822';
      ctx.strokeText(text, w / 2, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, w / 2, y);
    };

    line('AKADEMI BASKET', 300, 330, 1840, 4);
    line('MEDAN', 170, 545, 900, 14);
  });
}

function ballTexture() {
  // Equirectangular basketball: pebbled orange + 4 classic seams.
  return canvasTexture(1024, 512, (ctx, w, h) => {
    ctx.fillStyle = '#e8711c';
    ctx.fillRect(0, 0, w, h);
    // pebble grain
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,200,150,0.06)';
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    // equator
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    // one great circle through the poles = two vertical lines
    for (const x of [w * 0.25, w * 0.75]) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    // two curved side seams
    for (const [cx, dir] of [[0, 1], [w, -1], [w * 0.5, 1], [w * 0.5, -1]]) {
      ctx.beginPath();
      for (let y = 0; y <= h; y += 4) {
        const lat = (y / h - 0.5) * Math.PI;
        const x = cx + Math.cos(lat) * w * 0.17 * dir;
        y === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
}
