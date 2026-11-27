'use strict';
module.exports=async root=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
 const transport=require(path.join(root,'scripts/lib/eval-transport.cjs'));
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-contract-')),file=path.join(temp,'ledger.json');
 try{
  transport.createLedger(file,1000);
  assert.throws(()=>transport.reserve(file,-10,'invalid'),'LEDGER_ACCOUNTING: negative reservations must reject');
  const ticket=transport.reserve(file,700,'known');transport.settle(file,ticket,200);
  const unknown=transport.reserve(file,600,'unknown');transport.settle(file,unknown,null);
  const ledger=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(ledger.charged,800,'LEDGER_ACCOUNTING: unknown billing retains reservation');
  assert.equal(ledger.reported,200,'LEDGER_ACCOUNTING: reported usage is separate');
  assert.throws(()=>transport.reserve(file,201,'unfunded'),'LEDGER_ACCOUNTING: cumulative authorization cannot be exceeded');
  assert.throws(()=>transport.settle(file,unknown,0),'LEDGER_ACCOUNTING: settlement is not replayed');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
 return {checks:5};
};
