// Consume just the private PID handshake; pass all other terminal bytes unchanged.
function createPidTracker(token, onPid) {
  const prefix = `\x1b]777;web-terminal;${token};pid;`;
  let pending = '';
  return {
    push(data) {
      pending += data;
      let output = '';
      while (pending) {
        const start = pending.indexOf(prefix);
        if (start < 0) {
          let keep = Math.min(prefix.length - 1, pending.length);
          while (keep && !prefix.startsWith(pending.slice(-keep))) keep--;
          output += pending.slice(0, pending.length - keep); pending = pending.slice(pending.length - keep); break;
        }
        output += pending.slice(0, start); pending = pending.slice(start);
        const end = pending.indexOf('\x07', prefix.length);
        if (end < 0) {
          if (pending.length > prefix.length + 32) { output += pending[0]; pending = pending.slice(1); continue; }
          break;
        }
        const value = pending.slice(prefix.length, end);
        if (/^[1-9][0-9]{0,9}$/.test(value) && Number(value) < 2147483648) onPid(Number(value));
        else output += pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
      }
      return output;
    },
    flush() { const remaining = pending; pending = ''; return remaining; },
  };
}
module.exports = { createPidTracker };
