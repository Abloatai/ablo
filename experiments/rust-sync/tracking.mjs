import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpus, release } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const dir = new URL('.', import.meta.url).pathname;
process.chdir(dir);
mkdirSync('.generated',{recursive:true});
execFileSync('rustc', ['-O', '--edition=2021', 'tracking.rs', '-o', '.generated/tracking'], {stdio:'inherit'});
await build({absWorkingDir:dir,stdin:{contents:`export {InstanceCache} from '../../packages/humans/src/local/InstanceCache.ts'; export {createTestContext} from '../../packages/humans/src/local/testing/mocks/MockSyncContext.ts'; export {getActiveRegistry} from '../../packages/humans/src/local/ModelRegistry.ts';`,resolveDir:dir,loader:'ts'},outfile:'.generated/tracking-pool.cjs',bundle:true,platform:'node',format:'cjs',conditions:['@ablo/source']});
const {InstanceCache,createTestContext,getActiveRegistry} = createRequire(import.meta.url)('./.generated/tracking-pool.cjs');

function kernel(ops, optimized = false, snapshot = true) {
  const entries = new Map(), recent = new Map(), history = new Map(), accepted = [];
  let skipped = 0, scanned = 0, earliest = Infinity;
  for (const [index, op] of ops.entries()) {
    const [kind,id,now,sync,action] = op, key = `Item:${id}`;
    if (kind === 'R') { entries.delete(id); recent.delete(key); history.delete(key); continue; }
    if (kind === 'X') { if (entries.has(id)) entries.set(id,false); continue; }
    const last = recent.get(key);
    if (entries.get(id) || (last && now-last < 50) || (sync && history.get(key)?.[0] >= sync)) { skipped++; continue; }
    if (sync) history.set(key,[sync,action,now]);
    recent.set(key,now); earliest = Math.min(earliest,now);
    // Experiment only: conservative earliest timestamp tolerates removal,
    // overwrite and backwards clocks; re-scan when an entry could expire.
    if (recent.size > 100 && (!optimized || now-earliest > 1000)) {
      scanned += recent.size; earliest = Infinity;
      for (const [k,t] of recent) { if (now-t > 1000) recent.delete(k); else earliest=Math.min(earliest,t); }
    }
    entries.set(id,true); accepted.push(index);
  }
  return snapshot ? {accepted,skipped,scanned,recent:[...recent].sort(),history:[...history].sort(),entries:[...entries].sort()} : {accepted,skipped,scanned,recent,history,entries};
}
function rust(ops,optimized=false) {
  writeFileSync('.generated/tracking-input.tsv',ops.map(x=>x.join('\t')).join('\n'));
  const input=openSync('.generated/tracking-input.tsv','r');
  try {return JSON.parse(execFileSync('.generated/tracking',['1',optimized?'optimized':'current'],{stdio:[input,'pipe','pipe'],encoding:'utf8',maxBuffer:32*1024*1024,timeout:30000}));}
  finally {closeSync(input);}
}
function actual(ops, optimized=false, timing=false) {
  const context=createTestContext(), pool=new InstanceCache({maxSize:100000,useWeakRefs:false},getActiveRegistry());
  const oldNow=Date.now, accepted=[]; let scanned=0;
  const cleanup=pool.cleanupTracking.bind(pool);
  let earliest=Infinity;
  if(optimized){const set=pool.recentAdditions.set.bind(pool.recentAdditions);pool.recentAdditions.set=(key,time)=>{earliest=Math.min(earliest,time);return set(key,time);};}
  pool.cleanupTracking=()=>{
    if(optimized && Date.now()-earliest<=1000)return;
    scanned+=pool.recentAdditions.size;cleanup();
    if(optimized){earliest=Infinity;for(const time of pool.recentAdditions.values())earliest=Math.min(earliest,time);}
  };
  try {
    const models=ops.map(([kind,id])=>kind==='A'?pool.createFromData({__typename:'Item',id,title:id,status:'todo'},undefined,{deferObservability:true}):null);
    const start=performance.now();
    for(const [index,[kind,id,now,sync,action]] of ops.entries()) {
      Date.now=()=>now;
      if(kind==='R'){pool.remove(id);continue;}
      if(kind==='X'){const model=pool.peek(id);if(model)model.dispose();continue;}
      const model=models[index];
      const before=pool.metrics.additions; pool.add(model,undefined,{syncId:sync,action});
      if(pool.metrics.additions>before)accepted.push(index);
    }
    const elapsedMs=performance.now()-start;
    const result={accepted,skipped:pool.metrics.duplicatesSkipped,scanned,recent:[...pool.recentAdditions].sort(),history:[...pool.deltaHistory].map(([k,h])=>[k,[h.lastSyncId,h.lastAction,h.timestamp]]).sort(),entries:[...pool.entries].map(([k,e])=>[k,!e.model.disposed]).sort()};
    return timing ? {elapsedMs,result} : result;
  } finally { Date.now=oldNow;pool.stopGC();pool.clear();context.cleanup(); }
}
let seed=42;
const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
const unique=n=>Array.from({length:n},(_,i)=>['A',`probe-${i}`,10000, i+1,'I']);
const boundary=unique(105).concat([
 ['X','probe-0',10049,0,'I'],['A','probe-0',10049,0,'I'],['A','probe-0',10050,0,'I'],
 ['X','probe-1',10050,0,'I'],['A','probe-1',10050,2,'I'],['A','probe-1',10050,3,'U'],
 ['A','extra-0',11000,0,'I'],['A','extra-1',11001,0,'I'],
 ['X','probe-2',9000,0,'I'],['A','probe-2',9000,0,'I'],
 ['R','probe-2',11002,0,'I'],['A','probe-2',11002,0,'I'],
 ['A','zero',0,0,'I'],['X','zero',0,0,'I'],['A','zero',1,0,'I'],
]);
const cases=[[],...boundary.map((_,i)=>boundary.slice(0,i+1))];
for(let c=0;c<50;c++) {let now=10000;cases.push(Array.from({length:300},()=>{now+=random(120)-20;return [['A','A','A','X','R'][random(5)],`id-${random(150)}`,now,random(20),['I','U','D'][random(3)]];}));}
for(const ops of cases){const expected=actual(ops);assert.deepEqual(kernel(ops),expected);assert.deepEqual(rust(ops).result,expected);const optimized=kernel(ops,true);assert.deepEqual({...optimized,scanned:expected.scanned},expected);assert.deepEqual(rust(ops,true).result,optimized);assert.deepEqual({...actual(ops,true),scanned:expected.scanned},expected);}
console.log(`Production JS / Rust / optimized JS parity: ${cases.length} cases passed.`);
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const results={machine:{date:new Date().toISOString(),node:process.version,rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),cpu:cpus()[0].model,arch:process.arch,kernel:release(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},parityCases:cases.length,note:'Tracking kernel only; identical fixed timestamp inputs, models/payloads/reactivity excluded. Timings include creating maps, cleanup and deduplication; input parse/startup/IPC and snapshot sorting/serialization excluded in both languages. Rust also includes destruction of kernel state. JS optimized comparison preserves outputs and retention, skips provably unnecessary scans.',workloads:[]};
for(const n of [1000,4000,8000]) {
  const ops=unique(n), js=[], native=[], optimized=[], optimizedRust=[];
  assert.deepEqual(kernel(ops),rust(ops).result);
  assert.equal(kernel(ops).scanned,n*(n+1)/2-5050);
  for(let w=0;w<3;w++){kernel(ops,false,false);kernel(ops,true,false);}
  for(let sample=0;sample<7;sample++) {
    const jobs=[()=>{const t=performance.now();kernel(ops,false,false);js.push(performance.now()-t);},()=>native.push(rust(ops).elapsedMs),()=>{const t=performance.now();kernel(ops,true,false);optimized.push(performance.now()-t);},()=>optimizedRust.push(rust(ops,true).elapsedMs)];
    for(let j=0;j<4;j++)jobs[(sample+j)%4]();
  }
  const poolJs=[],poolOptimized=[];
  actual(ops);actual(ops,true);
  for(let s=0;s<7;s++){
    const jobs=[()=>poolJs.push(actual(ops,false,true).elapsedMs),()=>poolOptimized.push(actual(ops,true,true).elapsedMs)];
    for(let j=0;j<2;j++)jobs[(s+j)%2]();
  }
  const row={n,scanned:kernel(ops).scanned,jsMs:js,rustMs:native,optimizedJsMs:optimized,optimizedRustMs:optimizedRust,jsMedianMs:median(js),rustMedianMs:median(native),optimizedJsMedianMs:median(optimized),optimizedRustMedianMs:median(optimizedRust),poolJsMs:poolJs,poolOptimizedJsMs:poolOptimized,poolJsMedianMs:median(poolJs),poolOptimizedJsMedianMs:median(poolOptimized)};
  results.workloads.push(row);console.log(JSON.stringify(row));
}
writeFileSync('tracking-results.json',JSON.stringify(results,null,2)+'\n');
