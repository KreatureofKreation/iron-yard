import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { Room } from "./room.js";
import { initRapier } from "./physics.js";

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

// Boot order: Rapier WASM init → Room (which builds a PhysicsWorld) → start tick.
await initRapier();
const room = new Room();

function handleSlashCommand(text, player) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd) {
    case "/bots": {
      const n = Math.max(0, Math.min(CONFIG.MAX_PLAYERS - 1, parseInt(args[0] ?? "1", 10)));
      if (Number.isNaN(n)) return "usage: /bots N";
      room.setBotTarget(n);
      return `bot target set to ${n}`;
    }
    case "/diff": {
      const lvl = (args[0] || "").toLowerCase();
      if (!["easy", "medium", "hard"].includes(lvl)) return "usage: /diff easy|medium|hard";
      room.setBotDifficulty(lvl);
      return `bot difficulty set to ${lvl}`;
    }
    case "/score": {
      const n = parseInt(args[0] ?? "5", 10);
      if (!Number.isFinite(n) || n < 1 || n > 99) return "usage: /score N (1-99)";
      CONFIG.MATCH.scoreToWin = n;
      return `score-to-win set to ${n} (next round)`;
    }
    case "/help":
      return "/bots N · /diff easy|medium|hard · /score N · /help";
    default:
      return `unknown command: ${cmd}. try /help`;
  }
}

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
  // Spectators also receive game-state messages.
  for (const s of room.spectators) {
    if (s.readyState === s.OPEN) {
      try { s.send(msg); } catch {}
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
      // Resume an existing slot if the client presents a known sessionId.
      if (typeof msg.sessionId === "string" && msg.sessionId) {
        const z = room.findZombieBySession(msg.sessionId);
        if (z) {
          z.socket = sock;
          z.zombieUntilMs = 0;
          player = z;
          send(sock, {
            t: "welcome", id: player.id, resumed: true,
            config: { tickHz: CONFIG.TICK_HZ, snapHz: CONFIG.SNAP_HZ,
                      player: CONFIG.PLAYER, weapons: CONFIG.WEAPONS, combat: CONFIG.COMBAT },
            arena: room.arenaInfo(),
            you: { weaponKey: player.weaponKey, spawnPos: player.pos },
          });
          broadcast({ t: "join", player: { id: player.id, name: player.name, weaponKey: player.weaponKey, resumed: true } }, player.id);
          return;
        }
      }
      if (room.isFull()) {
        // No more player slots — accept as spectator.
        room.spectators.add(sock);
        sock._spectator = true;
        send(sock, {
          t: "welcome", id: 0, spectator: true,
          config: {
            tickHz: CONFIG.TICK_HZ, snapHz: CONFIG.SNAP_HZ,
            player: CONFIG.PLAYER, weapons: CONFIG.WEAPONS, combat: CONFIG.COMBAT,
          },
          arena: room.arenaInfo(),
        });
        return;
      }
      player = room.addPlayer(msg.name, sock, msg.weapon);
      if (typeof msg.sessionId === "string") player.sessionId = msg.sessionId;
      if (typeof msg.color === "number") player.color = msg.color | 0;
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

    // Spectators can chat (no game inputs). Same rate-limit.
    if (!player && sock._spectator && msg.t === "chat" && typeof msg.text === "string") {
      const now = Date.now();
      if (sock._lastChatAt && now - sock._lastChatAt < 500) return;
      sock._lastChatAt = now;
      const text = msg.text.slice(0, 200);
      broadcast({ t: "chat", from: 0, name: "[spectator]", text });
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
      // Rate-limit: 1 message per 500ms per socket.
      const now = Date.now();
      if (sock._lastChatAt && now - sock._lastChatAt < 500) return;
      sock._lastChatAt = now;
      const text = msg.text.slice(0, 200);
      // Slash-commands. Local to this server; anyone can run them.
      if (text.startsWith("/")) {
        const reply = handleSlashCommand(text, player);
        if (reply) {
          broadcast({ t: "chat", from: 0, name: "[server]", text: `${player.name}: ${text}` });
          broadcast({ t: "chat", from: 0, name: "[server]", text: reply });
        }
        return;
      }
      broadcast({ t: "chat", from: player.id, name: player.name, text });
      return;
    }
  });

  sock.on("close", () => {
    if (player) {
      // If the client supplied a sessionId, keep their slot for the grace window.
      if (player.sessionId && room.zombifyPlayer(player.id)) {
        // Slot held — peers will see them disappear from snapshots until reconnect.
        return;
      }
      const id = player.id;
      room.removePlayer(id);
      broadcast({ t: "leave", id });
    } else if (sock._spectator) {
      room.spectators.delete(sock);
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
    else if (e.kind === "knockdown")  broadcast({ t: "knockdown", ...e });
    else if (e.kind === "sever")      broadcast({ t: "sever",     ...e });
    else if (e.kind === "wallClash")  broadcast({ t: "wallClash", ...e });
    else if (e.kind === "slam")       broadcast({ t: "slam",      ...e });
    else                              broadcast({ t: "hit",       ...e });
  }
}, 1000 / CONFIG.SNAP_HZ);
