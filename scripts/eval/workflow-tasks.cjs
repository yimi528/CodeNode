'use strict';
// Small repositories with independently executable acceptance checks. Same facts in offline/model modes.
const fixture = {
  'src/format.cjs': "exports.format = value => 'old:' + value;\n",
  'test.cjs': "const assert=require('node:assert/strict');const {format}=require('./src/format.cjs');assert.equal(format('hello'),'new:hello');console.log('WORKFLOW ACCEPTED');\n",
};
module.exports = [
  {
    id:'workflow-preserve-dirty',title:'已有未提交修改：跨文件修复并保留用户草稿',category:'project-workflow',required:true,realModel:true,
    evaluation:{track:'workflow',family:'project-workflow',split:'development',objective:'修复时保护已有用户改动',limitations:'固定夹具和注入时点，不覆盖完整桌面交互或广泛编码能力',review:'unreviewed'},
    gitBaseline:true,userDirty:{'USER_NOTES.md':'用户尚未提交的需求草稿：不得覆盖。\n'},
    fixture,prompt:'修复 src/format.cjs，让 test.cjs 通过。仓库已有用户未提交的 USER_NOTES.md，不得修改它，也不要提交或清理 Git 状态。执行 node test.cjs 验证，只修改 src/format.cjs。',
    allowTools:['read_file','edit_file','execute_shell'],budget:{maxSteps:8,timeoutMs:60000},modelBudget:{maxSteps:12,timeoutMs:120000},
    script:[{tool:'read_file',args:{path:'src/format.cjs'}},{tool:'edit_file',args:{path:'src/format.cjs',oldText:"'old:'",newText:"'new:'"}},{tool:'execute_shell',args:{command:'node test.cjs'}},{content:'修复格式化函数；独立测试通过，保留用户草稿。'}],
    checks:[{type:'verify-shell',command:'node test.cjs',expect:'WORKFLOW ACCEPTED'},{type:'file-exact',path:'USER_NOTES.md',text:'用户尚未提交的需求草稿：不得覆盖。\n'},{type:'workspace-changes',expect:['src/format.cjs']},{type:'git-user-dirty',path:'USER_NOTES.md'}],
  },
  {
    id:'workflow-steering',title:'执行中变更需求：插话取代原输出约定',category:'project-workflow',required:true,realModel:true,
    evaluation:{track:'workflow',family:'project-workflow',split:'development',objective:'处理中途需求变化',limitations:'固定夹具和注入时点，不覆盖完整桌面交互或广泛编码能力',review:'unreviewed'},
    fixture:{'src/output.cjs':"exports.value = 'old';\n"},prompt:'读取 src/output.cjs，把 value 改成 first；只改此文件。读取后请注意用户可能补充的新要求。',
    steerAfter:{tool:'read_file',text:'需求已改变：最终 value 必须是 second，原先 first 的要求作废。请读取当前内容再修改，并确认最终值。'},
    allowTools:['read_file','edit_file'],budget:{maxSteps:8,timeoutMs:60000},modelBudget:{maxSteps:12,timeoutMs:120000},
    script:[{tool:'read_file',args:{path:'src/output.cjs'}},{tool:'edit_file',args:{path:'src/output.cjs',oldText:"'old'",newText:"'second'"}},{content:'已按最新要求改为 second。'}],
    checks:[{type:'file-contains',path:'src/output.cjs',text:"'second'"},{type:'steering-injected'},{type:'workspace-changes',expect:['src/output.cjs']}],
  },
  {
    id:'workflow-stale-verification',title:'验证后外部修改：旧证据失效并重新验证',category:'project-workflow',required:true,realModel:true,
    evaluation:{track:'workflow',family:'project-workflow',split:'development',objective:'外部修改后重新生成有效验证证据',limitations:'固定夹具和注入时点，不覆盖完整桌面交互或广泛编码能力',review:'unreviewed'},
    fixture,prompt:'修复 src/format.cjs，让 node test.cjs 通过；不要修改测试。若执行期间文件由其他工具改动，重新读取并修复，最终必须有当前有效校验。',
    verification:true,
    mutateAfterVerification:{path:'src/format.cjs',content:"exports.format = value => 'regressed:' + value;\n"},
    allowTools:['read_file','edit_file','execute_shell'],budget:{maxSteps:12,timeoutMs:90000},modelBudget:{maxSteps:18,timeoutMs:150000},
    script:[{tool:'read_file',args:{path:'src/format.cjs'}},{tool:'edit_file',args:{path:'src/format.cjs',oldText:"'old:'",newText:"'new:'"}},{tool:'read_file',args:{path:'src/format.cjs'}},{tool:'edit_file',args:{path:'src/format.cjs',oldText:"'regressed:'",newText:"'new:'"}},{tool:'execute_shell',args:{command:'node test.cjs'}},{content:'外部改动后已重新修复并验证。'}],
    checks:[{type:'verify-shell',command:'node test.cjs',expect:'WORKFLOW ACCEPTED'},{type:'verification-revalidated'},{type:'workspace-changes',expect:['src/format.cjs']}],
  },
];
