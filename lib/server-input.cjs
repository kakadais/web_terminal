function validateServer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('서버 정보를 입력해 주세요.');
  const name = String(input.name || '').trim();
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const port = Number(input.port ?? 22);
  const authType = input.authType;
  if (!name || name.length > 100) throw new Error('서버 이름은 1~100자로 입력해 주세요.');
  if (!host || host.length > 253 || !/^[a-zA-Z0-9_.:\-]+$/.test(host) || host.startsWith('-')) throw new Error('유효한 호스트 주소를 입력해 주세요.');
  if (!username || username.length > 100 || !/^[a-zA-Z0-9_.\-]+$/.test(username) || username.startsWith('-')) throw new Error('유효한 SSH 사용자 이름을 입력해 주세요.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('포트는 1~65535로 입력해 주세요.');
  if (!['config', 'password', 'key'].includes(authType)) throw new Error('인증 방식을 선택해 주세요.');
  const password = String(input.password || '');
  const privateKey = String(input.privateKey || '').trim();
  const passphrase = String(input.passphrase || '');
  if (password.length > 8192 || passphrase.length > 8192 || privateKey.length > 65536) throw new Error('접속 정보가 너무 큽니다.');
  if (privateKey && !/^-----BEGIN (OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(privateKey)) throw new Error('SSH 개인 키 파일을 등록해 주세요. 공개 키는 접속에 사용할 수 없습니다.');
  return { name, host, username, port, authType, password, privateKey: privateKey ? `${privateKey}\n` : '', passphrase };
}

module.exports = { validateServer };
