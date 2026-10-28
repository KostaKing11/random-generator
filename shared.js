// Zajednicko za tocak i panel: lista imena i veza izmedju uredjaja.
const APP = {
  NAMES: [
    'Vladimir A', 'Selena', 'Kosta', 'Aleksa', 'Aleksandar', 'Andrija', 'Lazar',
    'Danilo', 'Sara', 'Anastasija', 'Nikola', 'Sava', 'Kiril', 'Uros',
    'Ana', 'Vladimir M', 'Leona', 'Odesa', 'Zoe', 'Vuk', 'Tara',
  ],
  CHANNEL: 'tk-27a004a71d14dfea17',
  RELAY: 'https://ntfy.sh',
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  },
};

// Poruke idu preko ntfy.sh (radi izmedju razlicitih uredjaja, bez naloga)
// i preko BroadcastChannel (kad su oba sajta otvorena u istom browseru).
function createBus(onMessage, onConnection) {
  const src = Math.random().toString(36).slice(2, 10);
  const seen = new Set();
  let lastId = null;
  let es = null;
  let retry = null;
  let bc = null;

  function handle(m) {
    if (!m || typeof m !== 'object' || !m.mid || seen.has(m.mid)) return;
    seen.add(m.mid);
    if (m.src !== src) onMessage(m);
  }

  function unwrap(entry) {
    if (!entry || entry.event !== 'message' || !entry.message) return null;
    if (entry.id) lastId = entry.id;
    try { return JSON.parse(entry.message); } catch (e) { return null; }
  }

  try {
    bc = new BroadcastChannel(APP.CHANNEL);
    bc.onmessage = (e) => handle(e.data);
  } catch (e) {}

  // Vraca id poruke odmah (odgovor moze stici pre nego sto se fetch zavrsi)
  // i `sent` koji kaze da li je poruka stigla do ntfy.sh.
  function send(type, data = {}) {
    const m = {
      ...data,
      type,
      src,
      mid: src + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
    };
    seen.add(m.mid);
    try { if (bc) bc.postMessage(m); } catch (e) {}
    const sent = fetch(`${APP.RELAY}/${APP.CHANNEL}`, { method: 'POST', body: JSON.stringify(m) })
      .then((r) => r.ok, () => false);
    return { mid: m.mid, sent };
  }

  // Poruke iz poslednjih 12h (da se podesavanja ne izgube kad se stranica osvezi).
  async function history() {
    try {
      const r = await fetch(`${APP.RELAY}/${APP.CHANNEL}/json?poll=1&since=12h`);
      const out = [];
      for (const line of (await r.text()).split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (e) { continue; }
        const m = unwrap(entry);
        if (m && m.mid && !seen.has(m.mid)) {
          seen.add(m.mid);
          out.push(m);
        }
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  // Neki browseri (npr. na satu) nemaju EventSource, tada pitamo svake 2s.
  function poll() {
    fetch(`${APP.RELAY}/${APP.CHANNEL}/json?poll=1&since=${lastId || '10s'}`)
      .then((r) => r.text())
      .then((text) => {
        if (onConnection) onConnection(true);
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { handle(unwrap(JSON.parse(line))); } catch (e) {}
        }
      }, () => onConnection && onConnection(false))
      .then(() => { retry = setTimeout(poll, 2000); });
  }

  function connect() {
    if (!window.EventSource) {
      poll();
      return;
    }
    if (es) es.close();
    clearTimeout(retry);
    es = new EventSource(`${APP.RELAY}/${APP.CHANNEL}/sse` + (lastId ? `?since=${lastId}` : ''));
    es.onopen = () => onConnection && onConnection(true);
    es.onmessage = (e) => {
      let entry;
      try { entry = JSON.parse(e.data); } catch (err) { return; }
      handle(unwrap(entry));
    };
    es.onerror = () => {
      if (onConnection) onConnection(false);
      es.close();
      retry = setTimeout(connect, 3000);
    };
  }

  return { send, history, connect };
}
