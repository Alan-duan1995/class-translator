import { AudioJobs, RecoveryJournal } from "./audio-jobs.js";
import { libraryApi } from "./library-api.js";
import { keyterms } from "./glossary.js";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, net, powerSaveBlocker, safeStorage, session, shell, systemPreferences } from "electron";
import { SR } from "./langs.js";
import { Settings } from "./store/settings.js";
import { Records } from "./store/records.js";
import { LLM } from "./llm/index.js";
import { AppleASR } from "./apple/asr.js";
import { AppleTranslator } from "./apple/translate.js";
import { SystemAudio } from "./apple/syscap.js";
import { helperPaths } from "./helpers.js";
import { capabilities } from "./platform.js";
import { createApi } from "./api.js";
import { registerIpc } from "./ipc.js";
import { Session } from "./session.js";
import { savePdf } from "./pdf.js";
import { VoiceDetector } from "./cloud/vad.js";
import { SpeechClient } from "./cloud/openai-asr.js";
import { DeepgramASR } from "./cloud/deepgram-asr.js";
import { CloudASR } from "./cloud/asr.js";
import { LocalASR } from "./local/asr.js";
import { AudioRecorder, cleanOldAudio } from "./store/audio.js";
import { Activity } from "./activity.js";
import { InstallerUpdate } from "./installer-update.js";
import { LocalTranslator } from "./local/translate.js";
import { FileCrypto } from "./store/filecrypto.js";

const here = import.meta.dirname;
app.setName("课堂同传");
let mainWindow = null, overlayWindow = null;
let captionSession = null;
let overlayState = { text:"等待字幕…", tr:"" };
function toggleOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.close(); return; }
  overlayWindow = new BrowserWindow({ width:760, height:210, minWidth:420, minHeight:160, alwaysOnTop:true, title:"悬浮双语字幕", webPreferences:{preload:path.join(here,"../preload/overlay.cjs"),contextIsolation:true,sandbox:true,nodeIntegration:false} });
  overlayWindow.setMenu(null);
  overlayWindow.loadFile(path.join(here,"../renderer/overlay.html"));
  overlayWindow.webContents.once("did-finish-load",()=>overlayWindow?.webContents.send("overlay:caption",overlayState));
  overlayWindow.on("closed",()=>{overlayWindow=null;});
}
function caption(m) {
  if(m.type==="line")overlayState={id:m.id,text:m.text,tr:m.tr??""};
  else if(m.type==="partial" && m.text)overlayState={text:m.text,tr:""};
  else if(m.type==="partial_translation" && overlayState.text===m.text)overlayState.tr="快速预览 · "+m.tr;
  else if(m.type==="translation_preview" && m.id===overlayState.id)overlayState.tr="快速预览 · "+m.tr;
  else if(m.type==="translation" && m.id===overlayState.id)overlayState.tr=m.tr;
  else return;
  if(overlayWindow&&!overlayWindow.isDestroyed())overlayWindow.webContents.send("overlay:caption",overlayState);
}

const NO_APPLE_TR = { translate: async () => ({ tr: "", code: "unsupported" }) };

