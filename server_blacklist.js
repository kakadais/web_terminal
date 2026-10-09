#!/usr/bin/env node
"use strict";

const { HOST, PORT, TOKEN, TRUST_PROXY, SECURITY } = require("./lib/config");
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const pty = require("./lib/pty");
const Datastore = require("@seald-io/nedb");

fs.mkdirSync(SECURITY.dbDir, { recursive: true });

// =====================
// NeDB (IP 실패/차단 상태 저장)
// =====================
const secDb = new Datastore({
  filename: path.join(SECURITY.dbDir, SECURITY.dbFile),
  autoload: true,
});

secDb.ensureIndex({ fieldName: "ip", unique: true }, () => {});
secDb.ensureIndex({ fieldName: "blockedUntil" }, () => {});

function dbFindOne(query) {
  return new Promise((resolve, reject) => {
    secDb.findOne(query, (err, doc) => (err ? reject(err) : resolve(doc)));
  });
}
function dbUpdate(query, update, options = {}) {
  return new Promise((resolve, reject) => {
    secDb.update(query, update, options, (err, numAffected, upsert) =>
      err ? reject(err) : resolve({ numAffected, upsert })
    );
  });
}
function dbRemove(query, options = {}) {
  return new Promise((resolve, reject) => {
    secDb.remove(query, options, (err, n) => (err ? reject(err) : resolve(n)));
  });
}

// =====================
// IP 추출
// =====================
function normalizeIp(ip) {
  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
}

function getClientIp(req) {
  // 프록시 없으면 spoof 가능한 헤더는 무시하고 소켓 remoteAddress를 우선 사용
  if (!TRUST_PROXY) {
    return normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  }

  // 프록시 뒤일 때만 헤더 우선
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const first = xff.split(",")[0].trim();
    if (first) return normalizeIp(first);
  }

  const xri = req.headers["x-real-ip"];
  if (typeof xri === "string" && xri.trim()) return normalizeIp(xri.trim());

  return normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
}

// =====================
// 차단 로직
// =====================
async function isBlocked(ip) {
  const now = Date.now();
  const doc = await dbFindOne({ ip });
  if (!doc) return { blocked: false, failCount: 0 };

  if (doc.blockedUntil && doc.blockedUntil > now) {
    return { blocked: true, blockedUntil: doc.blockedUntil, failCount: doc.failCount || 0 };
  }

  // 차단 만료면 blockedUntil만 정리
  if (doc.blockedUntil && doc.blockedUntil <= now) {
    await dbUpdate({ ip }, { $set: { blockedUntil: 0 } }, { upsert: false });
  }
  return { blocked: false, failCount: doc.failCount || 0 };
}

async function recordFail(ip) {
  const now = Date.now();
  const doc = await dbFindOne({ ip });

  // windowMs 밖이면 리셋
  let failCount = 0;
  let firstFailAt = now;

  if (doc && doc.firstFailAt && now - doc.firstFailAt <= SECURITY.windowMs) {
    failCount = Number(doc.failCount || 0);
    firstFailAt = Number(doc.firstFailAt || now);
  }

  failCount += 1;

  if (failCount >= SECURITY.maxFails) {
    const blockedUntil = now + SECURITY.blockMs;
    await dbUpdate(
      { ip },
      { $set: { ip, failCount, firstFailAt, blockedUntil, lastFailAt: now } },
      { upsert: true }
    );
    return { blockedNow: true, blockedUntil, failCount };
  }

  await dbUpdate(
    { ip },
    { $set: { ip, failCount, firstFailAt, blockedUntil: 0, lastFailAt: now } },
    { upsert: true }
  );
  return { blockedNow: false, failCount };
}

async function recordSuccess(ip) {
  // 성공 시 실패 기록 삭제(깔끔)
  await dbRemove({ ip }, { multi: false });
}

// =====================
// Express / WS
// =====================
const app = express();

// trust proxy는 진짜 프록시 뒤에서만 켜는 게 안전
if (TRUST_PROXY) app.set("trust proxy", true);

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true, trustProxy: TRUST_PROXY }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

function parseQuery(url) {
  try {
    const u = new URL(url, "http://localhost");
    const out = {};
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

wss.on("connection", async (ws, req) => {
  const sock = req.socket;
  console.log("WS IP debug:", {
    remoteAddress: sock.remoteAddress,
    remotePort: sock.remotePort,
    localAddress: sock.localAddress,
    localPort: sock.localPort,
    xff: req.headers["x-forwarded-for"],
    xri: req.headers["x-real-ip"],
  });

  const ip = getClientIp(req);

  try {
    const blk = await isBlocked(ip);
    if (blk.blocked) {
      ws.close(1008, "Blocked");
      return;
    }

    const q = parseQuery(req.url);

    // 토큰 실패 -> 실패 횟수 누적
    if (q.token !== TOKEN) {
      const r = await recordFail(ip);
      if (r.blockedNow) ws.close(1008, "Blocked");
      else ws.close(1008, "Unauthorized");
      return;
    }

    // 토큰 성공 -> 실패 기록 초기화
    await recordSuccess(ip);

    // The browser may disconnect while the database operations are pending.
    if (ws.readyState !== WebSocket.OPEN) return;

    const cols = Math.max(20, Math.min(300, Number(q.cols || 80)));
    const rows = Math.max(5, Math.min(120, Number(q.rows || 24)));
    const shell = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL || "bash");

    const term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME || process.cwd(),
      env: process.env,
    });

    const send = (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    send({ type: "info", message: `connected: ${shell} (${cols}x${rows}) ip=${ip}` });

    term.onData((data) => {
      send({ type: "data", data });
    });

    term.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        send({ type: "info", message: `terminal exited (${exitCode})` });
        ws.close(1000, "Terminal exited");
      }
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.type === "data" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "resize") {
        const c = Number(msg.cols);
        const r = Number(msg.rows);
        if (Number.isFinite(c) && Number.isFinite(r)) {
          term.resize(
            Math.max(20, Math.min(300, c)),
            Math.max(5, Math.min(120, r))
          );
        }
      }
    });

    const kill = () => { try { term.kill(); } catch {} };
    ws.on("close", kill);
    ws.on("error", kill);
  } catch (e) {
    console.error("Terminal connection failed:", e.message);
    try { ws.close(1011, "Server error"); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Web TTY: http://${HOST}:${server.address().port}`);
  console.log(`TRUST_PROXY: ${TRUST_PROXY}`);
  console.log(`Security: maxFails=${SECURITY.maxFails}, blockMs=${SECURITY.blockMs}, windowMs=${SECURITY.windowMs}`);
  console.log(`DB: ${path.join(SECURITY.dbDir, SECURITY.dbFile)}`);
});
