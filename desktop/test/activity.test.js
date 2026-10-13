import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Activity, audioLevel } from '../src/main/activity.js';
import { registerIpc } from '../src/main/ipc.js';
test('overlapping activities hold one sleep blocker and releases are idempotent', () => {
  const log = [], a = new Activity({ start: kind => { log.push(kind); return 17; }, stop: id => log.push(id) });
  const first = a.acquire(), second = a.acquire(); first(); first(); assert.equal(a.busy, true);
  second(); assert.equal(a.busy, false); assert.deepEqual(log, ['prevent-app-suspension', 17]);
});
test('PCM meter handles silence, loud input and empty data', () => {
  assert.equal(audioLevel(Buffer.alloc(320)), 0);
  const loud = Buffer.alloc(320); for (let i=0;i<320;i+=2) loud.writeInt16LE(32767,i);
  assert.ok(audioLevel(loud) > 99 && audioLevel(loud) <= 100); assert.equal(audioLevel(Buffer.alloc(1)),0);
});
test('IPC releases power after failed stop, destroyed window and failed report', async () => {
  const handles = {}, ons = {}, callbacks = {}, activity = new Activity({ start: () => 1, stop() {} });
  registerIpc({ activity, ipcMain: { handle: (c,f) => handles[c]=f, on: (c,f) => ons[c]=f },
    api: async () => { assert.equal(activity.busy,true); throw Error('report'); },
    makeSession: () => ({ name:'a', dispose() {}, stop: async () => { throw Error('stop'); } }) });
  const e = { sender: { id: 1, once: (c,f) => callbacks[c]=f, isDestroyed: () => false, send() {} } };
  handles['session:open'](e); assert.equal(activity.busy,true);
  await ons['session:cmd'](e,'stop'); assert.equal(activity.busy,false);
  handles['session:open'](e); callbacks.destroyed(); assert.equal(activity.busy,false);
  await assert.rejects(handles.api(e,{url:'/api/report',method:'POST'})); assert.equal(activity.busy,false);
});
