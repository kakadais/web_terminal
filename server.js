"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const pty = require("node-pty");

const HOST = process.env.HOST || "0.0.0.0"; // 외부 공개 금지: 기본 localhost
const PORT = Number(process.env.PORT || 5894);
const TOKEN = process.env.TERM_TOKEN || "mStartup!24"; // 반드시 변경

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

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

wss.on("connection", (ws, req) => {
  const q = parseQuery(req.url);
  if (q.token !== TOKEN) {
    ws.close(1008, "Unauthorized");
    return;
  }

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

  send({ type: "info", message: `connected: ${shell} (${cols}x${rows})` });

  term.on("data", (data) => {
    // 터미널 출력 -> 브라우저
    send({ type: "data", data });
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "data" && typeof msg.data === "string") {
      // 브라우저 입력 -> 터미널
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

  ws.on("close", () => {
    try { term.kill(); } catch {}
  });

  ws.on("error", () => {
    try { term.kill(); } catch {}
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Web TTY: http://${HOST}:${PORT}`);
  console.log(`TOKEN: ${TOKEN}`);
  console.log(`Tip: TERM_TOKEN=... HOST=127.0.0.1 PORT=${PORT} node server.js`);
});

