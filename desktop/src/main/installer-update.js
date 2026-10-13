import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isNewer, RELEASES } from './update.js';

const API = 'https://api.github.com/repos/Alan-duan1995/class-translator/releases/latest';
const MAX_BYTES = 1024 * 1024 * 1024;
export function installerName(version, platform, arch) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['arm64', 'x64'].includes(arch)) throw new Error('暂不支持这台电脑的自动下载，请打开发布页');
  if (platform === 'darwin') return `ClassTranslator-${version}-${arch}.dmg`;
  if (platform === 'win32') return `ClassTranslator-${version}-win-${arch}-setup.exe`;
  throw new Error('暂不支持这台电脑的自动下载，请打开发布页');
}
export function expectedHash(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (m?.[2] === name) return m[1].toLowerCase();
  }
  throw new Error('发布页缺少安装包校验信息，请打开发布页下载');
}
export class InstallerUpdate {
  constructor({ current, platform, arch, directory, fetch, openPath, isBusy }) {
    Object.assign(this, { current, platform, arch, directory, fetch, openPath, isBusy });
    this.state = { phase: 'idle', current, latest: null, percent: 0, message: '' };
    this.asset = null; this.hashUrl = null; this.file = null; this.hash = null;
    this.checking = null; this.downloading = null; this.opening = false;
  }
  status() { return { ...this.state }; }
  async response(url, signal) {
    const r = await this.fetch(url, { signal, headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('下载服务暂时不可用，请稍后重试或打开发布页');
    return r;
  }
  async check() {
    if (this.downloading || this.state.phase === 'ready') return this.status();
    if (this.checking) return this.checking;
    this.checking = this.checkNow().finally(() => { this.checking = null; });
    return this.checking;
  }
  async checkNow() {
    this.asset = null; this.hashUrl = null;
    this.state = { ...this.state, latest: null, phase: 'checking', message: '' };
    try {
      const r = await (await this.response(API, AbortSignal.timeout(15000))).json();
      const version = String(r.tag_name ?? '').replace(/^v/, '');
      if (!isNewer(version, this.current) || r.draft || r.prerelease) {
        this.state = { ...this.state, phase: 'current', latest: null, message: '当前已是最新版' };
        return this.status();
      }
      const name = installerName(version, this.platform, this.arch);
      const prefix = `${RELEASES}/download/v${version}/`;
      const asset = r.assets?.find(a => a.name === name);
      const hashes = r.assets?.find(a => a.name === 'SHA256SUMS.txt');
      if (asset?.browser_download_url !== prefix + name || hashes?.browser_download_url !== prefix + 'SHA256SUMS.txt' || !(asset.size > 0 && asset.size <= MAX_BYTES)) throw new Error('新版安装包尚未准备好，请稍后重试或打开发布页');
      this.asset = { name, url: asset.browser_download_url, size: asset.size };
      this.hashUrl = hashes.browser_download_url;
      this.state = { ...this.state, phase: 'available', latest: version, percent: 0, message: '发现新版本，可在 App 内下载安装包' };
    } catch (e) { this.state = { ...this.state, phase: 'error', message: e.name === 'TimeoutError' ? '检查更新超时，请重试' : '检查更新失败，请重试或打开发布页' }; }
    return this.status();
  }
  download() {
    if (this.downloading) return this.status();
    if (this.state.phase === 'ready') return this.status();
    if (this.checking || !this.asset) return { ...this.status(), message: '请先检查更新' };
    this.state = { ...this.state, phase: 'downloading', percent: 0, message: '正在下载，不影响当前录制' };
    this.downloading = this.downloadNow().finally(() => { this.downloading = null; });
    return this.status();
  }
  async downloadNow() {
    const a = this.asset;
    const file = path.join(this.directory, a.name), part = file + '.part';
    let handle;
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const signal = AbortSignal.timeout(15 * 60 * 1000);
      const hashResponse = await this.response(this.hashUrl, signal);
      const hashes = await hashResponse.text();
      if (hashes.length > 65536) throw new Error('校验文件过大');
      const expected = expectedHash(hashes, a.name);
      const response = await this.response(a.url, signal);
      handle = await fs.promises.open(part, 'w', 0o600);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > a.size || bytes > MAX_BYTES) throw new Error('安装包大小不符');
        hash.update(chunk);
        await handle.writeFile(chunk);
        this.state.percent = Math.min(99, Math.floor(bytes / a.size * 100));
      }
      await handle.close(); handle = null;
      if (bytes !== a.size || hash.digest('hex') !== expected) throw new Error('安装包校验失败');
      await fs.promises.rename(part, file);
      this.file = file; this.hash = expected;
      this.state = { ...this.state, phase: 'ready', percent: 100, message: '下载并校验完成。结束录制和精讲生成后，可打开安装包' };
    } catch {
      this.state = { ...this.state, phase: 'error', message: '下载或校验失败，请重试；当前版本不受影响' };
    } finally {
      await handle?.close().catch(() => {});
      await fs.promises.rm(part, { force: true }).catch(() => {});
    }
  }
  async open() {
    if (this.isBusy() || this.opening) return { ok: false, message: '请先结束录制，并等待翻译、笔记和精讲生成完成' };
    if (this.state.phase !== 'ready' || !this.file) return { ok: false, message: '请先下载安装包' };
    this.opening = true;
    try {
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(this.file)) hash.update(chunk);
      if (hash.digest('hex') !== this.hash) throw new Error('安装包已变化，请重新下载');
      if (this.isBusy()) return { ok: false, message: '当前任务尚未结束，请稍后安装' };
      const err = await this.openPath(this.file);
      if (err) throw new Error('打开失败，可前往发布页手动安装');
      return { ok: true, message: '安装包已打开，请按安装向导操作；Windows 安装前请退出本 App' };
    } catch (e) {
      this.file = null;
      this.state = { ...this.state, phase: 'error', message: '安装包无法打开，请重新下载或打开发布页' };
      return { ok: false, message: this.state.message };
    } finally { this.opening = false; }
  }
}
