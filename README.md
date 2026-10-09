

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
npm ci
```

Install dependencies on the machine that runs the service. `node_modules` is
not tracked because node-pty includes native binaries for the host platform.

---

## Run

For a new environment, create the local configuration once:

```bash
cp .env.example .env.local
```

Set `TERM_TOKEN` in `.env.local`, then start the server:

```bash
node server.js
```

Use `node server_blacklist.js` to enable persistent IP failure limits.

The shell runs on the machine hosting this Node.js process. To use a remote
server's shell, run the service on that server or run `ssh` inside the terminal.

On macOS, startup restores the executable permission of node-pty's
`spawn-helper` when needed. Without that permission, a valid token can still
result in `closed (1011)` with `posix_spawnp failed` in the server log.
Other startup failures are logged; exiting the shell closes the terminal
connection normally. A `closed (1008)` response means `Unauthorized` or
`Blocked`, as shown in the close reason.

By default, the server listens on:

```text
http://0.0.0.0:5894
```

---

## Environment Variables

Both server entrypoints automatically load the project-root `.env.local`, even
when launched from another working directory. Existing process environment
variables take precedence over file values. The loader uses
[dotenv](https://github.com/motdotla/dotenv).

`.env.local` contains each environment's actual settings and is ignored by Git.
`.env.example` is the tracked deployment reference and contains no actual token.
The server refuses to start if `TERM_TOKEN` is missing or blank.

| Name                  | Description                               | Default          |
| --------------------- | ----------------------------------------- | ---------------- |
| `HOST`                | Bind address                              | `0.0.0.0`        |
| `PORT`                | HTTP / WebSocket port                     | `5894`           |
| `TERM_TOKEN`          | Required access token                     | No default       |
| `TRUST_PROXY`         | Trust client IP headers behind a proxy    | `false`          |
| `TERM_MAX_FAILS`      | Failed tokens before an IP is blocked     | `5`              |
| `TERM_BLOCK_MS`       | IP block duration in milliseconds         | `86400000`       |
| `TERM_FAIL_WINDOW_MS` | Failure counting window in milliseconds   | `600000`         |
| `TERM_DB_DIR`         | Security DB directory, relative to root   | `./data`         |
| `TERM_DB_FILE`        | Security DB filename                      | `ip_security.db` |

Proxy and IP block settings are used by `server_blacklist.js`. The shell and
home directory use the host's `SHELL` and `HOME`; Windows uses `powershell.exe`.

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
