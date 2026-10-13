import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AudioJobs,RecoveryJournal} from '../src/main/audio-jobs.js';
import {Records} from '../src/main/store/records.js';
import {Activity} from '../src/main/activity.js';
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ct-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let fail=false,calls=0;const settings={pref:(k,d)=>d,getKey:()=> 'test-key'};const records=new Records(path.join(dir,'records')),activity=new Activity({start:()=>1,stop(){}}),locked=new Set();const jobs=new AudioJobs({records,settings,activity,locked,directory:path.join(dir,'jobs'),llm:{translate:async()=> '译文'},fetcher:async()=>{calls++;if(fail)throw Error('offline');return new Response(JSON.stringify({results:{utterances:[{transcript:'Recovered speech',start:0,speaker:0}]}}));}});return{records,activity,locked,jobs,setFail:v=>fail=v,calls:()=>calls};}
const cfg={asr:'deepgram',speaker:'en',target:'zh',translator:'gemini'};
test('import PCM finishes with translated record and releases activity, cancel removes staging',async t=>{const s=setup(t),j=s.jobs.begin({...cfg,title:'Meeting',saveAudio:true});s.jobs.append(j.id,Buffer.alloc(32000));s.jobs.finish(j.id);await s.jobs.jobs.get(j.id).promise;assert.equal(s.jobs.status(j.id).phase,'done');assert.equal(s.records.load(j.record).lines[0].tr,'译文');assert.equal(s.records.hasAudio(j.record),true);assert.equal(s.activity.busy,false);const next=s.jobs.begin(cfg);s.jobs.cancel(next.id);assert.equal(s.activity.busy,false);assert.equal(s.jobs.status(next.id).phase,'cancelled');});
test('recovery journal persists only missing intervals and successful recovery is idempotent',async t=>{const s=setup(t),name=s.records.newName();s.records.save(name,'',[{id:0,t:0,text:'Already confirmed',tr:''}]);const j=new RecoveryJournal(s.jobs,name);j.configure(cfg);j.feed(Buffer.alloc(32000*4));j.coverage(1);j.failed();j.boundary(3);j.coverage(4);j.close();const pending=JSON.parse(fs.readFileSync(path.join(s.jobs.directory,name+'.recovery.json')));assert.deepEqual(pending.gaps,[{start:1,end:3}]);assert.equal((await s.jobs.recover(name)).ok,true);const d=s.records.load(name);assert.equal(d.lines.length,2);assert.equal(d.lines[1].recovered,true);assert.equal(d.lines[1].t,1);await s.jobs.recover(name);assert.equal(s.calls(),1);assert.equal(s.jobs.pending().length,0);});
test('failed recovery survives restart and can be discarded without deleting records',async t=>{const s=setup(t),name=s.records.newName();const j=new RecoveryJournal(s.jobs,name);j.configure(cfg);j.feed(Buffer.alloc(32000));j.failed();j.close();s.setFail(true);assert.equal((await s.jobs.recover(name)).ok,false);assert.equal(s.jobs.pending().length,1);assert.equal(s.activity.busy,false);s.jobs.discard(name);assert.equal(s.jobs.pending().length,0);assert.equal(s.records.exists(name),true);});
test('acknowledged recording needs no extra transcription requests',async t=>{const s=setup(t),name=s.records.newName();const j=new RecoveryJournal(s.jobs,name);j.configure(cfg);j.feed(Buffer.alloc(32000));j.coverage(1);j.close();await s.jobs.recover(name);assert.equal(s.calls(),0);});

import {Session} from '../src/main/session.js';
import {EventEmitter} from 'node:events';
test('session close accepts final coverage so last acknowledged speech is not recovered twice',async t=>{
 const s=setup(t);let asr;
 const session=new Session({send(){},records:s.records,caps:{cloudAsr:true},llm:{available:()=>['gemini'],translate:async()=> '译文',summarize:async()=> 'summary'},appleTr:{},recoveryFactory:name=>new RecoveryJournal(s.jobs,name),recover:name=>s.jobs.recover(name,true),
 makeAsr:()=>{asr=new EventEmitter();Object.assign(asr,{kind:'deepgram',speaker:'en',offset:0,start(){},feed(){},async close(){asr.emit('message',{type:'coverage',end:1});asr.emit('message',{type:'final',source:'deepgram',text:'Last sentence',start:0,speakerId:0});}});return asr;}});
 session.configure(cfg);session.audio(Buffer.alloc(32000));await session.stop();assert.equal(s.calls(),0);assert.equal(s.records.load(session.name).lines.length,1);
});
test('partial recovery progress is retained when a later request fails, and retry skips committed chunks',async t=>{
 const s=setup(t),name=s.records.newName();const j=new RecoveryJournal(s.jobs,name);j.configure(cfg);j.feed(Buffer.alloc(32000*125));j.failed();j.close();let calls=0;
 s.jobs.fetcher=async()=>{calls++;if(calls===2)throw Error('offline');return new Response(JSON.stringify({results:{utterances:[{transcript:'piece',start:0}]}}));};
 assert.equal((await s.jobs.recover(name)).ok,false);assert.equal(s.records.load(name).lines.length,1);
 assert.equal((await s.jobs.recover(name)).ok,true);assert.equal(calls,3);assert.equal(s.records.load(name).lines.length,2);
});
test('missing cached audio stays pending instead of silently claiming recovery',async t=>{
 const s=setup(t),name=s.records.newName(),journal=new RecoveryJournal(s.jobs,name);journal.configure(cfg);journal.feed(Buffer.alloc(32000));journal.close();
 fs.rmSync(path.join(s.jobs.directory,name+'.recovery.wav'));
 assert.equal((await s.jobs.recover(name)).ok,false);assert.equal(s.jobs.pending().length,1);assert.equal(s.activity.busy,false);
});
test('startup removes interrupted import staging but preserves recovery audio',t=>{
 const s=setup(t),stage=path.join(s.jobs.directory,'12345678-1234-1234-1234-123456789012.wav'),recovery=path.join(s.jobs.directory,'2026-10-13_00-00-00.md.recovery.wav');fs.writeFileSync(stage,'staging');fs.writeFileSync(recovery,'pending');
 new AudioJobs({directory:s.jobs.directory,records:s.records,settings:{},activity:s.activity,locked:s.locked});
 assert.equal(fs.existsSync(stage),false);assert.equal(fs.existsSync(recovery),true);
});
