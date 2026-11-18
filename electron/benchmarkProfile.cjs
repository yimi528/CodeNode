'use strict';
const ARGV_GUIDE = '执行普通程序优先使用 execute_shell 的 argv 形式，例如 {"mode":"argv","program":"node","args":["test/public.cjs"]}；不要在普通 command 参数中混用管道或分号。复合命令需遵循工具声明的显式 shell 契约。';
const TOOLS = ['read_file','write_file','edit_file','find_files','search_files','list_directory','execute_shell','poll_job'];
function apply(cfg, env = process.env) {
  if (env.CODENODE_BENCHMARK_CONTAINER !== '1') throw Error('benchmark profile requires an evaluator-owned container');
  if (!env.CODENODE_API_KEY) throw Error('benchmark profile requires an explicit CODENODE_API_KEY');
  return { ...cfg, soulEvolution:false, externalVerification:true, apiKey:env.CODENODE_API_KEY,
    tools:{...cfg.tools,toolsEnabled:true,toolsAllowed:[...TOOLS],toolsDeny:[],toolProfile:'off',toolsConfirmWrites:false,toolsParallel:false},
    sandbox:{...cfg.sandbox,mode:'off',network:'inherit'},
    rag:{...cfg.rag,enabled:false},webSearch:{...cfg.webSearch,enabled:false},
    subagent:{...cfg.subagent,enabled:false},modelRouting:{...cfg.modelRouting,enabled:false,routes:{}},
    editing:{...cfg.editing,autoVerify:false,blockOnFailure:false},
  };
}
function installFault(registry, fault, onEvent) {
  if (!fault) return;
  if(fault.tool!=='read_file'||!Number.isInteger(fault.count)||fault.count<1||fault.count>3)throw Error('Unsupported benchmark fault');
  const execute=registry.execute.bind(registry);let remaining=fault.count;
  registry.execute=async(name,args,context)=>{
    if(name===fault.tool&&remaining>0){remaining--;onEvent?.({kind:'injected_tool_failure',tool:name,remaining});return {ok:false,text:'临时读取故障，请修正或重试；本提示是评测注入。',data:{code:'EVAL_TEMPORARY_FAILURE'}};}
    return execute(name,args,context);
  };
}
module.exports={apply,TOOLS,ARGV_GUIDE,installFault};
