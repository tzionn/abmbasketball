/*
 * Sound-reactive dot-matrix background.
 *   idle      → slow diagonal wave + dots light up around the cursor
 *   mic on    → columns become an orange spectrum (low notes left → high right);
 *               bass hits fire a ripple from the 3D logo and dispatch `abm:beat`
 * Audio is analysed locally (Web Audio AnalyserNode). Nothing is recorded or sent.
 */

// Pure beat detector: a hit when bass jumps well above its running average.
export function isBeat(bass, avg, now, lastBeat) {
  return bass > 0.32 && bass > avg * 1.35 && now - lastBeat > 180;
}
console.assert(isBeat(0.6, 0.3, 1000, 0) === true, 'beat: clear hit');
console.assert(isBeat(0.6, 0.3, 1000, 900) === false, 'beat: cooldown');
console.assert(isBeat(0.2, 0.1, 1000, 0) === false, 'beat: too quiet');
console.assert(isBeat(0.5, 0.45, 1000, 0) === false, 'beat: not above average');

/* ---------- Shapes: drawn into a 1-pixel-per-dot mask, then dots light where the mask is ---------- */
const SHAPES = {
  ball(g, s) {
    g.beginPath(); g.arc(0, 0, s, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(-s, 0); g.lineTo(s, 0); g.moveTo(0, -s); g.lineTo(0, s); g.stroke();
    g.beginPath(); g.ellipse(-s, 0, s * 0.55, s * 0.95, 0, -Math.PI / 2, Math.PI / 2); g.stroke();
    g.beginPath(); g.ellipse(s, 0, s * 0.55, s * 0.95, 0, Math.PI / 2, Math.PI * 1.5); g.stroke();
  },
  hoop(g, s) {
    g.strokeRect(-s * 0.9, -s, s * 1.8, s * 0.95);
    g.strokeRect(-s * 0.3, -s * 0.55, s * 0.6, s * 0.4);
    g.beginPath(); g.ellipse(0, 0, s * 0.45, s * 0.1, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    for (let i = 0; i <= 4; i++) {
      const x = -s * 0.45 + (i * s * 0.9) / 4;
      g.moveTo(x, 0); g.lineTo(x * 0.55 + (i % 2 ? s * 0.08 : -s * 0.08), s * 0.75);
    }
    g.moveTo(-s * 0.3, s * 0.4); g.lineTo(s * 0.3, s * 0.4);
    g.stroke();
  },
  trophy(g, s) {
    g.beginPath();
    g.moveTo(-s * 0.55, -s * 0.8); g.lineTo(s * 0.55, -s * 0.8);
    g.quadraticCurveTo(s * 0.55, s * 0.05, 0, s * 0.15);
    g.quadraticCurveTo(-s * 0.55, s * 0.05, -s * 0.55, -s * 0.8);
    g.fill();
    g.beginPath(); g.arc(-s * 0.55, -s * 0.5, s * 0.25, Math.PI * 0.5, Math.PI * 1.5); g.stroke();
    g.beginPath(); g.arc(s * 0.55, -s * 0.5, s * 0.25, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
    g.fillRect(-s * 0.08, s * 0.1, s * 0.16, s * 0.45);
    g.fillRect(-s * 0.4, s * 0.55, s * 0.8, s * 0.2);
  },
  court(g, s) {
    g.strokeRect(-s * 1.4, -s * 0.85, s * 2.8, s * 1.7);
    g.beginPath(); g.moveTo(0, -s * 0.85); g.lineTo(0, s * 0.85); g.stroke();
    g.beginPath(); g.arc(0, 0, s * 0.3, 0, Math.PI * 2); g.stroke();
    g.strokeRect(-s * 1.4, -s * 0.3, s * 0.5, s * 0.6);
    g.strokeRect(s * 0.9, -s * 0.3, s * 0.5, s * 0.6);
  },
  star(g, s) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? s * 0.45 : s, a = -Math.PI / 2 + (i * Math.PI) / 5;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.fill();
  },
  bolt(g, s) {
    g.beginPath();
    [[0.2, -1], [-0.55, 0.12], [-0.02, 0.12], [-0.25, 1], [0.55, -0.15], [0.05, -0.15]].forEach(([x, y]) => g.lineTo(x * s, y * s));
    g.fill();
  },
  ABM: (g, s) => word(g, s, 'ABM'),
  MEDAN: (g, s) => word(g, s, 'MEDAN'),
  2016: (g, s) => word(g, s, '2016'),
  '#1': (g, s) => word(g, s, '#1'),
};
function word(g, s, text) {
  g.font = `italic 800 ${Math.round(s * 1.25)}px "Barlow Condensed", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 0, 0);
}
const SHAPE_NAMES = Object.keys(SHAPES);

export function mountDotMatrix(canvas, { originEl } = {}) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const css = getComputedStyle(document.documentElement);
  const ORANGE = css.getPropertyValue('--color-orange-brand').trim() || '#f07822';
  const DOT = css.getPropertyValue('--color-neutral-300').trim() || '#c5c2c0';

  let w = 0, h = 0, dpr = 1, gap = 20, cols = 0, rows = 0;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = window.innerWidth;
    h = window.innerHeight;
    gap = w < 640 ? 16 : 20;
    cols = Math.ceil(w / gap) + 1;
    rows = Math.ceil(h / gap) + 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    from = to = delay = new Float32Array(0); // grid changed: rebuild the shape on the next frame
    morphStart = -99;
    if (!running) draw(performance.now() / 1000);
  }

  // ---------- shape morph ----------
  const mask = document.createElement('canvas');
  const mctx = mask.getContext('2d', { willReadFrequently: true });
  let from = new Float32Array(0), to = new Float32Array(0), delay = new Float32Array(0);
  let morphStart = -99, shapeName = '';
  const MORPH = 1.2, HOLD = 3.6;

  function renderShape(name) {
    mask.width = cols; mask.height = rows;
    const s = Math.max(5, Math.min(cols, rows) * (0.16 + Math.random() * 0.14));
    const wide = name === 'court' || name === 'MEDAN' ? 1.6 : 1;
    mctx.save();
    mctx.translate(s * wide + Math.random() * Math.max(1, cols - 2 * s * wide), s + Math.random() * Math.max(1, rows - 2 * s));
    mctx.rotate((Math.random() - 0.5) * 0.35);
    mctx.fillStyle = mctx.strokeStyle = '#fff';
    mctx.lineWidth = Math.max(1, s * 0.12);
    mctx.lineCap = mctx.lineJoin = 'round';
    SHAPES[name](mctx, s);
    mctx.restore();
    const px = mctx.getImageData(0, 0, cols, rows).data;
    const out = new Float32Array(cols * rows);
    for (let i = 0; i < out.length; i++) out[i] = Math.min(1, px[i * 4 + 3] / 200);
    return out;
  }
  // k = how far dot i is through the morph (each dot has its own start delay → sparkly assembly)
  const morphK = (i, t) => Math.min(1, Math.max(0, ((t - morphStart) / MORPH - delay[i] * 0.6) / 0.4));
  function shapeAt(i, t) {
    if (!to.length) return 0;
    return from[i] + (to[i] - from[i]) * morphK(i, t);
  }
  function nextShape(t) {
    let name;
    do { name = SHAPE_NAMES[Math.floor(Math.random() * SHAPE_NAMES.length)]; } while (name === shapeName);
    shapeName = name;
    const n = cols * rows;
    const now = new Float32Array(n);
    if (to.length === n) for (let i = 0; i < n; i++) now[i] = shapeAt(i, t);
    from = now;
    to = renderShape(name);
    delay = new Float32Array(n).map(Math.random);
    morphStart = t;
  }
  window.addEventListener('resize', resize);

  // Pointer, smoothed so the halo trails the cursor instead of snapping.
  const p = { x: -999, y: -999, sx: -999, sy: -999 };
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !fine.matches) return;
    p.x = e.clientX; p.y = e.clientY;
    if (p.sx < -900) { p.sx = p.x; p.sy = p.y; }
  }, { passive: true });
  document.addEventListener('pointerleave', () => { p.x = p.y = -999; });

  // ---------- audio ----------
  let audio = null; // { ctx, stream, analyser, data }
  let bassAvg = 0, lastBeat = 0, level = 0;
  const ripples = [];

  async function enableMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    const actx = new AudioContext();
    const analyser = actx.createAnalyser();
    analyser.fftSize = 512; // ~94 Hz per bin at 48 kHz, fine enough to isolate the kick drum
    analyser.smoothingTimeConstant = 0.72;
    actx.createMediaStreamSource(stream).connect(analyser);
    audio = { ctx: actx, stream, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    start();
  }
  function disableMic() {
    if (!audio) return;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
    audio = null;
    level = 0;
  }

  function ripple(strength) {
    let x = w / 2, y = h / 2;
    const r = originEl?.getBoundingClientRect();
    if (r && r.bottom > 0 && r.top < h) { x = r.left + r.width / 2; y = r.top + r.height / 2; }
    ripples.push({ x, y, t0: performance.now() / 1000, s: strength });
    if (ripples.length > 6) ripples.shift();
  }

  // ---------- draw ----------
  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    const usable = audio ? Math.floor(audio.data.length * 0.45) : 0; // above ~10 kHz is mostly hiss
    if (audio) {
      audio.analyser.getByteFrequencyData(audio.data);
      // Bass = up to ~200 Hz, computed from the real sample rate.
      const hz = audio.ctx.sampleRate / audio.analyser.fftSize;
      const bassBins = Math.max(2, Math.round(200 / hz));
      let bass = 0;
      for (let i = 0; i < bassBins; i++) bass += audio.data[i];
      bass /= bassBins * 255;
      let sum = 0;
      for (let i = 0; i < usable; i++) sum += audio.data[i];
      level += (sum / (usable * 255) - level) * 0.3;
      const now = t * 1000;
      if (isBeat(bass, bassAvg, now, lastBeat)) {
        lastBeat = now;
        if (t - morphStart > 1.4) nextShape(t); // the beat drives the shape changes
        ripple(Math.min(1, bass * 1.4));
        window.dispatchEvent(new CustomEvent('abm:beat', { detail: Math.min(1, bass * 1.3) }));
      }
      bassAvg += (bass - bassAvg) * 0.05;
    }

    if (to.length !== cols * rows || t - morphStart > MORPH + HOLD) nextShape(t);

    p.sx += (p.x - p.sx) * 0.18;
    p.sy += (p.y - p.sy) * 0.18;
    const live = ripples.filter((r) => t - r.t0 < 1.6);

    for (let c = 0; c < cols; c++) {
      const x = c * gap;
      // Spectrum: log-ish mapping so bass gets more columns than treble.
      let colLevel = 0;
      if (audio) {
        const bin = Math.min(usable - 1, Math.floor((c / cols) ** 1.6 * usable) + 1);
        colLevel = audio.data[bin] / 255;
      }
      const lit = colLevel * rows * 0.55;

      for (let r = 0; r < rows; r++) {
        const y = r * gap;
        let grey = 0.07 + 0.06 * (0.5 + 0.5 * Math.sin(x * 0.011 + y * 0.008 - t * 0.9));
        let hot = 0;

        const dx = x - p.sx, dy = y - p.sy;
        const dp = Math.sqrt(dx * dx + dy * dy);
        if (dp < 170) { const k = 1 - dp / 170; grey += k * k * 0.45; hot += k * k * k * 0.25; }

        for (const rp of live) {
          const age = t - rp.t0;
          const d = Math.hypot(x - rp.x, y - rp.y);
          const band = Math.exp(-(((d - age * 760) / 46) ** 2));
          hot += band * rp.s * (1 - age / 1.6) * 0.9;
        }

        // Shape: shimmering body + a flash on dots as they switch on
        const i = r * cols + c;
        const shp = shapeAt(i, t);
        if (shp > 0.01) {
          hot += shp * (0.62 + 0.22 * Math.sin(t * 2.6 + c * 0.7 + r * 1.3)) * (1 + level * 1.5);
          const k = morphK(i, t);
          if (to[i] > 0.3 && k > 0 && k < 1) hot += Math.sin(k * Math.PI) * 0.7;
        }

        if (lit > 0) {
          const fromBottom = rows - 1 - r;
          if (fromBottom < lit) hot += 0.25 + 0.55 * (1 - fromBottom / lit) * colLevel;
        }

        grey = Math.min(grey + level * 0.15, 0.6);
        const s = 1.6 + Math.min(hot, 1.2) * 2.6;
        ctx.globalAlpha = grey;
        ctx.fillStyle = DOT;
        ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
        if (hot > 0.03) {
          ctx.globalAlpha = Math.min(hot, 1);
          ctx.fillStyle = ORANGE;
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------- loop ----------
  let running = false, paused = false;
  function frame(now) {
    if (!running) return;
    draw(now / 1000);
    requestAnimationFrame(frame);
  }
  function start() {
    if (running || paused || reduce.matches || document.hidden) return;
    running = true;
    requestAnimationFrame(frame);
  }
  function stop() { running = false; }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduce.addEventListener('change', () => { if (reduce.matches) { stop(); disableMic(); draw(0); } else start(); });

  resize();
  start();

  return {
    enableMic, disableMic,
    get micOn() { return !!audio; },
    setPaused(v) { paused = v; if (v) stop(); else start(); },
  };
}
