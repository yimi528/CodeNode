'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const crypto=require('node:crypto');

function materialize(repository,workspace) {
  const command=(program,args,options={})=>{
    const result=spawnSync(program,args,{encoding:'utf8',timeout:120000,...options});
    if(result.status!==0)throw Error('项目评测副本创建失败：'+String(result.error||result.stderr).slice(0,2000));
    return result.stdout.trim();
  };
  if(repository.snapshot==='tree') {
    const archive=path.join(path.dirname(workspace),'snapshot-'+crypto.randomUUID()+'.tar');
    const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'};
    try {
      command('git',['-c','protocol.allow=never','-C',repository.path,'archive','--format=tar','--output='+archive,repository.commit],{env});
      command('tar',['-xf',archive,'-C',workspace]);
      command('git',['init','--quiet',workspace]);
      command('git',['-C',workspace,'add','.']);
      command('git',['-C',workspace,'-c','user.name=Eval','-c','user.email=eval@localhost','commit','--quiet','-m','Frozen source tree']);
      return {commit:repository.commit,name:path.basename(repository.path),snapshot:'tree',
        tree:command('git',['-c','protocol.allow=never','-C',repository.path,'rev-parse',repository.commit+'^{tree}'],{env}),
        workspaceCommit:command('git',['-C',workspace,'rev-parse','HEAD']),historyPreserved:false};
    }finally{fs.rmSync(archive,{force:true});}
  }
  command('git',['clone','--quiet','--no-hardlinks','--no-checkout','--',repository.path,workspace],{env:require('../../electron/envPolicy.cjs').safeEnvironment({GIT_TERMINAL_PROMPT:'0'},[])});
  command('git',['-C',workspace,'checkout','--quiet','--detach',repository.commit]);
  return {commit:repository.commit,name:path.basename(repository.path),snapshot:'history',historyPreserved:true};
}
module.exports={materialize};
