"use strict";

const fs = require("fs");
const path = require("path");
const pty = require("node-pty");

function prepareSpawnHelper() {
  if (process.platform !== "darwin") return;

  const libDir = path.dirname(require.resolve("node-pty"));
  const utils = require(path.join(libDir, "utils.js"));
  let nativeDir;

  if (typeof utils.loadNativeModule === "function") {
    // Use the same native binary directory that node-pty selected.
    nativeDir = utils.loadNativeModule("pty").dir;
  } else {
    // node-pty 1.0 loads Release first, then Debug.
    for (const dir of ["../build/Release", "../build/Debug"]) {
      try {
        require(path.resolve(libDir, dir, "pty.node"));
        nativeDir = dir;
        break;
      } catch (_) {}
    }
  }

  if (!nativeDir) throw new Error("Cannot locate node-pty's native binary");

  const helper = path.resolve(libDir, nativeDir, "spawn-helper");
  const mode = fs.statSync(helper).mode;
  try {
    fs.accessSync(helper, fs.constants.X_OK);
  } catch (_) {
    // Some macOS packages install spawn-helper with mode 0644.
    fs.chmodSync(helper, mode | 0o111);
    fs.accessSync(helper, fs.constants.X_OK);
  }
}

function spawn(file, args, options) {
  prepareSpawnHelper();
  return pty.spawn(file, args, options);
}

module.exports = { spawn };
