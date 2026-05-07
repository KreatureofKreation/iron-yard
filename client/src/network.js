// Thin WebSocket wrapper with auto-reconnect on drop.
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.id = null;
    this.connected = false;
    this.rtt = 0;
    this._pingCounter = 0;
    this._pingSentAt = new Map();
    this._url = null;
    this._lastJoinPayload = null;       // re-sent on reconnect
    this._reconnectTimer = null;
    this._wantConnected = false;        // user pressed PLAY
    this._reconnectAttempts = 0;
  }

  on(t, fn) { this.handlers.set(t, fn); return this; }

  // Cache the join message so we can re-send it after reconnect.
  rememberJoin(payload) { this._lastJoinPayload = payload; }

  connect(url) {
    this._url = url;
    this._wantConnected = true;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        this.connected = true;
        this._reconnectAttempts = 0;
        const fn = this.handlers.get("open");
        if (fn) fn();
        resolve();
      };
      ws.onerror = (e) => reject(e);
      ws.onclose = () => {
        this.connected = false;
        const fn = this.handlers.get("close");
        if (fn) fn();
        // Auto-reconnect with exponential backoff (cap ~5s).
        if (this._wantConnected) {
          const delay = Math.min(5000, 600 + this._reconnectAttempts * 600);
          this._reconnectAttempts++;
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = setTimeout(() => this._reconnect(), delay);
        }
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

  // Internal: try to re-establish the socket and re-join.
  _reconnect() {
    if (!this._wantConnected || !this._url) return;
    const ws = new WebSocket(this._url);
    ws.onopen = () => {
      this.connected = true;
      this._reconnectAttempts = 0;
      const fn = this.handlers.get("reopen") || this.handlers.get("open");
      if (fn) fn();
      // Re-send the join message.
      if (this._lastJoinPayload) ws.send(JSON.stringify(this._lastJoinPayload));
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.connected = false;
      const fn = this.handlers.get("close");
      if (fn) fn();
      if (this._wantConnected) {
        const delay = Math.min(5000, 600 + this._reconnectAttempts * 600);
        this._reconnectAttempts++;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => this._reconnect(), delay);
      }
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === "pong") {
        const sent = this._pingSentAt.get(m.c);
        if (sent != null) { this.rtt = performance.now() - sent; this._pingSentAt.delete(m.c); }
        return;
      }
      if (m.t === "welcome") this.id = m.id;
      const fn = this.handlers.get(m.t);
      if (fn) fn(m);
    };
    this.ws = ws;
  }

  // Manual disconnect (PLAY again, server full, etc).
  disconnect() {
    this._wantConnected = false;
    clearTimeout(this._reconnectTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }

  sendPing() {
    const c = ++this._pingCounter;
    this._pingSentAt.set(c, performance.now());
    this.send({ t: "ping", c });
  }
}
