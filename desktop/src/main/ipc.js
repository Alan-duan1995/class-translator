import { audioLevel } from "./activity.js";
const SYS_HINT = "请到 系统设置 → 隐私与安全 → 录屏与系统录音 里允许「课堂同传」";

/** 窗口 ↔ 后台：每个窗口最多一节进行中的课 */
export function registerIpc({ ipcMain, api, makeSession, makeSystemAudio, activity, updater }) {
  const live = new Map(); // webContents.id → {session, sys, send}
  const closeFor = (id) => {
    const x = live.get(id);
    if (!x) return;
    x.sys?.stop();
    try { x.session.dispose(); } finally { live.delete(id); x.release(); }
  };

  ipcMain.handle("api", async (_e, { url, method, body }) => {
    const release = url === "/api/report" && method === "POST" ? activity?.acquire() : null;
    try { return await api(url, method, body); } finally { release?.(); }
  });

  ipcMain.handle("session:open", (e) => {
    if (updater?.opening) throw new Error("正在打开安装包，请稍后开始录制");
    const wc = e.sender;
    closeFor(wc.id);
    let session = null;
    // 每条消息都带上所属课的标识，窗口据此丢掉上一节课迟到的消息
    const send = (m) => { if (!wc.isDestroyed()) wc.send("session:msg", { ...m, sid: session?.name }); };
    session = makeSession(send);
    const release = activity?.acquire() ?? (() => {});
    live.set(wc.id, { session, sys: null, send, release, meterAt: 0 });
    wc.once("destroyed", () => closeFor(wc.id)); // 关窗口：存盘并杀掉子程序
    return { record: session.name, audio: !!session.recorder };
  });

  const feed = (x, buf) => {
    if (!x.session.paused && Date.now() - x.meterAt >= 100) {
      x.meterAt = Date.now();
      x.send({ type: "audio_level", level: audioLevel(buf) });
    }
    x.session.audio(buf);
  };

  ipcMain.on("session:audio", (e, data) => {
    const x = live.get(e.sender.id);
    if (x && !x.sys) feed(x, Buffer.from(data));
  });

  ipcMain.on("session:cmd", async (e, cmd) => {
    const x = live.get(e.sender.id);
    if (!x) return;
    if (cmd.startsWith("{")) {
      const cfg = JSON.parse(cmd);
      x.session.configure(cfg);
      if (cfg.source === "system" && !x.sys) {
        x.sys = makeSystemAudio();
        x.sys.on("data", (b) => feed(x, b));
        x.sys.on("problem", (msg) => x.send({ type: "error", msg: `录不到电脑内部声音：${msg}。${SYS_HINT}` }));
        x.sys.start();
      } else if (cfg.source === "mic" && x.sys) {
        x.sys.stop();
        x.sys = null;
      }
    } else if (cmd === "pause") x.session.paused = true;
    else if (cmd === "resume") x.session.paused = false;
    else if (cmd === "summary") x.session.updateSummary();
    else if (cmd === "stop") {
      x.sys?.stop();
      x.sys = null;
      live.delete(e.sender.id); // 收尾（最后一句、最终笔记、存盘）在后台做完；这期间窗口可以马上开新课，不会打断它
      try {
        await x.session.stop();
      } catch (err) { // 收尾出错也一定通知窗口结束，免得界面一直卡在"收尾中"
        x.send({ type: "error", msg: `结束录制时出错：${String(err?.message ?? err).slice(0, 80)}` });
        x.send({ type: "done", record: x.session.name });
      } finally { x.release(); }
    }
  });

  ipcMain.on("session:close", (e) => closeFor(e.sender.id));
}
