const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedOrigins } = require('../lib/request-origin.cjs');
const { startEnvironment } = require('../scripts/start-env.cjs');

test('development accepts loopback origins on the configured protocol and port only', () => {
  const origins = allowedOrigins('http://127.0.0.1:5160', true);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.ok(origins.has(`http://${host}:5160`));
  for (const origin of [undefined, null, 'null', 'http://localhost:5161', 'https://localhost:5160',
    'http://localhost.evil.test:5160', 'http://192.168.1.4:5160', 'http://127.0.0.2:5160']) {
    assert.ok(!origins.has(origin), String(origin));
  }
  assert.deepEqual(allowedOrigins('http://localhost:5160', true), origins);
});

test('production and non-loopback roots keep a single exact allowed origin', () => {
  for (const development of [false, true]) {
    assert.deepEqual([...allowedOrigins('https://terminal.example.com/path', development)], ['https://terminal.example.com']);
  }
  assert.deepEqual([...allowedOrigins('http://127.0.0.1:5160')], ['http://127.0.0.1:5160']);
});

test('dev isolates production DB and known_hosts while preserving the SSH config and agent', () => {
  const fileEnv = { MONGO_URL: 'mongodb://production/db', MONGO_OPLOG_URL: 'mongodb://production/local',
    PORT: '80', BIND_IP: '192.168.1.4', ROOT_URL: 'https://terminal.example.com', HTTP_FORWARDED_COUNT: '1',
    SSH_CONFIG_PATH: '~/.config/ssh/config', SSH_KNOWN_HOSTS_PATH: '~/deploy/shared/known_hosts' };
  const inheritedEnv = { SSH_AUTH_SOCK: '/tmp/custom-agent', XDG_CONFIG_HOME: '/tmp/custom-config', DEV_PORT: '5169' };
  const env = startEnvironment(fileEnv, inheritedEnv, true);
  assert.equal(env.MONGO_URL, undefined);
  assert.equal(env.MONGO_OPLOG_URL, undefined);
  assert.equal(env.ROOT_URL, 'http://127.0.0.1:5169');
  assert.equal(env.BIND_IP, '127.0.0.1');
  assert.equal(env.HTTP_FORWARDED_COUNT, '0');
  assert.equal(env.SSH_KNOWN_HOSTS_PATH, '');
  assert.equal(env.SSH_CONFIG_PATH, fileEnv.SSH_CONFIG_PATH);
  assert.equal(env.SSH_AUTH_SOCK, inheritedEnv.SSH_AUTH_SOCK);
  assert.equal(env.XDG_CONFIG_HOME, inheritedEnv.XDG_CONFIG_HOME);
  assert.equal(fileEnv.SSH_KNOWN_HOSTS_PATH, '~/deploy/shared/known_hosts');
  assert.equal(startEnvironment(fileEnv, { SSH_KNOWN_HOSTS_PATH: '/tmp/explicit' }, true).SSH_KNOWN_HOSTS_PATH, '/tmp/explicit');
  assert.equal(startEnvironment({ ...fileEnv, DEV_SSH_KNOWN_HOSTS_PATH: '/tmp/dev' }, {}, true).SSH_KNOWN_HOSTS_PATH, '/tmp/dev');
  assert.equal(startEnvironment({ ...fileEnv, DEV_SSH_KNOWN_HOSTS_PATH: '/tmp/dev' },
    { SSH_KNOWN_HOSTS_PATH: '/tmp/explicit' }, true).SSH_KNOWN_HOSTS_PATH, '/tmp/dev');
  assert.equal(startEnvironment(fileEnv, {}, false).SSH_KNOWN_HOSTS_PATH, fileEnv.SSH_KNOWN_HOSTS_PATH);
  assert.equal(startEnvironment(fileEnv, {}, false).MONGO_URL, fileEnv.MONGO_URL);
});
