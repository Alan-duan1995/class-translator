import { LivePreview } from "./live-preview.js";
import { PROVIDER_LABELS, TARGET_LANGS, TRANSLATORS, SPEAKER_LANGS, SR, SUMMARY_CONTEXT_CHARS, SUMMARY_INTERVAL_MS, SUMMARY_RETRY_MS } from "./langs.js";
import { simplify, friendly, fmtTs } from "./text.js";
import { acceptFinal, acceptPartial } from "./apple/filter.js";
import { acceptCloudFinal } from "./cloud/filter.js";
import { AllModelsBusy, NoKey, isAuthError } from "./llm/errors.js";
import { acceptLocalFinal, LOCAL_MIN_CONF } from "./local/filter.js";

const DEFAULTS = { speaker: "en", target: "zh", asr: "apple", translator: "gemini", fastPreview: true };
const MAX_PARALLEL_TRANSLATIONS = 6;

/** 一节课：收音频 → 苹果识别 → 字幕 → 后台翻译 → 定时更新笔记 → 每句存盘 */
export class Session {
  constructor({ send, llm, appleTr, localTr, records, caps, makeAsr, makeRecorder, recoveryFactory, recover, sleep, now }) {
    Object.assign(this, { send, llm, appleTr, records, caps, makeAsr });
    this.localTr = localTr ?? { translate: async () => ({ tr: "", code: "unsupported" }) };
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now ?? Date.now;
    this.cfg = { ...DEFAULTS };
    this.name = records.newName();
    this.recorder = makeRecorder?.(this.name) ?? null; // 开了「保存录音」才有
    this.recoveryFactory=recoveryFactory;this.recover=recover;this.recovery=null;this.nextRetry=0;
    this.lines = [];
    this.summary = "";
    this.summarizedUpto = 0;
    this.summarizing = false;
    this.summaryFailing = false; // 上一次更新课堂笔记是不是失败了
    this.lastSummaryAt = this.now();
    this.translations = new Set();
    this.active = 0;
    this.waiters = [];
    this.samples = 0;         // 已收到的音频样本数，用来算时间
    this.asr = null;
    this.crashes = new Map(); // 每种识别方式出错的次数
    this.failed = new Set();  // 连续出错的「识别方式:说话人语言」，不再重启
    this.paused = false;
    this.fallbackNoted = false;
    this.warned = new Set();
    this.disposed = false;
    this.cloudCooldown = new Map();
    this.preview = new LivePreview({
      translate: text => this.localTr.pending?.size ? Promise.resolve(null) : this.localTr.translate(text, "en", "zh"),
      publish: ({text,tr}) => this.send({type:"partial_translation",text,tr:simplify(tr,"zh")}),
    });
  }

  configure(cfg = {}) {
    if(this.recovery && ((cfg.asr && cfg.asr!=="deepgram") || (cfg.speaker && cfg.speaker!=="en"))) {
      this.send({type:"error",msg:"补转写录制期间请保持 Deepgram 英语识别；切换前请结束本次录制"});return;
    }
    this.preview.clear();
    if (typeof cfg.fastPreview === "boolean") this.cfg.fastPreview = cfg.fastPreview;
    const speakerChanged = cfg.speaker && this.asr && cfg.speaker !== this.asr.speaker;
    if (this.asr && (speakerChanged || (cfg.asr && cfg.asr !== this.asr.kind))) {
      const old = this.asr; // 说到一半的那句会先确定下来
      this.asr = null;
      old.close();
    }
    if (cfg.speaker in SPEAKER_LANGS) this.cfg.speaker = cfg.speaker;
    if(!this.recovery && this.samples===0 && cfg.asr==="deepgram" && this.recoveryFactory)this.recovery=this.recoveryFactory(this.name);
    this.recovery?.configure({...this.cfg,...cfg});
    if (cfg.target in TARGET_LANGS) this.cfg.target = cfg.target;
    if (cfg.asr) this.cfg.asr = cfg.asr;
    if (cfg.translator in TRANSLATORS && cfg.translator !== this.cfg.translator) {
      this.cfg.translator = cfg.translator;
      this.fallbackNoted = false;
    }
    if (this.previewEnabled()) { try { this.localTr.warmup?.(); } catch {} }
    // Connect/load while the renderer prepares audio capture, before the first chunk.
    const kind = this.asrKind();
    if (!this.asr && this.samples === 0 && ["deepgram", "local"].includes(kind) && this.cfg.speaker === "en") this.startAsr(kind);
  }

