// Thin WebSocket wrapper. Event-driven.
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.id = null;
    this.connected = false;
    this.rtt = 0;
    this._pingCounter = 0;
    this._pingSentAt = new Map();
  }

  on(t, fn) { this.handlers.set(t, fn); return this; }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { this.connected = true; resolve(); };
      ws.onerror = (e) => reject(e);
      ws.onclose = () => {
        this.connected = false;
        const fn = this.handlers.get("close");
        if (fn) fn();
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === "pong") {
          const sent = this._pingSentAt.get(m.c);
          if (sent != null) {
            this.rtt = performance.now() - sent;
            this._pingSentAt.delete(m.c);
          }
          return;
        }
        if (m.t === "welcome") this.id = m.id;
        const fn = this.handlers.get(m.t);
        if (fn) fn(m);
      };
      this.ws = ws;
    });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  sendPing() {
    const c = ++this._pingCounter;
    this._pingSentAt.set(c, performance.now());
    this.send({ t: "ping", c });
  }
}
