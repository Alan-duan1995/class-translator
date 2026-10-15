import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('audio capture delivers approximately 50ms blocks using transferable PCM at both input rates',()=>{
 for(const sampleRate of [44100,48000]){let Capture;const blocks=[];
 vm.runInNewContext(fs.readFileSync(new URL('../src/renderer/worklet.js',import.meta.url),'utf8'),{sampleRate,AudioWorkletProcessor:class{constructor(){this.port={postMessage:(pcm,transfer)=>{assert.equal(transfer[0],pcm);blocks.push(pcm.byteLength/2);}};}},registerProcessor:(_name,cls)=>Capture=cls});
 const c=new Capture();for(let i=0;i<100;i++)c.process([[new Float32Array(128).fill(0.5)]]);
 assert.ok(blocks.length>0);assert.ok(blocks.every(n=>n>=800&&n<=847));assert.ok(Math.abs(blocks.reduce((a,b)=>a+b,0)+c.acc.length-12800*16000/sampleRate)<=1);
 }
});
