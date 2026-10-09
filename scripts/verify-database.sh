#!/usr/bin/env bash
set -euo pipefail
ssh server bash -s <<'REMOTE_VERIFY'
set -euo pipefail
set -a
source "$HOME/deploy/web_terminal/current/.runtime.env"
set +a
mongosh --quiet --nodb --eval '
const connection = new Mongo(process.env.MONGO_URL);
const database = connection.getDB("web_terminal");
const user = database.users.findOne({ username: process.env.ADMIN_USERNAME });
if (!user || !user.services?.password?.bcrypt) throw new Error("Administrator password hash missing");
if (JSON.stringify(user).includes(process.env.ADMIN_PASSWORD)) throw new Error("Plaintext login password found");
const aliases = database.servers.find({ source: "config" }).toArray();
if (aliases.length === 0) throw new Error("SSH config data missing");
const manual = database.servers.find({ name: { $in: ["__verify_password", "__verify_key"] } }).toArray();
if (manual.length !== 2) throw new Error("Both SSH test records must exist for storage verification");
for (const server of manual) {
  const required = server.authType === "password" ? ["password"] : ["privateKey", "passphrase"];
  for (const name of required) {
    const credential = server.credentials?.[name];
    if (!credential || credential.version !== 1 || !credential.iv || !credential.tag || !credential.data)
      throw new Error("Encrypted credential format missing");
  }
  if (JSON.stringify(server.credentials).includes("PRIVATE KEY")) throw new Error("Plaintext key found");
}
const history = database.connection_history.countDocuments({ serverName: /^__verify/ });
if (history < 2) throw new Error("SSH session history missing");
print(JSON.stringify({ database: "web_terminal", configServers: aliases.length,
  encryptedManualServers: manual.length, adminPasswordHashed: true, sessionHistoryVerified: true }));
'
REMOTE_VERIFY
