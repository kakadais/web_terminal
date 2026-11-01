function startEnvironment(fileEnv, inheritedEnv, development) {
  const env = { ...fileEnv, ...inheritedEnv };
  if (development) {
    // Use Meteor's separate local MongoDB, never the production database.
    delete env.MONGO_URL;
    delete env.MONGO_OPLOG_URL;
    env.PORT = env.DEV_PORT || '5160';
    env.BIND_IP = '127.0.0.1';
    env.ROOT_URL = `http://127.0.0.1:${env.PORT}`;
    env.HTTP_FORWARDED_COUNT = '0';
    // Production's dotenv path must not replace this machine's SSH trust store.
    // An empty value also prevents server/config.js from reloading that path.
    env.SSH_KNOWN_HOSTS_PATH = env.DEV_SSH_KNOWN_HOSTS_PATH ?? inheritedEnv.SSH_KNOWN_HOSTS_PATH ?? '';
  }
  return env;
}

module.exports = { startEnvironment };
