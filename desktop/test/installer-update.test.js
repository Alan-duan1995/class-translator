import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { InstallerUpdate, installerName, expectedHash } from '../src/main/installer-update.js';
function setup(t, badHash = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-updater-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('installer bytes'), name = installerName('0.7.5', 'darwin', 'arm64');
  const prefix = 'https://github.com/Alan-duan1995/class-translator/releases/download/v0.7.5/';
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const release = { tag_name: 'v0.7.5', assets: [
    { name, size: bytes.length, browser_download_url: prefix + name },
    { name: 'SHA256SUMS.txt', browser_download_url: prefix + 'SHA256SUMS.txt' }] };
  const requests = [], opened = []; let busy = false;
  const updater = new InstallerUpdate({ current: '0.7.4', platform: 'darwin', arch: 'arm64', directory,
    fetch: async url => { requests.push(url);
      if (url.endsWith('/latest')) return { ok: true, json: async () => release };
      if (url.endsWith('.txt')) return new Response(`${badHash ? '0'.repeat(64) : hash}  ${name}\n`);
      return new Response(bytes);
    }, openPath: async f => { opened.push(f); return ''; }, isBusy: () => busy });
  return { updater, directory, release, name, bytes, requests, opened, setBusy: b => { busy = b; } };
}
test('update selects correct installer and rejects invalid platform/version/checksum entry', () => {
  assert.equal(installerName('1.2.3', 'win32', 'x64'), 'ClassTranslator-1.2.3-win-x64-setup.exe');
  assert.throws(() => installerName('../../evil', 'darwin', 'arm64'));
  assert.throws(() => installerName('1.2.3', 'linux', 'x64'));
  assert.throws(() => expectedHash('0'.repeat(64) + '  other.exe', 'wanted.exe'));
});
test('verified download cannot open during work and is verified again before opening', async t => {
  const s = setup(t); assert.equal((await s.updater.check()).phase, 'available');
  s.updater.download(); await s.updater.downloading;
  assert.equal(s.updater.status().phase, 'ready');
  assert.deepEqual(fs.readFileSync(path.join(s.directory, s.name)), s.bytes);
  s.setBusy(true); assert.equal((await s.updater.open()).ok, false); assert.equal(s.opened.length, 0);
  s.setBusy(false); assert.equal((await s.updater.open()).ok, true);
  fs.writeFileSync(path.join(s.directory, s.name), 'tampered');
  assert.equal((await s.updater.open()).ok, false); assert.equal(s.opened.length, 1);
});
test('bad checksum removes partial downloads and cannot install', async t => {
  const s = setup(t, true); await s.updater.check(); s.updater.download(); await s.updater.downloading;
  assert.equal(s.updater.status().phase, 'error'); assert.deepEqual(fs.readdirSync(s.directory), []);
  assert.equal((await s.updater.open()).ok, false);
});
test('foreign asset URL is rejected before download', async t => {
  const s = setup(t); s.release.assets[0].browser_download_url = 'https://example.com/evil.dmg';
  assert.equal((await s.updater.check()).phase, 'error'); s.updater.download(); assert.equal(s.requests.length, 1);
});
test('same version and prerelease are not offered', async t => {
  const s = setup(t); s.release.prerelease = true;
  assert.equal((await s.updater.check()).phase, 'current');
  s.release.prerelease = false; s.release.tag_name = 'v0.7.4';
  assert.equal((await s.updater.check()).phase, 'current');
});
test('duplicate download requests share one transfer', async t => {
  const s = setup(t); await s.updater.check(); s.updater.download();
  const pending = s.updater.downloading; s.updater.download(); assert.equal(s.updater.downloading, pending);
  await pending; assert.equal(s.requests.filter(u => u.endsWith('.dmg')).length, 1);
});