  previewEnabled() { return !this.disposed && this.cfg.fastPreview && this.cfg.speaker === "en" && this.cfg.target === "zh" && this.caps.localTranslate; }
  partial(text) {
    this.send({type:"partial",text});
    if(this.previewEnabled()) this.preview.update(text); else this.preview.clear();
  }

  warnOnce(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.send({ type: "error", msg });
  }

  /** 这节课用哪种识别：苹果（新 Mac）、本地实时（英语）或云端（Gemini）；都用不了返回 null */
  asrKind() {
    if (this.cfg.asr === "apple" && this.caps.appleAsr) return "apple";
    if (this.cfg.asr === "local" && this.caps.localAsr) return "local";
    if (this.cfg.asr === "deepgram" && this.caps.cloudAsr) return "deepgram";
    if (this.cfg.asr === "speech" && this.caps.cloudAsr) return "speech";
    if (this.cfg.asr === "cloud" && this.caps.cloudAsr) return "cloud";
    return null;
  }

  audio(buf) {
    if (this.paused) return;
    const kind = this.asrKind();
    if (!kind) {
      return this.warnOnce("no-asr", "这台电脑用不了苹果自带识别（需要 macOS 26 或更新），请在「识别方式」里选「本地实时」或「云端（Gemini）」。");
    }
    if (kind === "deepgram" && this.cfg.speaker !== "en") {
      return this.warnOnce("deepgram-lang", "Deepgram 实时识别目前只支持英语，请把说话语言设为英语");
    }
    if (kind === "local" && this.cfg.speaker !== "en") {
      return this.warnOnce("local-lang", "本地实时识别目前只支持英语，请把「识别方式」改成「云端（Gemini）」。");
    }
    if(this.recovery){try{this.recovery.feed(buf);}catch(e){this.warnOnce("recovery",e.message);try{this.recovery.close();}catch{}this.recovery=null;}}
    if(this.recovery && this.failed.has(`${kind}:${this.cfg.speaker}`) && this.now()>=this.nextRetry){this.failed.delete(`${kind}:${this.cfg.speaker}`);}
    if (this.failed.has(`${kind}:${this.cfg.speaker}`)) {
      this.record(buf);this.samples+=buf.length/2;
      return this.warnOnce(`crash-${kind}`, this.recovery ? "连接中断，音频正在本机缓存，约 30 秒后重连；结束时尝试补转写" : "识别程序连续出错，已停止识别。请结束录制后重新开始，或者在「识别方式」里换一种。");
    }
    if (!this.asr) this.startAsr(kind);
    this.asr?.feed(buf);
    this.record(buf); // 和下面的计时同步：录音里的第几秒就是字幕上的第几秒
    this.samples += buf.length / 2;
  }

  record(buf) {
    if (!this.recorder) return;
    try {
      this.recorder.write(buf);
    } catch (e) { // 磁盘满、没权限：不影响字幕，停止录音并提示一次
      this.closeRecorder();
      this.warnOnce("audio", `录音保存失败（${String(e?.message ?? e).slice(0, 60)}），这节课后面的录音不再保存；字幕不受影响`);
    }
  }
  closeRecorder() {
    const r = this.recorder;
    this.recorder = null;
    try { r?.close(); } catch {}
  }

