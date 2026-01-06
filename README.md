

# web-terminal

A lightweight **browser-based terminal** powered by Node.js, WebSocket, and `node-pty`.

This project exposes a real system shell to the browser using a WebSocket
connection and a minimal token-based access control.
It is intended for **local, internal, or controlled environments only**.

---

## Features

* Browser-accessible interactive terminal
* WebSocket-based bi-directional communication
* Real PTY-backed system shell
* Shell resize support
* Simple token-based authentication
* Static frontend hosting via Express

---

## Requirements

* Node.js 18+ recommended
* Linux / macOS / Windows
* Compatible shell

  * Linux / macOS: `bash` or `$SHELL`
  * Windows: `powershell.exe`
* Modern browser with WebSocket support

---

## Installation

```bash
npm install express ws node-pty
```

---

## Run

```bash
node server.js
```

By default, the server listens on:

```text
http://0.0.0.0:5894
```

---

## Environment Variables

| Name         | Description             | Default       |
| ------------ | ----------------------- | ------------- |
| `HOST`       | Bind address            | `0.0.0.0`     |
| `PORT`       | HTTP / WebSocket port   | `5894`        |
| `TERM_TOKEN` | Access token (required) | `mStartup!24` |

**You must change `TERM_TOKEN` before any real use.**

---

## Access

The WebSocket endpoint requires a token passed as a query parameter.

```text
/ws?token=<TERM_TOKEN>&cols=80&rows=24
```

Example:

```text
ws://localhost:5894/ws?token=secret123
```

Terminal size can be adjusted dynamically via WebSocket `resize` messages.

---

## Message Protocol

### Client → Server

```json
{ "type": "data", "data": "ls\n" }
```

```json
{ "type": "resize", "cols": 120, "rows": 40 }
```

---

### Server → Client

```json
{ "type": "data", "data": "<terminal output>" }
```

```json
{ "type": "info", "message": "connected: bash (80x24)" }
```

---

## Health Check

```http
GET /health
```

Response:

```json
{ "ok": true }
```

---

## Security Notes

This project **does not provide strong security guarantees**.

Important limitations:

* Token is passed in plaintext query parameters
* No TLS by default
* No user isolation or sandboxing
* Shell runs with the same privileges as the Node.js process
* No audit logging or session control

**Do NOT expose this service to the public internet.**

Recommended usage patterns:

* Localhost only
* SSH tunnel / VPN access
* Reverse proxy with authentication
* Short-lived or disposable environments

---

## Use Cases

* Local development terminal
* Internal admin tools
* Embedded terminal in dashboards
* Remote debugging over SSH tunnels
* Temporary operational access

---

## License

MIT License

---

## Contributing

Pull requests and issues are welcome.

This project intentionally remains minimal and is **not intended as a secure
remote shell replacement**.

---
