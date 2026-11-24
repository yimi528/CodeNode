'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {AcpBackend}=require('../../electron/backends/acp.cjs');

const settings=require('../../electron/backends/settings.cjs');
const config=require('../../config/agent.backends.json');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-multi-backend-'));
const fixture=path.join(__dirname,'../fixtures/acp-basic.cjs');
class FixtureRpc{
  constructor(_command,_args,cwd,options={}){const protocol=options.env?.FIXTURE_PROTOCOL||'';const Rpc=require('../../electron/backends/stdioRpc.cjs').StdioRpc;this.inner=new Rpc(process.execPath,[fixture],cwd,{...options,spawn:(_f,_a,opts)=>spawn(process.execPath,[fixture],{...opts,env:{...opts.env,FIXTURE_PROTOCOL:protocol}})});}
  on(event,listener){this.inner.on(event,listener);return this;} request(method,params,timeout){return this.inner.request(method,params,timeout)} send(message){return this.inner.send(message)} respond(id,result){return this.inner.respond(id,result)} close(){return this.inner.close()} get proxySource(){return this.inner.proxySource}
}
async function main(){
  const data=path.join(root,'userdata');
  for(const backend of config.backends){const value=settings.normalize({...config.defaults,backend,executable:config.commands[backend]||'fixture'});assert.equal(value.backend,backend);}
  const diagnosticRpc=new FixtureRpc('fixture',root);
  try{await assert.rejects(diagnosticRpc.request('error-test'),error=>{const diagnostic=/** @type {any} */ (error);return diagnostic.code===-32001&&diagnostic.method==='error-test'&&diagnostic.data?.detail==='preserve diagnostic';},'JSON-RPC error code, method and data should survive transport for actionable backend diagnostics');}
  finally{await diagnosticRpc.close();}
  for(const backend of config.acpBackends){
    const available=await new AcpBackend({...config.defaults,backend,executable:'fixture'} ,{StdioRpc:FixtureRpc}).capabilities(root);
    assert.equal(available.available,true,backend+' ACP initialization');assert.equal(available.protocol,'ACP');
  }
  const acpSettings={...config.defaults,backend:'opencode',executable:'fixture',args:['acp'],sandbox:'workspace-write'};
  const createBackend = require('../../electron/backends/index.cjs').createBackend;
  assert.deepEqual(createBackend('hermes').driver.command().args, ['acp']);
  const envFixture = env => ({ StdioRpc: class extends FixtureRpc {
    constructor(command, args, cwd, options) { super(command,args,cwd,{...options, env}); }
  } });
  const authPort = createBackend('opencode', acpSettings, envFixture({FIXTURE_SESSION_AUTH:'1'}));
  try {
    const status = await authPort.health({projectRoot:root, checkSession:true});
    assert.equal(status.available,false);
    assert.equal(status.sessionReady,false);
    assert.match(status.error,/需要登录/);
  } finally { await authPort.close(); }
  const old = {projectRoot:root, prompt:'Reply to this turn', backendSession:{sessionId:'old-session'},
    history:[{role:'assistant',content:'Prior exchange'}], confirm:async()=>false};
  const replay = await new AcpBackend(acpSettings,envFixture({FIXTURE_REPLAY:'1'})).run(old);
  assert.equal(replay.state,'COMPLETED');
  assert.equal(replay.content,'ACP_RUNTIME_OK');
  const legacy = envFixture({FIXTURE_NO_RESTORE:'1'});
  const continued = await new AcpBackend(acpSettings,legacy).run({...old,allowHistoryContinuation:true});
  assert.equal(continued.state,'COMPLETED');
  assert.equal(continued.backendSession.sessionId,'acp-fixture');
  const cannotResume = await new AcpBackend(acpSettings,legacy).run(old);
  assert.equal(cannotResume.stopReason,'backend_start_failed');

  if(process.platform!=='win32'){
    const profileRoot = path.join(root,'profiles');
    const source = path.join(root,'codex-user');
    fs.mkdirSync(profileRoot);fs.mkdirSync(source);
    const nativeConfig=path.join(source,'config.toml');fs.writeFileSync(nativeConfig,'# fixture');
    const policy={externalAgent:true,agentRuntimeDir:profileRoot,writeRoots:[profileRoot]};
    const runtime = require('../../electron/backends/runtimeProfile.cjs').runtimeEnvironment;
    const result=runtime({backend:'codex',executable:'codex-acp'},policy,{CODEX_HOME:source});
    assert.equal(fs.realpathSync(path.join(result.CODEX_HOME,'config.toml')),fs.realpathSync(nativeConfig));
    assert.deepEqual(runtime({backend:'codex',executable:'custom-wrapper'},policy,{CODEX_HOME:source}),{});
    assert.deepEqual(runtime({backend:'codex',executable:'codex-acp'},{...policy,writeRoots:[root]},{CODEX_HOME:source}),{});
  }
  const deltas=[];const acp=new AcpBackend(acpSettings,{StdioRpc:FixtureRpc});
  const acpResult=await acp.run({projectRoot:root,prompt:'Say hello',onDelta:d=>deltas.push(d),confirm:async()=>true});
  assert.equal(acpResult.state,'COMPLETED');assert.match(acpResult.content,/ACP_RUNTIME_OK/);
  assert.equal(acpResult.backendSession.sessionId,'acp-fixture');
  assert(deltas.some(d=>d.kind==='content'));assert(deltas.some(d=>d.kind==='tool_result')===false);
  let failConnect=false;
  const reusedAcp=new AcpBackend(acpSettings,{StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){if(failConnect)throw new Error('fixture connection failed');super(c,a,w,o);}}});
  assert.equal((await reusedAcp.run({projectRoot:root,prompt:'First session',confirm:async()=>false})).state,'COMPLETED');
  failConnect=true;
  assert.equal((await reusedAcp.run({projectRoot:root,prompt:'New connection',confirm:async()=>false})).stopReason,'backend_start_failed','old ACP session cannot misclassify a new connection failure as an unknown dispatched run');
  const openclawSessionParams=path.join(root,'openclaw-session-params.json');
  const openclaw=new AcpBackend({...acpSettings,backend:'openclaw'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_SESSION_PARAMS:openclawSessionParams}})}}});
  const openclawResult=await openclaw.run({projectRoot:root,prompt:'Gateway bridge',confirm:async()=>false});
  assert.equal(openclawResult.state,'COMPLETED');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(openclawSessionParams,'utf8')).params,'mcpServers'),false,'OpenClaw rejects even an empty per-session mcpServers field');
  const legacyOpenclawParams=path.join(root,'openclaw-legacy-session-params.json');
  const legacyOpenclaw=new AcpBackend({...acpSettings,backend:'openclaw'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_REQUIRE_MCP_SERVERS:'1',FIXTURE_SESSION_PARAMS:legacyOpenclawParams}})}}});
  const legacyOpenclawResult=await legacyOpenclaw.run({projectRoot:root,prompt:'Legacy gateway bridge',confirm:async()=>false});
  assert.equal(legacyOpenclawResult.state,'COMPLETED','older OpenClaw schema retries only after its explicit missing-mcpServers error');
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyOpenclawParams,'utf8')).params.mcpServers,[],'legacy retry supplies an empty MCP list');
  const permissionResponse=path.join(root,'acp-permission-response.json');
  const readonly=new AcpBackend({...acpSettings,backend:'hermes',sandbox:'read-only'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_PERMISSION:'1',FIXTURE_PERMISSION_RESPONSE:permissionResponse}})}}});
  let approved=false;
  const readonlyResult=await readonly.run({projectRoot:root,prompt:'Read',confirm:async()=>{approved=true;return true;}});
  assert.equal(readonlyResult.state,'COMPLETED');assert.equal(approved,false,'read-only must decline a permission escalation without showing approval');
  assert.equal(JSON.parse(fs.readFileSync(permissionResponse,'utf8')).outcome.optionId,'deny','ACP read metadata cannot self-authorize a permission request');
  const writable=new AcpBackend({...acpSettings,backend:'opencode',sandbox:'workspace-write'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_PERMISSION:'1'}})}}});
  const writeResult=await writable.run({projectRoot:root,prompt:'Read',confirm:async()=>true});
  assert.equal(writeResult.state,'COMPLETED');
  for(const backend of config.acpBackends){const port=require('../../electron/backends/index.cjs').createBackend(backend,{...acpSettings,backend});assert.equal(port.describe().transport,'acp');}
  // Pi ships no sandbox and pi-acp never sends session/request_permission, so the
  // read-only policy is reported as unenforceable instead of silently pretended.
  const piDeltas=[];
  const piReadOnly=new AcpBackend({...acpSettings,backend:'pi',sandbox:'read-only'},{StdioRpc:FixtureRpc});
  const piResult=await piReadOnly.run({projectRoot:root,prompt:'Read',onDelta:delta=>piDeltas.push(delta),confirm:async()=>true});
  assert.equal(piResult.state,'COMPLETED');
  const piWarning=piDeltas.find(delta=>delta.kind==='backend_info'&&delta.info?.permissionEnforcement==='unavailable');
  assert(piWarning,'pi must report that ACP permission requests are unavailable before it runs');
  assert.match(piWarning.info.warning,/只读/);
  assert.equal((await new AcpBackend({...acpSettings,backend:'pi',executable:'fixture'},{StdioRpc:FixtureRpc}).capabilities(root)).permissionEnforcement,'unavailable');
  assert.equal((await new AcpBackend({...acpSettings,backend:'opencode',executable:'fixture'},{StdioRpc:FixtureRpc}).capabilities(root)).permissionEnforcement,'acp-requests');
  assert.equal(require('../../electron/backends/index.cjs').createBackend('pi',{...acpSettings,backend:'pi'}).describe().capabilities.permissions,false,'BackendPort must not claim enforceable permissions for pi');
  // Windows npm shims and documented launch-name aliases must both resolve.
  const binDir=path.join(root,'bin');fs.mkdirSync(binDir,{recursive:true});
  const {resolveCommand}=require('../../electron/backends/stdioRpc.cjs');
  const windowsPath=process.platform==='win32';
  if(windowsPath){
    const pkgDir=path.join(binDir,'node_modules','qoder');fs.mkdirSync(pkgDir,{recursive:true});fs.writeFileSync(path.join(pkgDir,'cli.js'),'#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(binDir,'qoder.cmd'),'@ECHO off\n:start\nSETLOCAL\nCALL :find_dp0\n"%_prog%"  "%dp0%\\node_modules\\qoder\\cli.js" %*\n');
    const launcherDir=path.join(binDir,'node_modules','cbc','bin');fs.mkdirSync(launcherDir,{recursive:true});fs.writeFileSync(path.join(launcherDir,'cbc'),'#!/usr/bin/env node\nconsole.log("codebuddy")\n');
    fs.writeFileSync(path.join(binDir,'codebuddy.cmd'),'@ECHO off\n:start\nSETLOCAL\nCALL :find_dp0\n"%_prog%"  "%dp0%\\node_modules\\cbc\\bin\\cbc" %*\n');
  } else {
    fs.writeFileSync(path.join(binDir,'qoder'),'#!/bin/sh\necho qoder\n',{mode:0o755});
    fs.writeFileSync(path.join(binDir,'codebuddy'),'#!/bin/sh\necho codebuddy\n',{mode:0o755});
  }
  const savedPath=process.env.PATH,savedAppData=process.env.APPDATA;
  const isolatedAppData=path.join(root,'appdata');fs.mkdirSync(isolatedAppData,{recursive:true});
  process.env.PATH=binDir;process.env.APPDATA=isolatedAppData;
  try{
    const alias=resolveCommand('qodercli');
    assert.equal(alias.command,windowsPath?process.execPath:path.join(binDir,'qoder'),'documented qodercli launch name falls back to the qoder executable');
    if(windowsPath)assert.deepEqual(alias.prefix,[path.join(binDir,'node_modules','qoder','cli.js')]);
    const shebang=resolveCommand('codebuddy');
    assert.equal(shebang.command,windowsPath?process.execPath:path.join(binDir,'codebuddy'),'an extension-less npm bin target runs through Node only when its shebang proves it is a script');
    assert.throws(()=>resolveCommand('codenode-missing-agent'),/未找到程序/,'unknown Agent launch names fail instead of guessing');
  }finally{process.env.PATH=savedPath;if(savedAppData===undefined)delete process.env.APPDATA;else process.env.APPDATA=savedAppData;}
  console.log('MULTI AGENT BACKENDS: PASS (unified ACP lifecycle, permissions, settings, all external drivers)');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
  const resolved=path.resolve(root);if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('codenode-multi-backend-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
});
