import React, { useEffect, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';

const eventLabels = { 'login-succeeded': '로그인 성공', 'login-failed': '로그인 실패', 'session-resumed': '로그인 재연결',
  'mfa-enabled': '2단계 인증 켜짐', 'mfa-disabled': '2단계 인증 꺼짐', 'all-sessions-revoked': '모든 로그인 종료' };

export default function SecurityDialog({ onClose }) {
  const [status, setStatus] = useState(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Meteor.callAsync('security.status').then(value => { if (active) setStatus(value); })
      .catch(err => { if (active) setError(err.reason || '보안 설정을 불러오지 못했습니다.'); });
    return () => { active = false; };
  }, []);
  const run = async action => {
    setBusy(true); setError('');
    try { await action(); }
    catch (err) { setError(err.reason || '요청을 처리하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const logout = () => new Promise(resolve => Meteor.logout(() => { onClose(); resolve(); }));
  const begin = () => run(async () => {
    const value = await Meteor.callAsync('security.beginMfa', Accounts._hashPassword(password));
    setSetup(value); setPassword(''); setCode('');
  });
  const confirm = event => {
    event.preventDefault();
    if (!saved) return;
    run(async () => { await Meteor.callAsync('security.confirmMfa', setup.id, code.trim()); await logout(); });
  };
  const disable = () => run(async () => {
    await Meteor.callAsync('security.disableMfa', Accounts._hashPassword(password), code.trim()); await logout();
  });
  const logoutAll = () => run(async () => {
    await Meteor.callAsync('security.logoutAll', Accounts._hashPassword(password), code.trim()); await logout();
  });
  return <div className="modal-backdrop"><section className="dialog security-dialog" role="dialog" aria-label="계정 보안" aria-modal="true">
    <div className="dialog-heading"><h2>계정 보안</h2><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="닫기">×</button></div>
    {status && <><h3>2단계 인증 · {status.enabled ? '사용 중' : '꺼짐'}</h3>
      <p className="hint">인증 앱으로 로그인 코드를 확인합니다. 설정을 바꾸면 이 창을 포함한 모든 로그인이 종료됩니다.</p>
      {setup ? <form onSubmit={confirm}>
        <p>인증 앱에서 QR 코드를 스캔하세요.</p>
        <img className="mfa-qr" src={setup.qr} alt="인증 앱 등록 QR 코드" width="220" height="220" />
        <details><summary>직접 입력할 등록 키</summary><code className="mfa-secret">{setup.secret}</code></details>
        <h3>복구 코드</h3><p className="hint">인증 앱을 잃어버렸을 때 비밀번호와 함께 사용할 수 있습니다. 각 코드는 한 번만 사용할 수 있으니 비밀번호 관리자 등 안전한 곳에 보관하세요. 이 목록은 다시 표시되지 않습니다.</p>
        <pre className="recovery-codes">{setup.codes.join('\n')}</pre>
        <label className="check-label"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />복구 코드를 안전한 곳에 저장했습니다</label>
        <label>인증 코드<input autoComplete="one-time-code" inputMode="numeric" value={code} onChange={e => setCode(e.target.value)} required pattern="[0-9]{6}" maxLength={6} /></label>
        <p className="hint">등록은 10분 안에 완료해 주세요. 완료 후에는 인증 앱의 다음 코드로 로그인하세요.</p>
        <button className="primary full" disabled={busy || !saved}>2단계 인증 켜기</button>
      </form> : <>
        {status.enabled && <p>남은 복구 코드: {status.recoveryRemaining}개</p>}
        <label>현재 비밀번호<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} maxLength={256} /></label>
        {status.enabled && <label>인증 코드 또는 복구 코드<input autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} maxLength={40} /></label>}
        <div className="dialog-actions">
          {status.enabled ? <button className="danger" onClick={disable} disabled={busy || !password || !code}>2단계 인증 끄기</button>
            : <button className="primary" onClick={begin} disabled={busy || !password}>인증 앱 등록</button>}
          <button onClick={logoutAll} disabled={busy || !password || (status.enabled && !code)}>모든 기기 로그아웃</button>
        </div>
        <h3>최근 로그인 기록</h3><p className="hint">최근 7일의 기록 중 최대 12개를 표시합니다.</p>
        <ul className="security-events">{status.events.map(item => <li key={item._id}><span>{eventLabels[item.event] || item.event}</span><small>{new Date(item.at).toLocaleString()} · {item.ip}</small></li>)}</ul>
      </>}
    </>}
    {!status && !error && <p>불러오는 중…</p>}
    {error && <div role="alert" className="error">{error}</div>}
  </section></div>;
}
