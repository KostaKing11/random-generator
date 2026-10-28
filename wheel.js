(() => {
  const NAMES = APP.NAMES;
  const N = NAMES.length;
  const SEG = 360 / N;
  const COLORS = ['#e11d48', '#2563eb', '#d97706', '#7c3aed', '#059669', '#db2777', '#0891b2'];
  const KEY = { cfg: 'tk_cfg', used: 'tk_used', mute: 'tk_mute' };

  const $ = (id) => document.getElementById(id);
  const mod = (a, b) => ((a % b) + b) % b;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const now = () => performance.now() / 1000;
  const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

  // ---------- podesavanja (stizu sa panela) ----------

  let settings = { winner: null, keep: false, duration: 8, excluded: [] };
  let cfgId = null;
  const used = new Set(store.get(KEY.used, []));

  function applyCfg(m) {
    cfgId = m.mid;
    settings = {
      winner: NAMES.includes(m.winner) ? m.winner : null,
      keep: !!m.keep,
      duration: clamp(Number(m.duration) || 8, 2, 30),
      excluded: (Array.isArray(m.excluded) ? m.excluded : []).filter((n) => NAMES.includes(n)),
    };
    if (settings.winner && !settings.keep && used.has(cfgId)) settings.winner = null;
    store.set(KEY.cfg, m);
  }

  function useWinner() {
    const idx = NAMES.indexOf(settings.winner);
    if (!settings.keep) {
      used.add(cfgId);
      store.set(KEY.used, [...used].slice(-30));
      settings.winner = null;
    }
    return idx;
  }

  function randomIdx() {
    let pool = NAMES.map((_, i) => i).filter((i) => !settings.excluded.includes(NAMES[i]));
    if (!pool.length) pool = NAMES.map((_, i) => i);
    return pool[Math.floor(rand() * pool.length)];
  }

  // ---------- kretanje tocka ----------
  // Ugao je u stepenima (u smeru kazaljke). Plan se sastoji od delova:
  // ubrzanje (s^2) pa usporavanje (kubna kriva koja krece brzinom v0 i staje na nuli).

  let theta = 0;
  let plan = null;
  let spinning = false;
  let lastResult = null;

  const ACCEL = { f: (s) => s * s, df: (s) => 2 * s, accel: true };
  const decel = (k) => ({
    f: (s) => k * s + (3 - 2 * k) * s * s + (k - 2) * s * s * s,
    df: (s) => k + 2 * (3 - 2 * k) * s + 3 * (k - 2) * s * s,
  });
  const piece = (t0, T, a0, D, ease) => ({ t0, T, a0, D, ...ease });

  const planEnd = () => {
    const p = plan.pieces[plan.pieces.length - 1];
    return p.t0 + p.T;
  };

  function evalPlan(t) {
    for (const p of plan.pieces) {
      if (t < p.t0 + p.T) {
        const s = clamp((t - p.t0) / p.T, 0, 1);
        return { a: p.a0 + p.D * p.f(s), v: (p.D / p.T) * p.df(s), p };
      }
    }
    const p = plan.pieces[plan.pieces.length - 1];
    return { a: p.a0 + p.D, v: 0, p: null };
  }

  // Ugao pod kojim strelica pokazuje na ime idx (malo nasumicno unutar polja).
  const landAngle = (idx) => mod(-(idx + 0.1 + rand() * 0.8) * SEG, 360);
  const idxAt = (a) => Math.floor(mod(-a, 360) / SEG) % N;

  // Usporavanje od ugla a0 brzinom v0 tako da stane na idx. Trazi najkrace vreme
  // u [Tmin, Tmax] za koje kriva izgleda prirodno (k blizu 2.4, bez trzaja).
  function solveDecel(t0, a0, v0, idx, Tmin, Tmax) {
    const base = mod(landAngle(idx) - a0, 360);
    let best = null;
    for (let T = Tmin; T <= Tmax + 1e-9 && !best; T += 0.1) {
      const lo = (v0 * T) / 2.9;
      const hi = (v0 * T) / 1.3;
      for (let n = Math.max(0, Math.ceil((lo - base) / 360)); base + 360 * n <= hi; n++) {
        const D = base + 360 * n;
        const k = (v0 * T) / D;
        if (!best || Math.abs(k - 2.4) < Math.abs(best.k - 2.4)) best = { T, D, k };
      }
    }
    if (!best) {
      // Tocak je skoro stao: polako "dopuzi" do imena.
      const D = base < 20 ? base + 360 : base;
      const T = clamp((2.2 * D) / Math.max(v0, 40), Tmin, Tmax);
      best = { T, D, k: Math.min(3, (v0 * T) / D) };
    }
    return piece(t0, best.T, a0, best.D, decel(best.k));
  }

  function spin() {
    if (spinning) return;
    sound.unlock();
    hideWinner();
    theta = mod(theta, 360);
    const idx = settings.winner ? useWinner() : randomIdx();
    const t = now();
    const dur = settings.duration;
    const ta = Math.min(0.9, dur * 0.12);
    const vmax = 1000 + rand() * 250;
    const acc = piece(t, ta, theta, (vmax * ta) / 2, ACCEL);
    const dec = solveDecel(t + ta, theta + acc.D, vmax, idx, dur - ta, dur - ta);
    plan = { pieces: [acc, dec], target: idx };
    spinning = true;
    document.body.classList.add('spinning');
    $('spinBtn').disabled = true;
    sound.whoosh();
    publishStatus();
  }

  // Promena cilja usred vrtenja: tocak nastavlja glatko i po potrebi se vrti duze.
  function retarget(idx) {
    if (!spinning || idx === plan.target) return;
    const t = now();
    const { a, v, p } = evalPlan(t);
    if (p && p.accel) {
      const d = plan.pieces[1];
      plan.pieces[1] = solveDecel(d.t0, d.a0, (p.D / p.T) * 2, idx, d.T, d.T + 3);
    } else {
      const rem = Math.max(planEnd() - t, 1.5);
      plan.pieces = [solveDecel(t, a, v, idx, rem, rem + 7)];
    }
    plan.target = idx;
  }

  function finish() {
    const p = plan.pieces[plan.pieces.length - 1];
    theta = p.a0 + p.D;
    spinning = false;
    lastResult = NAMES[idxAt(theta)];
    document.body.classList.remove('spinning');
    $('spinBtn').disabled = false;
    showWinner(lastResult);
    publishStatus();
  }

  // ---------- veza sa panelom ----------

  function publishStatus(extra = {}) {
    bus.send('status', {
      state: spinning ? 'spinning' : 'idle',
      until: spinning ? Date.now() + (planEnd() - now()) * 1000 : 0,
      target: spinning ? NAMES[plan.target] : null,
      result: lastResult,
      next: settings.winner,
      keep: settings.keep,
      cfg: cfgId,
      consumed: [...used].slice(-5),
      ...extra,
    });
  }

  function onMessage(m) {
    if (m.type === 'ping') {
      publishStatus();
    } else if (m.type === 'cfg') {
      applyCfg(m);
      let applied = 'next';
      if (m.now && spinning) {
        applied = 'now';
        if (settings.winner) retarget(useWinner());
        else if (settings.excluded.includes(NAMES[plan.target])) retarget(randomIdx());
      }
      publishStatus({ ack: m.mid, applied });
    }
  }

  const bus = createBus(onMessage);
  const saved = store.get(KEY.cfg, null);
  if (saved) applyCfg(saved);
  bus.history().then((list) => {
    for (const m of list) {
      if (m.type === 'status') (m.consumed || []).forEach((id) => used.add(id));
    }
    const cfgs = list.filter((m) => m.type === 'cfg');
    const last = cfgs[cfgs.length - 1];
    if (last && (!saved || last.ts >= saved.ts)) applyCfg(last);
    else if (saved) applyCfg(saved);
    bus.connect();
    publishStatus();
  });

  // ---------- zvuk ----------

  const sound = (() => {
    let ctx = null;
    let muted = store.get(KEY.mute, false);
    let lastTick = 0;
    const out = () => ctx && !muted;

    function unlock() {
      if (!ctx) {
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    function tone(freq, start, len, type = 'square', vol = 0.15) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(vol, start);
      g.gain.exponentialRampToValueAtTime(0.0001, start + len);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + len + 0.02);
    }

    function noise(start, len, from, to, vol) {
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      const f = ctx.createBiquadFilter();
      const g = ctx.createGain();
      src.buffer = buf;
      f.type = 'bandpass';
      f.Q.value = 1.2;
      f.frequency.setValueAtTime(from, start);
      f.frequency.exponentialRampToValueAtTime(to, start + len);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(vol, start + len * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, start + len);
      src.connect(f).connect(g).connect(ctx.destination);
      src.start(start);
    }

    return {
      unlock,
      get muted() { return muted; },
      toggle() {
        muted = !muted;
        store.set(KEY.mute, muted);
        return muted;
      },
      tick(speed) {
        if (!out()) return;
        const t = ctx.currentTime;
        if (t - lastTick < 0.035) return;
        lastTick = t;
        tone(1400 + Math.min(speed, 1200) * 0.6, t, 0.03, 'square', 0.06);
      },
      whoosh() {
        if (!out()) return;
        noise(ctx.currentTime, 0.9, 300, 3000, 0.25);
      },
      win() {
        if (!out()) return;
        const t = ctx.currentTime;
        tone(55, t, 0.8, 'sawtooth', 0.25);
        tone(110, t, 0.6, 'square', 0.12);
        noise(t, 0.6, 4000, 200, 0.3);
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          tone(f, t + 0.08 + i * 0.09, 0.5, 'sawtooth', 0.07);
          tone(f * 1.005, t + 0.08 + i * 0.09, 0.5, 'square', 0.04);
        });
        tone(1046.5, t + 0.5, 1.4, 'triangle', 0.12);
        tone(1318.5, t + 0.5, 1.4, 'triangle', 0.08);
      },
    };
  })();

  // ---------- crtanje ----------

  const cv = $('wheel');
  const ctx = cv.getContext('2d');
  let size = 0;
  let face = null;
  let pointerKick = 0;
  let pointerVel = 0;
  let lastIdx = idxAt(theta);
  let winFlash = 0;

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
      Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // Lice tocka (polja + imena) se crta jednom pa se samo rotira.
  function buildFace() {
    const R = size * 0.42;
    face = document.createElement('canvas');
    face.width = face.height = Math.ceil(R * 2);
    const f = face.getContext('2d');
    f.translate(R, R);
    const rad = (SEG * Math.PI) / 180;
    for (let i = 0; i < N; i++) {
      const a0 = -Math.PI / 2 + i * rad;
      const col = COLORS[i % COLORS.length];
      const g = f.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
      g.addColorStop(0, shade(col, -0.75));
      g.addColorStop(0.55, shade(col, -0.25));
      g.addColorStop(0.92, col);
      g.addColorStop(1, shade(col, 0.25));
      f.beginPath();
      f.moveTo(0, 0);
      f.arc(0, 0, R, a0, a0 + rad);
      f.closePath();
      f.fillStyle = g;
      f.fill();
      f.strokeStyle = 'rgba(0,0,0,0.55)';
      f.lineWidth = Math.max(1, R * 0.008);
      f.stroke();
      f.beginPath();
      f.moveTo(0, 0);
      f.lineTo(Math.cos(a0) * R, Math.sin(a0) * R);
      f.strokeStyle = 'rgba(255,255,255,0.22)';
      f.lineWidth = Math.max(1, R * 0.003);
      f.stroke();

      f.save();
      f.rotate(a0 + rad / 2);
      const name = NAMES[i].toUpperCase();
      let fs = R * 0.085;
      f.font = `${fs}px Anton, Impact, sans-serif`;
      const maxW = R * 0.66;
      const w = f.measureText(name).width;
      if (w > maxW) {
        fs *= maxW / w;
        f.font = `${fs}px Anton, Impact, sans-serif`;
      }
      f.textAlign = 'right';
      f.textBaseline = 'middle';
      f.shadowColor = 'rgba(0,0,0,0.8)';
      f.shadowBlur = R * 0.02;
      f.shadowOffsetY = R * 0.006;
      f.fillStyle = '#fff';
      f.fillText(name, R * 0.9, 0);
      f.restore();
    }
    // sjaj preko polja
    const gloss = f.createRadialGradient(-R * 0.3, -R * 0.4, 0, 0, 0, R);
    gloss.addColorStop(0, 'rgba(255,255,255,0.18)');
    gloss.addColorStop(0.6, 'rgba(255,255,255,0)');
    f.fillStyle = gloss;
    f.beginPath();
    f.arc(0, 0, R, 0, Math.PI * 2);
    f.fill();
  }

  function resize() {
    const box = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = Math.round(box.width * dpr);
    cv.width = cv.height = size;
    buildFace();
  }

  function drawPointer(c, R) {
    c.save();
    c.translate(0, -R * 1.07);
    c.rotate((pointerKick * Math.PI) / 180);
    const w = R * 0.085;
    const h = R * 0.2;
    c.shadowColor = 'rgba(255,190,40,0.9)';
    c.shadowBlur = R * 0.06;
    c.beginPath();
    c.moveTo(-w, -h * 0.25);
    c.quadraticCurveTo(0, -h * 0.55, w, -h * 0.25);
    c.lineTo(0, h * 0.75);
    c.closePath();
    const g = c.createLinearGradient(-w, 0, w, 0);
    g.addColorStop(0, '#fff4c2');
    g.addColorStop(0.5, '#ffc21a');
    g.addColorStop(1, '#b86b00');
    c.fillStyle = g;
    c.fill();
    c.shadowBlur = 0;
    c.lineWidth = R * 0.012;
    c.strokeStyle = '#3a2000';
    c.stroke();
    c.beginPath();
    c.arc(0, -h * 0.12, w * 0.32, 0, Math.PI * 2);
    c.fillStyle = '#3a2000';
    c.fill();
    c.restore();
  }

  function draw(t, speed) {
    const c = ctx;
    const R = size * 0.42;
    c.clearRect(0, 0, size, size);
    c.save();
    c.translate(size / 2, size / 2);

    // spoljni prsten
    const ring = c.createLinearGradient(0, -R * 1.12, 0, R * 1.12);
    ring.addColorStop(0, '#5b4a8a');
    ring.addColorStop(0.5, '#1a1230');
    ring.addColorStop(1, '#3d2f63');
    c.beginPath();
    c.arc(0, 0, R * 1.1, 0, Math.PI * 2);
    c.fillStyle = ring;
    c.shadowColor = 'rgba(139,92,246,0.7)';
    c.shadowBlur = R * 0.15;
    c.fill();
    c.shadowBlur = 0;
    c.lineWidth = R * 0.012;
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.stroke();

    // sijalice
    const bulbs = N * 2;
    const chase = spinning ? Math.floor(t * 18) : Math.floor(t * 2);
    for (let i = 0; i < bulbs; i++) {
      const a = (i / bulbs) * Math.PI * 2;
      const on = winFlash > 0 ? Math.floor(t * 10) % 2 === 0 : (i + chase) % (spinning ? 3 : 2) === 0;
      const x = Math.cos(a) * R * 1.05;
      const y = Math.sin(a) * R * 1.05;
      c.beginPath();
      c.arc(x, y, R * 0.018, 0, Math.PI * 2);
      c.fillStyle = on ? '#fff3c4' : '#4a3a24';
      c.shadowColor = on ? '#ffc400' : 'transparent';
      c.shadowBlur = on ? R * 0.05 : 0;
      c.fill();
    }
    c.shadowBlur = 0;

    // lice
    c.save();
    c.rotate((theta * Math.PI) / 180);
    c.drawImage(face, -face.width / 2, -face.height / 2);
    if (winFlash > 0) {
      const i = idxAt(theta);
      const rad = (SEG * Math.PI) / 180;
      const a0 = -Math.PI / 2 + i * rad;
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, R, a0, a0 + rad);
      c.closePath();
      c.fillStyle = `rgba(255,255,255,${0.35 * (0.5 + 0.5 * Math.sin(t * 12)) * Math.min(1, winFlash)})`;
      c.fill();
    }
    c.restore();

    // zamagljenje pri velikoj brzini
    if (speed > 400) {
      c.beginPath();
      c.arc(0, 0, R, 0, Math.PI * 2);
      c.fillStyle = `rgba(10,6,20,${Math.min(0.25, (speed - 400) / 3000)})`;
      c.fill();
    }

    // senka unutra
    const inner = c.createRadialGradient(0, 0, R * 0.8, 0, 0, R);
    inner.addColorStop(0, 'rgba(0,0,0,0)');
    inner.addColorStop(1, 'rgba(0,0,0,0.45)');
    c.beginPath();
    c.arc(0, 0, R, 0, Math.PI * 2);
    c.fillStyle = inner;
    c.fill();

    // centar
    const hub = c.createRadialGradient(-R * 0.03, -R * 0.04, 0, 0, 0, R * 0.16);
    hub.addColorStop(0, '#fff6d1');
    hub.addColorStop(0.35, '#ffbe1a');
    hub.addColorStop(1, '#7a3d00');
    c.beginPath();
    c.arc(0, 0, R * 0.15, 0, Math.PI * 2);
    c.fillStyle = hub;
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = R * 0.06;
    c.fill();
    c.shadowBlur = 0;
    c.lineWidth = R * 0.012;
    c.strokeStyle = '#2b1500';
    c.stroke();
    c.beginPath();
    c.arc(0, 0, R * 0.1, 0, Math.PI * 2);
    c.fillStyle = '#140b26';
    c.fill();
    c.font = `${R * 0.11}px Anton, Impact, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#ffcf3f';
    c.fillText('?', 0, R * 0.005);

    drawPointer(c, R);
    c.restore();
  }

  let prevT = now();
  function frame() {
    const t = now();
    const dt = Math.min(0.05, t - prevT);
    prevT = t;
    let speed = 0;
    if (spinning) {
      if (t >= planEnd()) {
        finish();
      } else {
        const st = evalPlan(t);
        theta = st.a;
        speed = st.v;
      }
    }
    const idx = idxAt(theta);
    if (idx !== lastIdx) {
      lastIdx = idx;
      pointerVel -= 500 + Math.min(speed, 800);
      sound.tick(speed);
    }
    // strelica se vraca kao opruga
    pointerVel += (-pointerKick * 300 - pointerVel * 18) * dt;
    pointerKick = clamp(pointerKick + pointerVel * dt, -32, 6);
    winFlash = Math.max(0, winFlash - dt * 0.25);
    draw(t, speed);
    requestAnimationFrame(frame);
  }

  // ---------- pobednik i konfete ----------

  let confetti = [];
  let confettiOn = false;

  function showWinner(name) {
    sound.win();
    winFlash = 1.2;
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 600);
    setTimeout(() => {
      $('winnerName').textContent = name;
      $('winner').hidden = false;
      burst();
    }, 700);
  }

  function hideWinner() {
    $('winner').hidden = true;
    confetti = [];
  }

  function burst() {
    const c = $('confetti');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    const cols = ['#ff2d55', '#ffcf3f', '#8b5cf6', '#22d3ee', '#ffffff', '#ff8a00', '#34d399'];
    for (let i = 0; i < 220; i++) {
      const a = rand() * Math.PI * 2;
      const v = (300 + rand() * 900) * dpr;
      confetti.push({
        x: c.width / 2,
        y: c.height * 0.45,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 400 * dpr,
        r: rand() * Math.PI,
        vr: (rand() - 0.5) * 20,
        w: (6 + rand() * 8) * dpr,
        h: (10 + rand() * 10) * dpr,
        c: cols[i % cols.length],
      });
    }
    if (!confettiOn) {
      confettiOn = true;
      let last = now();
      const step = () => {
        const t = now();
        const dt = Math.min(0.05, t - last);
        last = t;
        const g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        confetti = confetti.filter((p) => p.y < c.height + 50);
        for (const p of confetti) {
          p.vy += 900 * dpr * dt;
          p.vx *= 0.985;
          p.vy *= 0.985;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.r += p.vr * dt;
          g.save();
          g.translate(p.x, p.y);
          g.rotate(p.r);
          g.scale(1, Math.cos(p.r * 2));
          g.fillStyle = p.c;
          g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          g.restore();
        }
        if (confetti.length) requestAnimationFrame(step);
        else confettiOn = false;
      };
      requestAnimationFrame(step);
    }
  }

  // ---------- pozadina (zvezde) ----------

  function startBackground() {
    const c = $('bg');
    const g = c.getContext('2d');
    let stars = [];
    const fit = () => {
      c.width = innerWidth;
      c.height = innerHeight;
      stars = Array.from({ length: Math.round((innerWidth * innerHeight) / 9000) }, () => ({
        x: rand() * innerWidth,
        y: rand() * innerHeight,
        r: rand() * 1.4 + 0.3,
        p: rand() * Math.PI * 2,
        s: rand() * 0.3 + 0.05,
      }));
    };
    fit();
    addEventListener('resize', fit);
    const step = () => {
      const t = now();
      const boost = spinning ? 6 : 1;
      g.clearRect(0, 0, c.width, c.height);
      for (const s of stars) {
        s.y -= s.s * boost;
        if (s.y < -2) s.y = c.height + 2;
        g.globalAlpha = 0.35 + 0.35 * Math.sin(t * 2 + s.p);
        g.fillStyle = '#d8ccff';
        g.beginPath();
        g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- kontrole ----------

  $('spinBtn').addEventListener('click', spin);
  $('stage').addEventListener('click', spin);
  $('againBtn').addEventListener('click', spin);
  $('winner').addEventListener('click', (e) => {
    if (e.target.id !== 'againBtn' && !e.target.closest('#againBtn')) hideWinner();
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      spin();
    } else if (e.code === 'Escape') {
      hideWinner();
    }
  });

  const muteBtn = $('muteBtn');
  muteBtn.textContent = sound.muted ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => {
    sound.unlock();
    muteBtn.textContent = sound.toggle() ? '🔇' : '🔊';
  });
  $('fsBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  });

  addEventListener('resize', resize);
  resize();
  if (document.fonts) document.fonts.ready.then(buildFace);
  startBackground();
  requestAnimationFrame(frame);
})();
