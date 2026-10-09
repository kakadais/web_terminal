"use strict";

const path = require("path");
const dotenv = require("dotenv");

const projectDir = path.resolve(__dirname, "..");
const loaded = dotenv.config({
  path: path.join(projectDir, ".env.local"),
  override: false,
  quiet: true,
});

// Deployments may supply all settings through the process environment.
if (loaded.error && loaded.error.code !== "ENOENT") throw loaded.error;

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 5894);
const TOKEN = process.env.TERM_TOKEN;

if (!TOKEN || !TOKEN.trim()) {
  throw new Error("TERM_TOKEN is required. Set it in .env.local or the process environment.");
}

const TRUST_PROXY =
  String(process.env.TRUST_PROXY || "").toLowerCase() === "true" ||
  String(process.env.TRUST_PROXY || "") === "1";

const SECURITY = {
  maxFails: Number(process.env.TERM_MAX_FAILS || 5),
  blockMs: Number(process.env.TERM_BLOCK_MS || 24 * 60 * 60 * 1000),
  windowMs: Number(process.env.TERM_FAIL_WINDOW_MS || 10 * 60 * 1000),
  dbDir: path.resolve(projectDir, process.env.TERM_DB_DIR || "data"),
  dbFile: process.env.TERM_DB_FILE || "ip_security.db",
};

module.exports = { HOST, PORT, TOKEN, TRUST_PROXY, SECURITY };
