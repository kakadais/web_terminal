"""Run on server, with a mode-0600 JSON payload. Existing credentials never print."""
import json
import os
import subprocess
import sys
import urllib.parse

payload_file = os.path.abspath(sys.argv[1])
payload = json.load(open(payload_file))
assert payload['database'] == 'web_terminal'
assert payload['username'] == 'web_terminal_app'
apps = json.load(open(os.path.expanduser('~/.pm2/dump.pm2')))
admin_uri = next((app.get('MONGO_URL') or app.get('env', {}).get('MONGO_URL') for app in apps
                  if 'authSource=admin' in (app.get('MONGO_URL') or app.get('env', {}).get('MONGO_URL') or '')), None)
if not admin_uri:
    raise SystemExit('A MongoDB provisioning administrator is required')
env = os.environ.copy()
env['WEB_TERMINAL_PROVISION_URI'] = admin_uri
env['WEB_TERMINAL_PROVISION_FILE'] = payload_file
script = r'''
const fs = require('fs');
const payload = JSON.parse(fs.readFileSync(process.env.WEB_TERMINAL_PROVISION_FILE, 'utf8'));
const connection = new Mongo(process.env.WEB_TERMINAL_PROVISION_URI);
const admin = connection.getDB('admin');
const roleName = 'web_terminal_read_concern';
const runtimeRole = { role: roleName, db: 'admin' };
if (!admin.getRole(roleName)) {
  admin.createRole({ role: roleName, privileges: [
    { resource: { cluster: true }, actions: ['getDefaultRWConcern'] }
  ], roles: [] });
}
const database = connection.getDB(payload.database);
const existing = database.getUser(payload.username);
if (!existing) {
  database.createUser({ user: payload.username, pwd: payload.password,
    roles: [{ role: 'readWrite', db: payload.database }, runtimeRole] });
  print('Created dedicated web_terminal database user.');
} else {
  const roles = existing.roles;
  if (roles.some(role => !(role.role === 'readWrite' && role.db === payload.database)
    && !(role.role === roleName && role.db === 'admin')))
    throw new Error('Existing application user has unexpected roles');
  database.grantRolesToUser(payload.username, [runtimeRole]);
  print('Dedicated database user already exists; password was preserved.');
}
'''
result = subprocess.run(['mongosh', '--quiet', '--nodb', '--eval', script], env=env,
                        capture_output=True, text=True, timeout=30)
if result.returncode:
    raise SystemExit('Database provisioning failed; existing users were preserved')
print(result.stdout.strip())
uri = 'mongodb://{}:{}@127.0.0.1:27777/web_terminal?authSource=web_terminal&replicaSet=meteor'.format(
    urllib.parse.quote(payload['username'], safe=''), urllib.parse.quote(payload['password'], safe=''))
env['WEB_TERMINAL_PROVISION_URI'] = uri
verification = subprocess.run(['mongosh', '--quiet', '--nodb', '--eval',
    'const c=new Mongo(process.env.WEB_TERMINAL_PROVISION_URI); '
    'print(JSON.stringify(c.getDB("web_terminal").runCommand({ping:1})));'],
    env=env, capture_output=True, text=True, timeout=30)
if verification.returncode:
    raise SystemExit('Application database authentication failed')
print('Application database authentication verified.')
