'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {readJson, atomicJson} = require('./eval-protocol.cjs');
const {validateLedger} = require('./eval-transport.cjs');

function github(args, input) {
  return JSON.parse(execFileSync('gh', args, {encoding:'utf8', input: input === undefined ? undefined : JSON.stringify(input)}));
}
function storeFor(policy) {
  const endpoint = `repos/${policy.repository}/contents/${policy.path}`;
  return {
    get() {
      const file = github(['api', endpoint+'?ref='+encodeURIComponent(policy.branch)]);
      return {sha:file.sha, value:JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))};
    },
    put(sha, value) {
      const result = github(['api', '--method', 'PUT', endpoint, '--input', '-'], {
        branch:policy.branch, sha, message:'chore: persist evaluation budget [skip ci]',
        content:Buffer.from(JSON.stringify(value,null,2)+'\n').toString('base64'),
      });
      return result.content.sha;
    },
  };
}
function validatePolicy(ledger, policy) {
  const balance = validateLedger(ledger);
  if (ledger.ledgerId !== policy.ledgerId || ledger.limit !== policy.limit ||
      ledger.charged < policy.minimumCharged || ledger.reported < policy.minimumReported) throw Error('Budget identity, authorization or prior spending changed');
  return balance;
}
function acquire(directory, policy, store, owner) {
  if (!owner) throw Error('Missing CI run identity');
  if (fs.existsSync(directory)) throw Error('Budget session already exists; do not restart unknown attempts');
  const remote = store.get();
  if (remote.value.schemaVersion !== 1) throw Error('Unknown persistent budget format');
  if (remote.value.lease) throw Error('Previous budget lease is unresolved; paid execution blocked');
  const ledger = remote.value.ledger, balance = validatePolicy(ledger, policy);
  fs.mkdirSync(directory,{recursive:true});
  if (ledger.boundViolation || balance.pending || balance.remaining < policy.minimumStartTokens) {
    atomicJson(path.join(directory,'budget-status.json'),{status:'blocked',remaining:balance.remaining,minimumStartTokens:policy.minimumStartTokens,pending:balance.pending,boundViolation:!!ledger.boundViolation});
    return {runnable:false,remaining:balance.remaining};
  }
  const lease = {id:crypto.randomUUID(),owner,startedAt:new Date().toISOString()};
  const sha = store.put(remote.sha,{...remote.value,lease});
  atomicJson(path.join(directory,'token-ledger.json'),ledger);
  atomicJson(path.join(directory,'budget-session.json'),{schemaVersion:1,sha,lease,before:ledger});
  return {runnable:true,remaining:balance.remaining};
}
function persist(directory, policy, store) {
  const sessionFile = path.join(directory,'budget-session.json');
  if (!fs.existsSync(sessionFile)) return {persisted:false,reason:'No acquired lease',remaining:null};
  const session = readJson(sessionFile), ledger = readJson(path.join(directory,'token-ledger.json'));
  const balance = validatePolicy(ledger,policy), before = session.before;
  if (ledger.charged < before.charged || ledger.reported < before.reported || ledger.attempts.length < before.attempts.length ||
      JSON.stringify(ledger.attempts.slice(0,before.attempts.length)) !== JSON.stringify(before.attempts)) throw Error('Budget history rollback or mutation');
  const remote = store.get();
  if (remote.sha !== session.sha || remote.value.lease?.id !== session.lease.id || remote.value.lease?.owner !== session.lease.owner) throw Error('Budget lease ownership changed');
  store.put(remote.sha,{...remote.value,schemaVersion:1,ledger,lease:null,history:[...(remote.value.history||[]),{
    ...session.lease,finishedAt:new Date().toISOString(),charged:ledger.charged-before.charged,remaining:balance.remaining,
  }]});
  atomicJson(path.join(directory,'budget-status.json'),{status:'persisted',charged:ledger.charged,reported:ledger.reported,...balance});
  return {persisted:true,charged:ledger.charged,...balance};
}
module.exports = {github,storeFor,validatePolicy,acquire,persist};
