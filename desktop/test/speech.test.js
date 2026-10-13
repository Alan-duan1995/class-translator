import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechClient, normalizeSpeechBase, validateSpeechConfig } from '../src/main/cloud/openai-asr.js';
import { TimeoutError } from '../src/main/llm/errors.js';
const settings = { pref: k => ({ speechBase: 'https://speech.example/v1', speechModel: 'speech-model' })[k], getKey: () => 'secret-test-key' };
test('speech: WAV multipart, independent key and model, automatic language omitted', async () => {
  const client = new SpeechClient(settings, { fetch: async (url, opts) => {
    assert.equal(url, 'https://speech.example/v1/audio/transcriptions');
    assert.equal(opts.headers.Authorization, 'Bearer secret-test-key');
    assert.equal(opts.headers['Content-Type'], undefined);
    assert.equal(opts.body.get('model'), 'speech-model');
    assert.equal(opts.body.get('language'), null);
    assert.equal(opts.body.get('file').type, 'audio/wav');
    assert.deepEqual(Buffer.from(await opts.body.get('file').arrayBuffer()), Buffer.from('RIFF'));
    return Response.json({ text: '你好', language: 'chinese' });
  }});
  assert.deepEqual(await client.recognize(Buffer.from('RIFF')), { text: '你好', lang: 'zh' });
});
test('speech: local service without key and explicit language', async () => {
  const local = { pref: k => k === 'speechBase' ? 'http://localhost:8000/v1' : 'whisper', getKey: () => '' };
  const client = new SpeechClient(local, { fetch: async (_, opts) => {
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.body.get('language'), 'en');
    return Response.json({ text: '' });
  }});
  assert.deepEqual(await client.recognize(Buffer.alloc(0), 'en'), { text: '', lang: 'en' });
});
test('speech: validates config and accepts full endpoint', () => {
  assert.equal(normalizeSpeechBase(' https://a.test/v1/audio/transcriptions/ '), 'https://a.test/v1');
  for (const base of ['http://remote.test/v1', 'https://user:pass@a.test/v1', 'https://a.test/v1?key=secret']) assert.ok(validateSpeechConfig({ base, model: 'm', key: 'key' }));
  assert.ok(validateSpeechConfig({ base: 'https://a.test/v1', model: 'm', key: '' }));
});
test('speech: provider errors never echo secrets; incompatible response rejected', async () => {
  const client = new SpeechClient(settings, { fetch: async () => new Response('secret-test-key', { status: 401 }) });
  await assert.rejects(client.recognize(Buffer.alloc(0)), e => e.status === 401 && !e.message.includes('secret-test-key'));
  client.fetch = async () => Response.json({ choices: [] });
  await assert.rejects(client.recognize(Buffer.alloc(0)), /text/);
});
test('speech: timeout aborts request and bounds queue wait', async () => {
  let signal;
  const client = new SpeechClient(settings, { timeoutMs: 10, fetch: async (_, opts) => { signal = opts.signal; return new Promise(() => {}); } });
  await assert.rejects(client.recognize(Buffer.alloc(0)), TimeoutError);
  assert.equal(signal.aborted, true);
});
