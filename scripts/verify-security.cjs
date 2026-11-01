// Destructive authentication checks: run ONLY against a disposable local QA database.
const fs=require('node:fs'),assert=require('node:assert/strict');const {chromium}=require('playwright-core');const {authenticator}=require('../lib/auth-security.cjs');
const env=require('dotenv').parse(fs.readFileSync(process.env.ENV_FILE || '.env.local'));
const url=process.env.VERIFY_URL || 'http://127.0.0.1:5176';
const target=new URL(url);
if(process.env.VERIFY_AUTH_ISOLATED!=='1' || !['127.0.0.1','localhost'].includes(target.hostname) || !target.port || target.port==='5160') {
  throw Error('Use VERIFY_AUTH_ISOLATED=1 with a disposable local database and a separate port. This test changes MFA and revokes sessions.');
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const context=await b.newContext();const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));const response=await p.goto(url);await p.waitForFunction(()=>globalThis.Meteor?.status().connected);assert.match(response.headers()['content-security-policy'],/script-src 'self'/);
 const login=async(page,password=env.ADMIN_PASSWORD,code)=>{for(let retry=0;retry<3;retry++){const result=await page.evaluate(({username,password,code})=>new Promise(r=>{const cb=e=>r({ok:!e,code:e?.error});if(code)Meteor.loginWithPasswordAnd2faCode(username,password,code,cb);else Meteor.loginWithPassword(username,password,cb)}),{username:env.ADMIN_USERNAME,password,code});if(result.code!=='too-many-requests')return result;await delay(61000)}throw Error('Rate-limit retries exhausted')};
 const call=(page,name,...args)=>page.evaluate(({name,args})=>Meteor.callAsync(name,...args).then(value=>({ok:true,value}),e=>({ok:false,code:e.error})),{name,args});
 const digest=await p.evaluate(password=>Package['accounts-base'].Accounts._hashPassword(password),env.ADMIN_PASSWORD);
 assert.equal((await call(p,'security.status')).ok,false);assert.equal((await call(p,'servers.sync')).ok,false);
 assert.equal((await login(p,'incorrect-password-for-qa')).ok,false);assert.equal((await login(p)).ok,true);
 let st=(await call(p,'security.status')).value;assert.equal(st.enabled,false);
 assert.equal(await p.evaluate(()=>localStorage.getItem('Meteor.loginToken')),null);assert.ok(await p.evaluate(()=>sessionStorage.getItem('Meteor.loginToken')));
 await p.reload();await p.waitForFunction(()=>Meteor.userId());console.log('PASS login, private methods, session storage and reload');
 const q=await p.context().newPage();await q.goto(url);await q.waitForFunction(()=>globalThis.Meteor?.status().connected);assert.equal(await q.evaluate(()=>Meteor.userId()),null);assert.equal((await login(q)).ok,true);
 const oldToken=await p.evaluate(()=>sessionStorage.getItem('Meteor.loginToken'));
 await p.evaluate(()=>{const s=document.createElement('script');s.textContent='window.__securityInlineExecuted=true';document.head.appendChild(s)});assert.equal(await p.evaluate(()=>window.__securityInlineExecuted),undefined);
 await p.getByRole('button',{name:'계정 보안',exact:true}).click();await p.getByLabel('현재 비밀번호',{exact:true}).fill(env.ADMIN_PASSWORD);await p.getByRole('button',{name:'인증 앱 등록',exact:true}).click();
 await p.locator('.recovery-codes').waitFor();const codes=(await p.locator('.recovery-codes').innerText()).split('\n');const secret=await p.locator('.mfa-secret').textContent();assert.equal(codes.length,10);assert.ok(await p.locator('.mfa-qr').evaluate(img=>img.complete&&img.naturalWidth>0));
 assert.equal(await p.evaluate(()=>Boolean(Meteor.user().services)),false);
 await p.getByLabel('복구 코드를 안전한 곳에 저장했습니다').check();await p.getByLabel('인증 코드',{exact:true}).fill(authenticator(secret).generate());await p.getByRole('button',{name:'2단계 인증 켜기',exact:true}).click();
 await p.waitForFunction(()=>!Meteor.userId());await q.waitForFunction(()=>!Meteor.userId());
 const resumed=await q.evaluate(token=>new Promise(r=>Meteor.loginWithToken(token,e=>r(!e))),oldToken);assert.equal(resumed,false);
 assert.equal((await login(p)).code,'mfa-required');assert.equal((await login(p,env.ADMIN_PASSWORD,'invalid-code')).ok,false);
 assert.equal((await login(p,env.ADMIN_PASSWORD,codes[0])).ok,true);assert.equal((await call(p,'security.status')).value.recoveryRemaining,9);
 await p.evaluate(()=>new Promise(r=>Meteor.logout(r)));assert.equal((await login(p,env.ADMIN_PASSWORD,codes[0])).ok,false);console.log('PASS enrollment flow, old sessions revoked, factor required, recovery code single use');
 await delay(61000);
 const concurrent=await Promise.all([login(p,env.ADMIN_PASSWORD,codes[1]),login(q,env.ADMIN_PASSWORD,codes[1])]);assert.equal(concurrent.filter(x=>x.ok).length,1);const logged=concurrent[0].ok?p:q;const other=concurrent[0].ok?q:p;
 const otp=authenticator(secret).generate();assert.equal((await login(other,env.ADMIN_PASSWORD,otp)).ok,true);await other.evaluate(()=>new Promise(r=>Meteor.logout(r)));assert.equal((await login(other,env.ADMIN_PASSWORD,otp)).ok,false);
 const noFactor=await call(logged,'security.disableMfa',digest,'invalid-code');assert.equal(noFactor.ok,false);
 const disabled=await call(logged,'security.disableMfa',digest,codes[2]);assert.equal(disabled.ok,true);await logged.evaluate(()=>new Promise(r=>Meteor.logout(r)));await logged.waitForFunction(()=>!Meteor.userId());console.log('PASS concurrent recovery consumption, TOTP replay rejection and reauthenticated disable');
 assert.equal((await login(p)).ok,true);assert.equal((await call(p,'security.status')).value.enabled,false);assert.equal((await login(q)).ok,true);
 assert.equal((await call(p,'security.logoutAll',digest,'')).ok,true);await p.evaluate(()=>new Promise(r=>Meteor.logout(r)));await p.waitForFunction(()=>!Meteor.userId());await q.waitForFunction(()=>!Meteor.userId());console.log('PASS all-device logout');
 await delay(61000);
 const failures=[];for(let n=0;n<12;n++){const c=await b.newPage();await c.goto(url);await c.waitForFunction(()=>globalThis.Meteor?.status().connected);failures.push(await c.evaluate(({username})=>new Promise(r=>Meteor.loginWithPassword(username,'incorrect-password-for-qa',e=>r(e?.error))),{username:env.ADMIN_USERNAME}));await c.close()}
 assert.ok(failures.includes('too-many-requests'));assert.equal(errors.length,0,errors.join('\n'));console.log('PASS rate limiting across new connections; no browser exceptions');
}finally{await b.close()}})().catch(e=>{console.error(e.stack);process.exitCode=1});
