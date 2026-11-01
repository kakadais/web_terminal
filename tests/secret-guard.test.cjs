const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const guard=path.resolve(__dirname,'../scripts/check-secrets.cjs');
test('staged secret guard reads staged bytes, rejects actual local secrets, and redacts diagnostics',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-secret-guard-'));
 const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});
 const run=()=>spawnSync(process.execPath,[guard],{cwd:dir,encoding:'utf8'});
 try{
  git('init','-q');const secret=crypto.randomBytes(32).toString('hex');const key=['ADMIN','PASSWORD'].join('_');fs.writeFileSync(path.join(dir,'.env.local'),key+'='+secret+'\n');
  fs.writeFileSync(path.join(dir,'app.js'),'export const value='+JSON.stringify(secret));git('add','app.js');
  fs.writeFileSync(path.join(dir,'app.js'),'export const value="clean working copy"');
  let r=run();assert.equal(r.status,1);assert.equal((r.stdout+r.stderr).includes(secret),false);
  git('add','app.js');r=run();assert.equal(r.status,0);
  fs.writeFileSync(path.join(dir,'.env.example'),key+'="CHANGE_ME"\n');git('add','.env.example');assert.equal(run().status,0);
  git('add','.env.local');assert.equal(run().status,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
