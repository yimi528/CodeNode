'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),venv=path.join(root,'benchmarks','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=process.env.CODENODE_BENCHMARK_PYTHON||(fs.existsSync(venv)?venv:process.platform==='win32'?'python':'python3');
const supplied=process.argv.slice(2);
const args=supplied[0]==='recover-setup'?[path.join(root,'scripts/benchmarks/recover-setup.py'),...supplied.slice(1)]:supplied[0]==='recover-static-service'?[path.join(root,'scripts/benchmarks/recover-static-service.py'),...supplied.slice(1)]:supplied[0]==='ab'?['-m','codenode_benchmarks.native_ab',...supplied.slice(1)]:supplied[0]==='recover-grading'?['-m','codenode_benchmarks.recovery',...supplied.slice(1)]:supplied[0]==='--test'?['-m','unittest','discover','-s',path.join(root,'benchmarks/tests'),'-p','test_*.py']:supplied[0]==='--smoke'?[path.join(root,'benchmarks/tests/smoke.py'),...supplied.slice(1)]:supplied[0]==='--comparison-smoke'?[path.join(root,'benchmarks/tests/comparison_smoke.py')]:supplied[0]==='compare'?['-m','codenode_benchmarks.comparison',...supplied.slice(1)]:['-m','codenode_benchmarks.cli',...supplied];
const result=spawnSync(python,args,{cwd:root,stdio:'inherit',env:{...process.env,PYTHONPATH:[path.join(root,'benchmarks'),process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)}});
if(result.error)console.error('Benchmark Python unavailable: '+result.error.message+'; install benchmarks/pyproject.toml with Python 3.12+');
process.exitCode=result.status===null?2:result.status;
