import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { Room } from "./room.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");

const MIME = {
  ".html":"text/html;charset=utf-8", ".js":"text/javascript;charset=utf-8",
  ".css":"text/css;charset=utf-8", ".json":"application/json;charset=utf-8",
  ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
  ".ico":"image/x-icon", ".map":"application/json;charset=utf-8",
  ".woff":"font/woff", ".woff2":"font/woff2", ".wasm":"application/wasm",
};

const server = http.createServer((req, res) => {
  // Resolve safe file path from request.
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = url === "/" ? "/index.html" : url;
  const filePath = path.normalize(path.join(CLIENT_DIST, rel));
  if (!filePath.startsWith(CLIENT_DIST)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback to index.html if it exists.
      const idx = path.join(CLIENT_DIST, "index.html");
      fs.stat(idx, (e2, s2) => {
        if (e2 || !s2) {
          res.writeHead(404); res.end(
            "client not built — run `npm --prefix client run build`, or open vite dev server at :5173"
          );
        } else {
          res.writeHead(200, { "Content-Type": MIME[".html"] });
          fs.createReadStream(idx).pipe(res);
        }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
});

const room = new Room();
const wss = new WebSocketServer({ server });
server.listen(CONFIG.PORT, () => {
  console.log(`[ironyard] http+ws server on :${CONFIG.PORT}`);
});

const send = (sock, obj) => {
  if (sock.readyState !== sock.OPEN) return;
  try { sock.send(JSON.stringify(obj)); } catch {}
};

const broadcast = (obj, exceptId = null) => {
  const msg = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (exceptId && p.id === exceptId) continue;
    if (p.socket && p.socket.readyState === p.socket.OPEN) {
      try { p.socket.send(msg); } catch {}
    }
  }
};

wss.on("connection", (sock) => {
  let player = null;

  sock.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "join") {
      if (room.isFull()) {
        send(sock, { t: "full", max: CONFIG.MAX_PLAYERS });
        sock.close();
        return;
      }
      player = room.addPlayer(msg.name, sock, msg.weapon);
      send(sock, {
        t: "welcome",
        id: player.id,
        config: {
          tickHz: CONFIG.TICK_HZ,
          snapHz: CONFIG.SNAP_HZ,
          player: CONFIG.PLAYER,
          weapons: CONFIG.WEAPONS,
          combat: CONFIG.COMBAT,
        },
        arena: room.arenaInfo(),
        you: { weaponKey: player.weaponKey, spawnPos: player.pos },
      });
      broadcast({ t: "join", player: { id: player.id, name: player.name, weaponKey: player.weaponKey } }, player.id);
      return;
    }

    if (!player) return;

    if (msg.t === "input") {
      room.handleInput(player.id, msg);
      return;
    }

    if (msg.t === "ping") {
      send(sock, { t: "pong", c: msg.c, ts: Date.now() });
      return;
    }

    if (msg.t === "chat" && typeof msg.text === "string") {
      const text = msg.text.slice(0, 200);
      broadcast({ t: "chat", from: player.id, name: player.name, text });
      return;
    }
  });

  sock.on("close", () => {
    if (player) {
      const id = player.id;
      room.removePlayer(id);
      broadcast({ t: "leave", id });
    }
  });
});

// Sim tick.
setInterval(() => room.step(), 1000 / CONFIG.TICK_HZ);

// Snapshot broadcast.
setInterval(() => {
  if (room.players.size === 0) return;
  const snap = room.snapshot();
  broadcast(snap);
  const events = room.drainHits();
  for (const e of events) {
    if (e.kind === "clash")           broadcast({ t: "clash",     ...e });
    else if (e.kind === "matchEnd")   broadcast({ t: "matchEnd",  ...e });
    else if (e.kind === "matchStart") broadcast({ t: "matchStart",...e });
    else if (e.kind === "pickup")     broadcast({ t: "pickup",    ...e });
    else if (e.kind === "streak")     broadcast({ t: "streak",    ...e });
    else if (e.kind === "chat")       broadcast({ t: "chat",      ...e });
    else if (e.kind === "bleed")      broadcast({ t: "bleed",     ...e });
    else                              broadcast({ t: "hit",       ...e });
  }
}, 1000 / CONFIG.SNAP_HZ);