function build() {
  const bins = helperPaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, devDir: path.join(here, "../../build/bin") });
  // 本地实时识别：模型是资源文件；线程脚本和 sherpa-onnx 打包时放在 asar 外面（线程和 WASM 都要按真实文件路径加载）
  const modelDir = app.isPackaged ? path.join(process.resourcesPath, "models", "kroko-en") : path.join(here, "../../models/kroko-en");
  const localWorker = path.join(here, "local/worker.cjs").replace("app.asar", "app.asar.unpacked");
  // 本地翻译（英语 → 简体中文）：模型同样是资源文件，引擎的 WASM 也放在 asar 外面
  const mtModelDir = path.join(path.dirname(modelDir), "mt-en-zh");
  const localTr = new LocalTranslator({
    workerPath: path.join(here, "local/mt-worker.cjs").replace("app.asar", "app.asar.unpacked"),
    modelDir: mtModelDir,
    engineDir: path.join(here, "../../node_modules/@browsermt/bergamot-translator/worker").replace("app.asar", "app.asar.unpacked"),
  });
  const caps = capabilities({ platform: process.platform, version: process.getSystemVersion(), has: (p) => fs.existsSync(p), bins, localModel: path.join(modelDir, "encoder.onnx"), localMtModel: path.join(mtModelDir, "model.bin") });
  if (process.env.CT_NO_APPLE) Object.assign(caps, { appleAsr: false, appleTranslate: false }); // 测试时假装是没有苹果识别 / 翻译的电脑
  // key 的加密：Windows 用系统加密；Mac 用 App 自己的加密（没有开发者签名时，钥匙串每次更新后都会弹窗要电脑密码）
  const userData = app.getPath("userData");
  const settings = process.platform === "darwin"
    ? new Settings(path.join(userData, "settings.json"), new FileCrypto(path.join(userData, "secret.key")), safeStorage)
    : new Settings(path.join(userData, "settings.json"), safeStorage);
  const records = new Records(process.env.CT_RECORDS_DIR ?? path.join(app.getPath("documents"), "课堂同传"));
  const llm = new LLM(settings);
  const appleTr = new AppleTranslator(bins.translate);
  // 人声检测模型启动时就开始加载；云端识别第一次用到时等它加载完
  const vadReady = VoiceDetector.load(path.join(here, "../../assets/silero_vad.onnx"));
  vadReady.catch((e) => console.error("人声检测模型加载失败", e));
  const vad = { hasVoice: async (f32) => (await vadReady).hasVoice(f32) };
  // 原声录音：默认不存；开了以后和课堂记录放在一起，超过保留天数自动删
  const cleanAudio = () => { try { cleanOldAudio(records.dir, settings.pref("audioKeepDays", 7)); } catch {} };
  cleanAudio();
  setInterval(cleanAudio, 6 * 3600_000).unref();
  const activity = new Activity(powerSaveBlocker), locked = new Set();
  const translateOffline=async(text,src,target,provider)=>{
    const r=await (provider==="local"?localTr:appleTr).translate(text,src,target);
    if(!r.tr)throw new Error("本地翻译不可用，请检查语言对或选择 AI 翻译");return r.tr;
  };
  const jobs = new AudioJobs({translateOffline, records,settings,llm,activity,locked,directory:path.join(userData,"audio-tasks"),fetcher:(url,opts)=>net.fetch(url,opts) });
  const makeSession = (send) => { const current = new Session({
    send:(m)=>{send(m);if(captionSession===current.name)caption(m);}, llm, recoveryFactory:settings.pref("recoveryEnabled",false) ? name=>new RecoveryJournal(jobs,name) : null, recover:name=>jobs.recover(name,true), appleTr: caps.appleTranslate ? appleTr : NO_APPLE_TR, localTr, records, caps,
    makeRecorder: (name) => (settings.pref("saveAudio", false) || process.env.CT_SMOKE_AUDIO ? new AudioRecorder(records.audioFile(name)) : null),
    makeAsr: (kind, speaker, offset) => {
      if (kind === "deepgram") return new DeepgramASR({ key: settings.getKey("deepgram"), speaker, offset, terms:keyterms(settings) });
      if (kind === "speech") return new CloudASR({ kind, llm: { recognize: (wav) => new SpeechClient(settings).recognize(wav, speaker) }, vad, speaker, offset });
      if (kind === "cloud") return new CloudASR({ llm, vad, speaker, offset });
      if (kind === "local") return new LocalASR({ workerPath: localWorker, modelDir, speaker, offset });
      return new AppleASR(bins.asr, speaker, offset);
    },
  });
    captionSession=current.name;caption({type:"partial",text:"等待字幕…"});
    locked.add(current.name);
    const stop=current.stop.bind(current), dispose=current.dispose.bind(current);
    current.stop=async()=>{try{return await stop();}finally{locked.delete(current.name);}};
    current.dispose=()=>{try{return dispose();}finally{locked.delete(current.name);}};
    return current;
  };
  const retryTimer=setInterval(async()=>{if(activity.busy || updater.opening || !settings.pref("recoveryEnabled",false))return;for(const item of jobs.pending()){const r=await jobs.recover(item.record);if(!r.ok)break;}},60000);retryTimer.unref();
  const version = process.env.CT_FAKE_VERSION ?? app.getVersion();
  const updater = new InstallerUpdate({ current: version, platform: process.platform, arch: process.arch,
    directory: path.join(userData, "updates"), fetch: (url, opts) => net.fetch(url, opts),
    openPath: (file) => shell.openPath(file), isBusy: () => activity.busy });
  const checkUpdate = () => updater.check();
  const baseApi = createApi({
    settings, llm, appleTr, records, caps, version, cleanAudio, checkUpdate, updater,
    openExternal: (u) => shell.openExternal(u),
    openPath: (p) => { fs.mkdirSync(p, { recursive: true }); return shell.openPath(p); },
    askMic: () => (process.platform === "darwin" ? systemPreferences.askForMediaAccess("microphone") : Promise.resolve(true)),
    savePdf: (html, name) => savePdf(mainWindow, html, name),
  });
  const extended = libraryApi({records,settings,llm,jobs,locked,toggleOverlay,translateOffline});
  const api=async(url,method,body)=>{
    if(updater.opening && method === "POST" && ["/api/import/begin","/api/recovery/retry","/api/report","/api/library/edit"].includes(url))return {ok:false,msg:"正在打开安装包，请稍后开始处理"};
    const result=await extended(url,method,body);
    if(result!==undefined)return result;
    if(method==="POST" && url==="/api/report"){
      if(locked.has(body?.record))return {ok:false,msg:"记录正在处理中，请稍后生成"};
      locked.add(body.record);try{return await baseApi(url,method,body);}finally{locked.delete(body.record);}
    }
    return baseApi(url,method,body);
  };
  // 旧版存在钥匙串里的 key：等窗口显示出来再转存（系统弹窗期间 App 会卡住，先弹的话窗口是一片白）
  const migrateKeys = () => { if (settings.migrateLegacy()) llm.configure(); };
  return { api, activity, updater, makeSession, makeSystemAudio: () => new SystemAudio(bins.syscap), appleTr, localTr, migrateKeys };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, title: "课堂同传",
    webPreferences: { preload: path.join(here, "../preload/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(here, "../renderer/index.html"));
  return win;
}

/** 冒烟测试：不开窗口，按实时速度把一段 wav 喂给一节课，打印所有消息 */
async function runSmoke({ makeSession }) {
  const wav = fs.readFileSync(process.env.CT_SMOKE_WAV);
  const pcm = wav.subarray(wav.indexOf("data") + 8);
  const s = makeSession((m) => console.log("SMOKE " + JSON.stringify(m)));
  s.configure({ speaker: process.env.CT_SMOKE_SPEAKER ?? "en", target: "zh", asr: process.env.CT_SMOKE_ASR ?? "apple", translator: process.env.CT_SMOKE_TRANSLATOR ?? "apple" });
  for (const chunk of [pcm, Buffer.alloc(SR * 2 * 2)]) {
    for (let i = 0; i < chunk.length; i += 3200) {
      s.audio(chunk.subarray(i, i + 3200));
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await s.stop();
  app.quit();
}

async function main() {
  await app.whenReady();
  const deps = build();
  // Windows 上窗口顶部默认有一排英文菜单（File / Edit / View / Window），用不上，去掉；Mac 的菜单在屏幕顶部，保留（复制粘贴快捷键靠它）
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  if (!app.isPackaged && process.platform === "darwin") app.dock.setIcon(path.join(here, "../../assets/icon.png")); // 开发时程序坞也用新图标
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");
  if (process.platform === "win32") {
    // Windows 录电脑内部声音：直接给整个屏幕 + 系统回环音频，不弹选择框（视频轨道在窗口里会马上停掉）
    session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
      desktopCapturer.getSources({ types: ["screen"] })
        .then((sources) => callback({ video: sources[0], audio: "loopback" }))
        .catch(() => callback({}));
    });
  }
  if (process.env.CT_SMOKE_WAV) return runSmoke(deps);
  registerIpc({ ipcMain, ...deps });
  mainWindow = createWindow();
  mainWindow.on("closed",()=>{if(overlayWindow&&!overlayWindow.isDestroyed())overlayWindow.close();});
  mainWindow.webContents.once("did-finish-load", () => setTimeout(deps.migrateKeys, 800));
  if (process.env.CT_SMOKE_OPEN) {
    mainWindow.webContents.on("console-message", (_e, _lvl, msg) => console.log("CONSOLE " + msg));
    mainWindow.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.CT_SMOKE_DELAY ?? 1500)));
      const state = await mainWindow.webContents.executeJavaScript(
        `JSON.stringify({ menu: ${JSON.stringify(!!Menu.getApplicationMenu())}, powered: document.querySelector(".powered")?.textContent.trim(), inFoot: !!document.querySelector(".card-foot .powered"), standalone: !!document.querySelector("footer.powered"), asr: [...document.querySelectorAll("#asr option")].map(o => o.textContent), speaker: document.querySelector("#speaker").value, speakers: [...document.querySelectorAll("#speaker option")].map(o => o.value), mics: [...document.querySelectorAll("#mic option")].map(o => o.textContent), privacyApple: !document.querySelector(".apple-only")?.hidden })`);
      if (process.env.CT_SMOKE_SHOT) fs.writeFileSync(process.env.CT_SMOKE_SHOT, (await mainWindow.webContents.capturePage()).toPNG());
      console.log("window-loaded " + state);
      app.quit();
    });
  }
  app.on("window-all-closed", () => { deps.appleTr.stop(); deps.localTr.stop(); app.quit(); });
}

main();
