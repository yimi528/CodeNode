#!/bin/bash
mkdir -p /logs/verifier
node -e 'const fs=require("fs");process.exit(fs.existsSync("/app/answer.txt")&&fs.readFileSync("/app/answer.txt","utf8")==="CodeNode benchmark smoke passed\n"?0:1)'
status=$?
if [ "$status" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