  startAsr(kind) {
    const asr = this.makeAsr(kind, this.cfg.speaker, this.samples / SR);
    this.send({ type: "connection", state: "connecting", text: kind === "deepgram" ? "正在连接 Deepgram…" : "正在启动识别…" });
    asr.on("message", (m) => this.onAsr(asr, m));
    asr.on("exit", (code) => {
      if (this.asr === asr) this.asr = null;
      if (code !== 0 && code !== -1) {
        this.recovery?.failed();this.nextRetry=this.now()+30000;      // -1 是我们自己关掉的
        this.crashes.set(asr.kind, (this.crashes.get(asr.kind) ?? 0) + 1);
        // 下一段音频时自动重启一次，再出错就停
        if (this.crashes.get(asr.kind) >= 2) this.failed.add(`${asr.kind}:${asr.speaker}`);
        if (this.cfg.asr === asr.kind) this.send({ type: "connection", state: this.crashes.get(asr.kind) >= 2 ? "failed" : "reconnecting",
          text: this.recovery ? "连接中断，音频已缓存，正在尝试重连；结束时补转写" : this.crashes.get(asr.kind) >= 2 ? "识别已停止，请结束后重试或切换识别方式" : "识别连接中断，下一段音频到来时重连；期间可能遗漏字幕" });
      }
    });
    this.asr = asr;
    asr.start();
  }

