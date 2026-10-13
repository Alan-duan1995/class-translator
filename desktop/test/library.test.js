import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Records} from '../src/main/store/records.js';
import {libraryApi} from '../src/main/library-api.js';
import {parseGlossary,keyterms} from '../src/main/glossary.js';
const name='2026-10-14_10-00-00.md';
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ct-library-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const records=new Records(dir),locked=new Set(),prefs={};records.save(name,'old summary',[{id:0,t:1,text:'hello',tr:'你好',lang:'en',speakerId:0},{id:1,t:3,text:'world',tr:'世界',lang:'en'}]);const settings={pref:(k,d)=>prefs[k]??d,setPref:(k,v)=>prefs[k]=v};const llm={translate:async text=>'翻译:'+text};const api=libraryApi({records,locked,settings,llm,jobs:{runningRecovery:new Set()},toggleOverlay(){}});return{records,locked,api,settings};}
test('editing persists source, translation, original text, invalidates report and prevents stale writes',async t=>{
 const {records,api}=setup(t);records.writeReport(name,'# old report');const revision=records.load(name).revision;
 const r=await api('/api/library/edit','POST',{record:name,revision,id:0,text:'corrected',tr:'',retranslate:true,target:'zh',translator:'gemini'});
 assert.equal(r.ok,true);assert.equal(records.load(name).lines[0].originalText,'hello');assert.equal(records.load(name).lines[0].tr,'翻译:corrected');assert.equal(records.readReport(name),null);
 assert.equal((await api('/api/library/edit','POST',{record:name,revision,id:0,text:'stale'})).ok,false);
});
test('rename, category, speaker names are searchable and exported; active records cannot be changed',async t=>{
 const {records,api,locked}=setup(t);let r=await api('/api/library/meta','POST',{record:name,revision:records.load(name).revision,title:'Physics',category:'Course',speakers:{0:'Teacher'}});assert.equal(r.ok,true);
 assert.match(records.markdown(name),/Teacher：hello/);assert.equal((await api('/api/library?q=Physics&category=Course')).records.length,1);
 locked.add(name);assert.equal((await api('/api/library/edit','POST',{record:name,revision:r.revision,id:0,text:'x'})).ok,false);
 assert.equal((await api('/api/library/record?record=..%2Fsecret')).ok,false);
});
test('legacy Markdown migrates with translations and speaker IDs',t=>{const{records}=setup(t);fs.rmSync(records.dataFile(name));const d=records.load(name);assert.equal(d.lines[0].speakerId,0);assert.equal(d.lines[0].tr,'你好');records.save(name,d.summary,d.lines);assert.equal(records.load(name).schema,1);});
test('meeting and class reports do not overwrite each other',t=>{const{records}=setup(t);records.writeReport(name,'# class');records.writeReport(name,'# meeting','meeting');assert.equal(records.readReport(name).title,'class');assert.equal(records.readReport(name,'meeting').title,'meeting');});
test('glossary validation and Deepgram token budget are bounded',()=>{assert.deepEqual(parseGlossary('heat = 热量'),[{term:'heat',translation:'热量'}]);assert.throws(()=>parseGlossary('x\n'.repeat(41)));const terms=keyterms({pref:()=>('专有名词术语\n').repeat(35)});assert.ok(Buffer.byteLength(terms.join(''))<=400);});
