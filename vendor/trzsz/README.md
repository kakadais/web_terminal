# trzsz protocol core

MIT-licensed sources from [trzsz.js](https://github.com/trzsz/trzsz.js/tree/bac0e5f), version 1.1.6. Only the four protocol modules are vendored: the upstream browser filter hardcodes File System Access pickers, which excludes Safari/Firefox and ordinary browser downloads.

Our browser adapter supplies file readers and streaming download writers. Run `node scripts/build-trzsz.cjs` (Node 24+) after changing these sources; commit the generated `lib/trzsz/*.mjs` too. Runtime dependencies are pinned in package-lock.json. No upstream code is fetched during deployment.

Local changes: negotiate encoded (non-binary) transport for the UTF-8 PTY bridge; await transport writes and file finalization; finalize downloads only after checksum verification; discard partial writers on cleanup; clear receive timers; bound protocol buffers and file metadata. The ordinary OpenSSH executable and its configuration remain unchanged.
