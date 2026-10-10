function terminalEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const name of Object.keys(env)) {
    if (/^(ADMIN_|MONGO_|CREDENTIAL_|MAIL_URL|METEOR_SETTINGS|TERM_TOKEN|WEB_TERMINAL_)/.test(name)) delete env[name];
  }
  return env;
}
module.exports = { terminalEnv };
