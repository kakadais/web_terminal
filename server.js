"use strict";

const { HOST, PORT, TOKEN } = require("./lib/config");
const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const pty = require("./lib/pty");

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

  let term;
  try {
    term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME || process.cwd(),
      env: process.env,
    });
  } catch (err) {
    console.error("Terminal startup failed:", err.message);
    ws.close(1011, "Unable to start terminal");
    return;
  }

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  send({ type: "info", message: `connected: ${shell} (${cols}x${rows})` });

  term.onData((data) => {
    // 터미널 출력 -> 브라우저
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
  console.log(`Web TTY: http://${HOST}:${server.address().port}`);
  console.log(`Tip: HOST=127.0.0.1 PORT=${server.address().port} node server.js`);
});
