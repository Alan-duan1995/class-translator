import fs from "node:fs";
import path from "node:path";
import { fmtTs } from "../text.js";

const NAME_RE = /^[\w-]+\.md$/;
const LINE_RE = /^\*\*\[(\d\d:\d\d:\d\d)\]\*\* (.+)$/;
const REPORT_SUFFIX = "_课后精讲.md";

export const isValidName = (name) => typeof name === "string" && NAME_RE.test(name);

export function newRecordName(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.md`;
}

/** 与网页版 records/*.md 格式一致 */
export function recordMarkdown(stem, summary, lines, meta = {}) {
  const parts = [`# ${meta.title || "课堂记录 " + stem}\n`, "## AI 总结\n", summary || "（暂无）", "\n## 转写\n"];
  for (const l of lines) parts.push(`**[${fmtTs(l.t)}]** ${l.recovered ? "[补转写] " : ""}${Number.isInteger(l.speakerId) ? `${meta.speakers?.[l.speakerId] || (l.speakerId >= 10000 ? `片段 ${Math.floor(l.speakerId / 10000) + 1} · 说话人 ${l.speakerId % 10000 + 1}` : `说话人 ${l.speakerId + 1}`)}：` : ""}${l.text.replace(/\r?\n/g, " ")}\n` + (l.tr ? `\n> ${l.tr}\n` : ""));
  return parts.join("\n");
}

export function parseTranscript(md) {
  return md.split("\n").map((l) => l.match(LINE_RE)).filter(Boolean).map((m) => [m[1], m[2]]);
}

export function reportMarkdown(outline, body, stem, lastTs) {
  const [h, m, s] = lastTs.split(":").map(Number);
  const mt = stem.match(/^(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)/);
  const started = mt ? `${mt[1]} ${mt[2]}:${mt[3]}` : stem;
  const parts = [`# ${outline.title || "课后精讲"}`, "", `> 上课 ${started} · 时长 ${h}h ${m}m ${s}s`, "",
    outline.overview ?? "", "", "## 章节大纲", ""];
  for (const c of outline.chapters ?? []) {
    parts.push(`- **[${c.start ?? ""} – ${c.end ?? ""}] ${c.title ?? ""}**  `, `  ${c.desc ?? ""}`);
  }
  return parts.join("\n") + "\n\n" + body.trim() + "\n";
}

export class Records {
  constructor(dir) { this.dir = dir; this.reserved = new Set(); }
  newName() {
    let d = new Date(), name = newRecordName(d);
    while (this.reserved.has(name) || this.exists(name)) { d = new Date(+d + 1000); name = newRecordName(d); }
    this.reserved.add(name); return name;
  }
  ensureDir() { fs.mkdirSync(this.dir, { recursive: true }); }
  #file(name) {
    if (!isValidName(name)) throw new Error("记录名不合法");
    return path.join(this.dir, name);
  }
  #reportFile(name) { return path.join(this.dir, name.replace(/\.md$/, REPORT_SUFFIX)); }
  /** 这节课的原声录音文件（开了「保存录音」才有） */
  audioFile(name) { return this.#file(name).replace(/\.md$/, ".wav"); }
  hasAudio(name) { return isValidName(name) && fs.existsSync(path.join(this.dir, name.replace(/\.md$/, ".wav"))); }
  exists(name) { return isValidName(name) && fs.existsSync(path.join(this.dir, name)); }
  dataFile(name) { return this.#file(name).replace(/\.md$/, ".json"); }
  atomic(file, text) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }
  load(name) {
    const file = this.#file(name);
    if (!fs.existsSync(file)) throw new Error("找不到这条记录");
    try { const data = JSON.parse(fs.readFileSync(this.dataFile(name), "utf8")); if (data.schema === 1 && Array.isArray(data.lines)) return data; } catch {}
    const md = fs.readFileSync(file, "utf8"), lines = [];
    for (const row of md.split("\n")) {
      const m = row.match(LINE_RE);
      if (m) { const [h,mn,sec] = m[1].split(":").map(Number); let text = m[2]; const who = text.match(/^说话人 (\d+)：/);
        lines.push({ id: lines.length, t:h*3600+mn*60+sec, text:who ? text.slice(who[0].length) : text, tr:"", lang:"en", ...(who ? {speakerId:Number(who[1])-1} : {}) });
      } else if (row.startsWith("> ") && lines.length) lines.at(-1).tr += (lines.at(-1).tr ? "\n" : "") + row.slice(2);
    }
    return { schema:1, revision:0, summary:(md.split("## AI 总结\n")[1]?.split("\n## 转写")[0] ?? "").trim(), lines, meta:{} };
  }
  save(name, summary, lines, meta) {
    this.ensureDir();
    let old = { revision:0, meta:{} };
    if (this.exists(name)) old = this.load(name);
    const data = { schema:1, revision:old.revision+1, summary, lines, meta:meta ?? old.meta };
    this.atomic(this.dataFile(name), JSON.stringify(data));
    this.atomic(this.#file(name), recordMarkdown(name.replace(/\.md$/, ""), summary, lines, data.meta));
    return data;
  }
  edit(name, revision, mutate) {
    const data = this.load(name);
    if (data.revision !== revision) throw new Error("记录已改变，请刷新后再修改");
    mutate(data);
    return this.save(name, data.summary, data.lines, data.meta);
  }
  markdown(name) { return fs.readFileSync(this.#file(name), "utf8"); }
  invalidate(name) {
    for (const mode of ["class", "meeting"]) fs.rmSync(this.reportPath(name, mode), { force:true });
  }
  reportPath(name, mode = "class") { this.#file(name); return mode === "meeting" ? this.#file(name).replace(/\.md$/, "_会议纪要.md") : this.#reportFile(name); }
  transcript(name) {
    const f = this.#file(name);
    return fs.existsSync(f) ? parseTranscript(fs.readFileSync(f, "utf8")) : [];
  }
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(isValidName).sort().reverse().flatMap((name) => {
      const lines = this.transcript(name);
      if (!lines.length) return [];
      const [h, m] = lines.at(-1)[0].split(":").map(Number);
      const report = this.readReport(name);
      const meta = this.load(name).meta;
      return [{ name, stem: name.replace(/\.md$/, ""), lines: lines.length, minutes: h * 60 + m,
        hasReport: !!report, title: meta.title || report?.title || "", hasAudio: this.hasAudio(name), ...(meta.category ? {category:meta.category} : {}) }];
    });
  }
  readReport(name, mode = "class") {
    if (!isValidName(name)) return null;
    const f = this.reportPath(name, mode);
    if (!fs.existsSync(f)) return null;
    const md = fs.readFileSync(f, "utf8");
    return { md, title: md.split("\n", 1)[0].replace(/^#\s*/, "").trim() };
  }
  writeReport(name, md, mode = "class") {
    this.#file(name); // 校验名字
    const f = this.reportPath(name, mode);
    fs.writeFileSync(f, md, "utf8");
    return path.basename(f);
  }
}
