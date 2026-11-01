function allowedOrigins(rootUrl, development = false) {
  const root = new URL(rootUrl);
  const origins = new Set([root.origin]);
  // Meteor advertises localhost while the dev launcher binds to 127.0.0.1.
  // Keep the protocol and port fixed; never trust Host or forwarded headers.
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  if (development && loopback.includes(root.hostname)) {
    for (const hostname of loopback) {
      const local = new URL(root);
      local.hostname = hostname;
      origins.add(local.origin);
    }
  }
  return origins;
}

module.exports = { allowedOrigins };
