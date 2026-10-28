(() => {
  const NAMES = APP.NAMES;
  const N = NAMES.length;
  const SEG = 360 / N;
  const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'];
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
    $('spinBtn').disabled = true;
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

    function unlock() {
      if (!ctx) {
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    function tone(freq, start, len, type, vol) {
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

    return {
      unlock,
      get muted() { return muted; },
      toggle() {
        muted = !muted;
        store.set(KEY.mute, muted);
        return muted;
      },
      tick() {
        if (!ctx || muted) return;
        const t = ctx.currentTime;
        if (t - lastTick < 0.04) return;
        lastTick = t;
        tone(900, t, 0.025, 'triangle', 0.08);
      },
      win() {
        if (!ctx || muted) return;
        const t = ctx.currentTime;
        tone(784, t, 0.35, 'sine', 0.2);
        tone(1047, t + 0.12, 0.6, 'sine', 0.2);
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

  // Lice tocka (polja + imena) se crta jednom pa se samo rotira.
  function buildFace() {
    const R = size * 0.46;
    face = document.createElement('canvas');
    face.width = face.height = Math.ceil(R * 2);
    const f = face.getContext('2d');
    f.translate(R, R);
    const rad = (SEG * Math.PI) / 180;
    for (let i = 0; i < N; i++) {
      const a0 = -Math.PI / 2 + i * rad;
      f.beginPath();
      f.moveTo(0, 0);
      f.arc(0, 0, R, a0, a0 + rad);
      f.closePath();
      f.fillStyle = COLORS[i % COLORS.length];
      f.fill();
      f.strokeStyle = '#fff';
      f.lineWidth = Math.max(1, R * 0.006);
      f.stroke();

      f.save();
      f.rotate(a0 + rad / 2);
      const name = NAMES[i];
      let fs = R * 0.075;
      f.font = `800 ${fs}px Nunito, system-ui, sans-serif`;
      const maxW = R * 0.62;
      const w = f.measureText(name).width;
      if (w > maxW) {
        fs *= maxW / w;
        f.font = `800 ${fs}px Nunito, system-ui, sans-serif`;
      }
      f.textAlign = 'right';
      f.textBaseline = 'middle';
      f.fillStyle = '#fff';
      f.fillText(name, R * 0.92, 0);
      f.restore();
    }
  }

  function resize() {
    const box = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = Math.round(box.width * dpr);
    cv.width = cv.height = size;
    buildFace();
  }

  function draw(t) {
    const c = ctx;
    const R = size * 0.46;
    c.clearRect(0, 0, size, size);
    c.save();
    c.translate(size / 2, size / 2);

    c.beginPath();
    c.arc(0, 0, R + R * 0.03, 0, Math.PI * 2);
    c.fillStyle = '#1f2937';
    c.fill();

    c.save();
    c.rotate((theta * Math.PI) / 180);
    c.drawImage(face, -face.width / 2, -face.height / 2);
    if (winFlash > 0) {
      const rad = (SEG * Math.PI) / 180;
      const a0 = -Math.PI / 2 + idxAt(theta) * rad;
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, R, a0, a0 + rad);
      c.closePath();
      c.fillStyle = `rgba(255,255,255,${0.3 * (0.5 + 0.5 * Math.sin(t * 10)) * Math.min(1, winFlash)})`;
      c.fill();
    }
    c.restore();

    c.beginPath();
    c.arc(0, 0, R * 0.13, 0, Math.PI * 2);
    c.fillStyle = '#fff';
    c.fill();
    c.lineWidth = R * 0.02;
    c.strokeStyle = '#1f2937';
    c.stroke();
    c.font = `900 ${R * 0.09}px Nunito, system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#1f2937';
    c.fillText('1E', 0, R * 0.005);

    // strelica
    c.save();
    c.translate(0, -R * 1.02);
    c.rotate((pointerKick * Math.PI) / 180);
    const w = R * 0.06;
    c.beginPath();
    c.moveTo(-w, -R * 0.05);
    c.lineTo(w, -R * 0.05);
    c.lineTo(0, R * 0.1);
    c.closePath();
    c.fillStyle = '#1f2937';
    c.fill();
    c.lineJoin = 'round';
    c.lineWidth = R * 0.012;
    c.strokeStyle = '#fff';
    c.stroke();
    c.restore();

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
      pointerVel -= 400 + Math.min(speed, 600);
      sound.tick();
    }
    // strelica se vraca kao opruga
    pointerVel += (-pointerKick * 300 - pointerVel * 18) * dt;
    pointerKick = clamp(pointerKick + pointerVel * dt, -25, 5);
    winFlash = Math.max(0, winFlash - dt * 0.4);
    draw(t);
    requestAnimationFrame(frame);
  }

  // ---------- pobednik ----------

  function showWinner(name) {
    sound.win();
    winFlash = 1;
    setTimeout(() => {
      $('winnerName').textContent = name;
      $('winner').hidden = false;
    }, 500);
  }

  function hideWinner() {
    $('winner').hidden = true;
  }

  // ---------- kontrole ----------

  $('spinBtn').addEventListener('click', spin);
  $('stage').addEventListener('click', spin);
  $('againBtn').addEventListener('click', spin);
  $('winner').addEventListener('click', (e) => {
    if (e.target.id !== 'againBtn') hideWinner();
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
  requestAnimationFrame(frame);
})();
