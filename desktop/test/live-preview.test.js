import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LivePreview} from '../src/main/live-preview.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('rapid drafts coalesce and never launch concurrent translations',async()=>{
 const calls=[],sent=[],finish=[];const p=new LivePreview({delayMs:1,translate:text=>{calls.push(text);return new Promise(r=>finish.push(r));},publish:m=>sent.push(m)});
 p.update('We will discuss the budget');await wait(10);
 p.update('We will discuss the new budget');p.update('We will discuss the revised budget');await wait(10);assert.equal(calls.length,1);
 finish.shift()({tr:'旧草稿'});await wait(10);assert.equal(sent.length,0);assert.equal(calls.length,2);
 finish.shift()({tr:'新草稿'});await wait(1);assert.equal(sent[0].text,'We will discuss the revised budget');p.close();
});
test('finalization or closure suppresses late provisional results',async()=>{
 let finish;const sent=[];const p=new LivePreview({delayMs:1,translate:()=>new Promise(r=>finish=r),publish:m=>sent.push(m)});
 p.update('This is a pending draft');await wait(10);p.clear();finish({tr:'旧内容'});await wait(2);assert.equal(sent.length,0);p.close();p.update('Do not translate after closing');await wait(2);assert.equal(sent.length,0);
});
test('short fragments and oversized drafts are not translated',async()=>{
 let calls=0;const p=new LivePreview({delayMs:1,translate:async()=>{calls++;return{tr:'x'}},publish(){}});
 p.update('Hello there');await wait(5);p.update('long '.repeat(150));await wait(5);assert.equal(calls,0);p.close();
});