  onAsr(asr, m) {
    if (m.type === "partial" && this.asr !== asr) return;
    if (m.type === "final") this.preview.clear();
    if(m.type==="coverage"){if(this.asr===asr || this.stoppingAsr===asr)this.recovery?.coverage(asr.offset+m.end);return;}
    if (m.type === "connection") {
      if(m.state==="connected" && this.asr===asr)this.recovery?.boundary(asr.offset);
      if (this.asr === asr) this.send(m);
      return;
    }
    if (["partial", "final"].includes(m.type) && this.asr === asr && asr.kind !== "deepgram") {
      if (!asr.reportedReady) { asr.reportedReady = true; this.send({ type: "connection", state: "connected", text: "识别正在工作" }); }
    }
    if (m.type === "error" && this.asr === asr) this.send({ type: "connection", state: "error", text: m.msg });
    if (m.type === "partial" && asr.kind === "local" && m.conf >= 0 && m.conf < LOCAL_MIN_CONF) {
      this.partial(""); // 把握很低：多半是旁边有人在说别的语言，乱码草稿不显示
    } else if (m.type === "partial") {
      if (!m.text || acceptPartial(m.text, asr.speaker)) this.partial(m.text);
    } else if (m.type === "final" && m.source === "deepgram") {
      this.partial("");
      if (m.text?.trim()) this.addLine(m.text.trim(), "en", "", asr.offset + m.start, m.speakerId);
    } else if (m.type === "final" && m.source === "local") {
      const r = acceptLocalFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start);
    } else if (m.type === "final" && m.source === "cloud") {
      const r = acceptCloudFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start); // 翻译统一走 translateLine：带上文、按所选方式
    } else if (m.type === "final") {
      this.partial("");
      const r = acceptFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start);
    } else if (m.type === "status") {
      this.send({ type: "status", recognizing: !!m.recognizing });
    } else if (m.type === "downloading") {
      this.send({ type: "error", msg: "第一次用这种语言，正在下载苹果语音模型，稍等片刻…" });
    } else if (m.type === "error") {
      this.send({ type: "error", msg: asr.kind === "apple" ? `苹果识别出错：${String(m.msg ?? "").slice(0, 60)}` : m.msg });
    }
  }

  /** 新增一句字幕：去重、推给窗口、需要的话后台翻译 */
  addLine(text, lang, tr, t, speakerId = null) {
    const target = this.cfg.target;
    const context = this.lines.slice(-3).map((l) => l.text);
    const last = this.lines.at(-1);
    if (last && last.text === text && (last.speakerId ?? null) === speakerId && t - last.t < 10) return null; // 几秒内一字不差的重复，多半是杂音胡编
    const line = { id: this.lines.length, t, text, tr: "", lang, same: lang === target };
    if (speakerId !== null) line.speakerId = speakerId;
    this.lines.push(line);
    if (!line.same) line.tr = simplify(tr, target);
    this.send({ type: "line", ...line });
    if (!(line.same || line.tr)) {
      const p = this.translateLine(line, context, target, this.cfg.translator);
      this.translations.add(p);
      p.finally(() => this.translations.delete(p));
    }
    this.save();
    if (this.now() - this.lastSummaryAt >= SUMMARY_INTERVAL_MS) this.updateSummary();
    return line;
  }

  async withSlot(fn) {
    while (this.active >= MAX_PARALLEL_TRANSLATIONS) await new Promise((r) => this.waiters.push(r));
    this.active += 1;
    try { return await fn(); } finally { this.active -= 1; this.waiters.shift()?.(); }
  }

  async translateLine(line, context, target, provider = this.cfg.translator) {
    let settled = false;
    // Keep showing useful Chinese while the chosen AI handles context and terminology.
    if (this.previewEnabled() && line.lang === "en" && target === "zh" && !["local","apple"].includes(provider) && !this.localTr.pending?.size) {
      Promise.resolve().then(() => this.localTr.translate(line.text,"en","zh")).then(r => {
        if (!settled && this.previewEnabled() && r?.tr) this.send({type:"translation_preview",id:line.id,tr:simplify(r.tr,target)});
      }).catch(() => {});
    }
    try {
      const tr = await this.withSlot(() => this.translateText(line.text, line.lang, context, target, provider));
      line.tr = simplify(tr, target);
      if (!this.disposed) this.send({ type: "translation", id: line.id, tr: line.tr });
      this.save();
    } finally { settled = true; }
  }

  /** 不联网的直译：苹果翻译（新 Mac）和本地翻译（英语 → 简体中文），选了哪个先用哪个，翻不了再试另一个 */
  async offlineTranslate(text, src, target, provider = this.cfg.translator) {
    const apple = ["苹果翻译", this.appleTr], local = ["本地翻译", this.localTr];
    let first = null;
    for (const [who, t] of provider === "local" ? [local, apple] : [apple, local]) {
      const r = await t.translate(text, src, target);
      if (r.tr) return { ...r, who };
      first ??= { ...r, who };
    }
    return first;
  }

  /** 按选的翻译方式翻；AI 模型用不了时改用苹果翻译 / 本地翻译顶上 */
  async translateText(text, src, context, target, provider = this.cfg.translator) {
    let err = null;
    const fastFallback = src === "en" && target === "zh" && (this.caps.localTranslate || this.caps.appleTranslate);
    const cooldown = this.cloudCooldown.get(provider);
    if (fastFallback && cooldown?.until > this.now()) err = cooldown.error;
    if (!err && !["apple", "local"].includes(provider)) {
      for (const wait of [0, 3000, 8000]) { // 失败了等一会儿再试，最多 3 次
        if (wait) await this.sleep(wait);
        try {
          const result = await this.llm.translate(text, context, TARGET_LANGS[target], provider, {realtime:fastFallback});
          this.cloudCooldown.delete(provider);
          return result;
        } catch (e) {
          err = e;
          if (fastFallback) { this.cloudCooldown.set(provider,{until:this.now()+15000,error:e}); break; }
          if (e instanceof AllModelsBusy || e instanceof NoKey || String(e?.message).includes("PerDay")) break;
          if (isAuthError(e) || [402, 404].includes(e?.status)) break; // key、地址或模型名不对，余额不足：再试也没用
        }
      }
    }
    const { tr, code, who: offline } = await this.offlineTranslate(text, src, target, provider);
    if (tr) {
      if (err && !this.fallbackNoted) {
        this.fallbackNoted = true;
        const who = PROVIDER_LABELS[provider] ?? "AI 翻译";
        this.send({ type: "error", msg: `${who} 用不了（${friendly(err)}），先改用${offline}顶上（直译，不会纠正识别错字）` });
      }
      return tr;
    }
    if (err) return `（翻译失败：${friendly(err)}）`;
    if (code === "not_installed") { // 苹果翻译还没下载这对语言：有 key 就先用 AI 翻
      for (const p of this.llm.available()) {
        try { return await this.llm.translate(text, context, TARGET_LANGS[target], p); } catch {}
      }
      return "（苹果翻译还没下载这对语言，请在「AI 模型与 API」里点「打开系统设置下载语言」）";
    }
    if (provider === "local") return "（翻译失败：本地翻译目前只支持英语译成简体中文，其他语言请改用 AI 模型）";
    return "（翻译失败：苹果翻译不支持这对语言）";
  }

  summaryProvider() {
    const avail = this.llm.available();
    if (avail.includes(this.cfg.translator)) return this.cfg.translator;
    if (avail.length) return avail[0];
    throw new NoKey("要生成课堂笔记，需要先在「AI 模型与 API」里填好一个 AI 模型的 key");
  }

  async updateSummary(final = false) {
    if (this.summarizing || !this.lines.length) return;
    this.summarizing = true;
    this.lastSummaryAt = this.now();
    this.send({ type: "summary_status", busy: true });
    let failed = false;
    try {
      // 只增不改：每次只把新讲的内容整理成一段，接在后面；以前的笔记不再交给 AI 重写（重写时它会把前面的内容弄丢）
      const fresh = this.lines.slice(this.summarizedUpto);
      if (fresh.length) {
        const upto = this.lines.length;
        const part = await this.llm.summarize(fresh.map((l) => l.text).join("\n"), this.summary.slice(-SUMMARY_CONTEXT_CHARS), TARGET_LANGS[this.cfg.target], this.summaryProvider());
        const head = `*${fmtTs(fresh[0].t)} – ${fmtTs(fresh.at(-1).t)}*`;
        this.summary = [this.summary, `${head}\n\n${String(part).trim()}`].filter(Boolean).join("\n\n");
        this.summarizedUpto = upto;
      }
      this.summary = simplify(this.summary, this.cfg.target);
      this.send({ type: "summary", md: this.summary });
      this.save();
    } catch (e) {
      failed = true;
      const retry = !final && !(e instanceof NoKey);
      // 服务器忙、超时：过 30 秒就再试，不等满一轮；连续失败只提示第一次
      if (retry) this.lastSummaryAt = this.now() - SUMMARY_INTERVAL_MS + SUMMARY_RETRY_MS;
      if (!this.summaryFailing) this.send({ type: "error", msg: `课堂笔记更新失败：${friendly(e)}${retry ? "，过一会儿自动再试" : ""}` });
    } finally {
      this.summaryFailing = failed;
      this.summarizing = false;
      this.send({ type: "summary_status", busy: false, failed });
    }
  }

  async idle() { while (this.translations.size) await Promise.allSettled([...this.translations]); }

  /** 结束录制：最后一句确定下来 → 等翻译 → 最终笔记 → 通知窗口 */
  async stop() {
    this.preview.close();
    this.closeRecorder();
    if (this.asr) { const a = this.asr; this.asr = null; this.stoppingAsr=a; try { await a.close(); } finally {this.stoppingAsr=null;} }
    await this.idle();
    while(this.summarizing)await this.sleep(30);
    if(this.recovery){
      this.recovery.close();this.save();
      const result=await this.recover(this.name);
      if(this.records.exists(this.name)){const data=this.records.load(this.name);this.lines=data.lines;this.summary="";this.summarizedUpto=0;}
      if(!result.ok) this.send({type:"error",msg:"补转写未完成，已保留本机缓存，可在记录管理中重试"});
    }
    await this.updateSummary(true);
    this.save();
    this.send({ type: "done", record: this.name });
  }

  /** 关窗口 / 退出：立刻杀掉子程序并存盘 */
  dispose() {
    this.disposed = true; this.preview.close();
    try{this.recovery?.close();}catch(e){this.warnOnce("recovery",e.message);}
    this.closeRecorder();
    if (this.asr) { this.asr.kill(); this.asr = null; }
    this.save();
  }

  save() {
    if (!this.lines.length) return;
    try {
      this.records.save(this.name, this.summary, this.lines);
    } catch (e) { // 比如没允许访问「文稿」或磁盘满：字幕照常出，只提示一次；之后能写了会整份重存
      this.warnOnce("save", `课堂记录保存不了（${e.code ?? e.message}）。请到 系统设置 → 隐私与安全 → 文件与文件夹 里允许「课堂同传」访问「文稿」文件夹`);
    }
  }
}
