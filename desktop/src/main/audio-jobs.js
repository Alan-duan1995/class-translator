import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AudioRecorder, readAudioChunk } from './store/audio.js';
import { keyterms } from './glossary.js';
import { SpeechClient } from './cloud/openai-asr.js';
import { TARGET_LANGS, SPEAKER_LANGS } from './langs.js';

export async function deepgramFile(wav, settings, fetcher = globalThis.fetch) {
  const key = settings.getKey('deepgram');
  if (!key) throw new Error('请先填写 Deepgram Key');
  const query = new URLSearchParams({ model:'nova-3', language:'en', punctuate:'true', smart_format:'true', utterances:'true', diarize:'true' });
  for (const term of keyterms(settings)) query.append('keyterm', term);
  let r;
  try { r = await fetcher(`https://api.deepgram.com/v1/listen?${query}`, { method:'POST', headers:{ Authorization:`Token ${key}`, 'Content-Type':'audio/wav' }, body:wav, signal:AbortSignal.timeout(120000), redirect:'error' }); }
  catch { throw new Error('Deepgram 文件转写连接失败，请检查网络后重试'); }
  if (!r.ok) throw new Error(`Deepgram 文件转写失败（${r.status}），请检查 Key 或额度`);
  const d = await r.json();
  const utterances = d.results?.utterances;
  if (Array.isArray(utterances) && utterances.length) return utterances.filter(u => u.transcript?.trim()).map(u => ({ text:u.transcript.trim(), t:Number(u.start)||0, lang:'en', ...(Number.isInteger(u.speaker) ? {speakerId:u.speaker} : {}) }));
  const text = d.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof text !== 'string') throw new Error('Deepgram 返回格式不正确');
  return text.trim() ? [{ text:text.trim(), t:0, lang:'en' }] : [];
}
export class AudioJobs {
  constructor({ records, settings, llm, activity, directory, fetcher, locked, translateOffline }) {
    Object.assign(this,{records,settings,llm,activity,directory,fetcher,locked,translateOffline});
    fs.mkdirSync(directory,{recursive:true}); this.jobs = new Map(); this.runningRecovery = new Set();
    // Imports interrupted by an app exit cannot resume; remove only our UUID staging files.
    for (const f of fs.readdirSync(directory)) if (/^[0-9a-f]{8}-[0-9a-f-]{27}\.wav$/.test(f)) fs.rmSync(path.join(directory,f),{force:true});
  }
  begin(cfg) {
    if ([...this.jobs.values()].some(j => ['uploading','processing'].includes(j.phase))) throw new Error('请先完成或取消当前导入');
    if (!['deepgram','cloud','speech'].includes(cfg.asr)) throw new Error('请选择导入所用的云端语音服务');
    if (!(cfg.target in TARGET_LANGS) || !(cfg.speaker in SPEAKER_LANGS)) throw new Error('语言不支持');
    if (cfg.asr === 'deepgram' && cfg.speaker !== 'en') throw new Error('Deepgram 导入目前只支持英语');
    if (cfg.asr === 'deepgram' && !this.settings.getKey('deepgram')) throw new Error('请先填写 Deepgram Key');
    const id = crypto.randomUUID(), name = this.records.newName(), file = path.join(this.directory,id+'.wav');
    const j = {id,name,file,cfg:{...cfg},phase:'uploading',progress:0,bytes:0,cancelled:false,release:this.activity.acquire(),recorder:new AudioRecorder(file),message:''};
    for(const [oldId,old] of this.jobs)if(!['uploading','processing'].includes(old.phase))this.jobs.delete(oldId);
    this.jobs.set(id,j); this.locked.add(name);
    return this.status(id);
  }
  status(id) { const j=this.jobs.get(id); if(!j)throw new Error('找不到导入任务'); return {id:j.id,record:j.name,phase:j.phase,progress:j.progress,message:j.message}; }
  append(id, bytes) {
    const j=this.jobs.get(id); if(!j || j.phase!=='uploading')throw new Error('导入任务不可写入');
    const buf=Buffer.from(bytes); if(buf.length>32000*10 || buf.length%2)throw new Error('音频块格式不正确');
    if(j.bytes+buf.length>32000*1800)throw new Error('导入最长 30 分钟');
    j.recorder.write(buf); j.bytes+=buf.length; return {ok:true};
  }
  finish(id) { const j=this.jobs.get(id); if(!j || j.phase!=='uploading')throw new Error('导入状态不正确');
    j.recorder.close(); j.phase='processing'; j.promise=this.runImport(j); return this.status(id); }
  cancel(id) { const j=this.jobs.get(id); if(!j)return; j.cancelled=true; if(j.phase==='uploading') {j.phase='cancelled';this.cleanup(j);} }
  cleanup(j) { j.recorder.close();fs.rmSync(j.file,{force:true});this.locked.delete(j.name);j.release(); }
  async recognize(wav,cfg) {
    if(cfg.asr==='deepgram')return deepgramFile(wav,this.settings,this.fetcher);
    const r=cfg.asr==='speech' ? await new SpeechClient(this.settings,{fetch:this.fetcher}).recognize(wav,cfg.speaker) : await this.llm.recognize(wav,SPEAKER_LANGS[cfg.speaker]);
    return r.text ? [{text:r.text,t:0,lang:r.lang}] : [];
  }
  async translate(line,lines,cfg) {
    if(line.lang===cfg.target)return '';
    if(['local','apple'].includes(cfg.translator) && this.translateOffline)return this.translateOffline(line.text,line.lang,cfg.target,cfg.translator);
    return this.llm.translate(line.text,lines.slice(-3).map(l=>l.text),TARGET_LANGS[cfg.target],cfg.translator);
  }
  async runImport(j) {
    const lines=[],meta={importStatus:'processing',title:String(j.cfg.title||'导入录音').slice(0,100),category:'导入录音',target:j.cfg.target,translator:j.cfg.translator};
    try {
      const seconds=j.bytes/32000, step=j.cfg.asr==='deepgram'?120:8;
      if(!seconds)throw new Error('音频为空');
      for(let t=0;t<seconds;t+=step) {
        if(j.cancelled)break;
        const chunk=readAudioChunk(j.file,t,Math.min(step,seconds-t));
        const result=await this.recognize(chunk.wav,j.cfg);
        if(j.cancelled)break;
        for(const part of result) {
          const line={...part,id:lines.length,t:t+part.t,tr:''};
          // Speaker numbers from independently transcribed chunks are not global identities.
          if(Number.isInteger(line.speakerId))line.speakerId+=Math.floor(t/step)*10000;
          try {line.tr=await this.translate(line,lines,j.cfg);}catch{line.tr='（翻译失败，可编辑后重译）';}
          lines.push(line);
        }
        this.records.save(j.name,'',lines,meta);
        j.progress=Math.min(99,Math.round((t+step)/seconds*100));
      }
      if(j.cfg.saveAudio && lines.length)fs.copyFileSync(j.file,this.records.audioFile(j.name));
      meta.importStatus=j.cancelled?'cancelled':'done';if(lines.length)this.records.save(j.name,'',lines,meta);
      j.phase=j.cancelled?'cancelled':'done';j.progress=j.cancelled?j.progress:100;
      j.message=j.cancelled?'已取消，已处理的文字保留':lines.length?'导入完成，可在记录管理中编辑或生成总结':'未识别到文字';
    }catch(e){j.phase='error';j.message=e.message;if(lines.length){meta.importStatus='error';this.records.save(j.name,'',lines,meta);}}
    finally{this.cleanup(j);}
  }
  pending() {
    return fs.readdirSync(this.directory).filter(f=>f.endsWith('.recovery.json')).flatMap(f=>{
      try {const d=JSON.parse(fs.readFileSync(path.join(this.directory,f),'utf8'));if(Date.now()-d.created>7*86400000){this.discard(d.name);return [];}
        return this.locked.has(d.name)?[]:[{record:d.name,gaps:d.gaps.length,created:d.created}];}catch{return [];}
    });
  }
  discard(name) {
    if(!/^[\w-]+\.md$/.test(name))throw new Error('记录名不合法');
    if(this.locked.has(name)||this.runningRecovery.has(name))throw new Error('正在处理，请稍后删除');
    for(const suffix of ['.recovery.json','.recovery.wav'])fs.rmSync(path.join(this.directory,name+suffix),{force:true});
  }
  async recover(name, insideSession=false) {
    if(this.runningRecovery.has(name) || (!insideSession && this.locked.has(name)))throw new Error('记录正在处理中');
    if(!/^[\w-]+\.md$/.test(name))throw new Error('记录名不合法');
    const manifest=path.join(this.directory,name+'.recovery.json');
    if(!fs.existsSync(manifest))return {ok:true};
    this.runningRecovery.add(name);const release=this.activity.acquire();if(!insideSession)this.locked.add(name);
    try {
      const pending=JSON.parse(fs.readFileSync(manifest,'utf8'));
      if(!this.records.exists(name))this.records.save(name,'',[],{target:pending.cfg.target,translator:pending.cfg.translator});
      for(const gap of pending.gaps) {
        for(let t=gap.start;t<gap.end;t+=120) {
          const key=`${gap.start}:${gap.end}:${t}`;
          let data=this.records.load(name);
          if(data.meta.recoveredChunks?.includes(key))continue;
          const chunk=readAudioChunk(path.join(this.directory,name+'.recovery.wav'),t,Math.min(120,gap.end-t));
          if(!chunk)throw new Error("补转写音频缺失或不完整，请检查缓存");
          const parts=await deepgramFile(chunk.wav,this.settings,this.fetcher);
          const additions=[];
          for(const p of parts){const line={text:p.text,lang:'en',t:t+p.t,tr:'',recovered:true};
            try{line.tr=await this.translate(line,data.lines.filter(l=>l.t<line.t),pending.cfg);}catch{line.tr='（翻译失败，可编辑后重译）';}additions.push(line);}
          data=this.records.load(name);
          data.lines.push(...additions);data.lines.sort((a,b)=>a.t-b.t);data.lines.forEach((l,i)=>l.id=i);
          data.meta.recoveredChunks=[...(data.meta.recoveredChunks??[]),key];data.meta.stale=true;
          this.records.save(name,'',data.lines,data.meta);this.records.invalidate(name);
        }
      }
      fs.rmSync(manifest,{force:true});fs.rmSync(path.join(this.directory,name+'.recovery.wav'),{force:true});
      return {ok:true};
    }catch(e){return {ok:false,msg:e.message};}
    finally{this.runningRecovery.delete(name);if(!insideSession)this.locked.delete(name);release();}
  }
}
export class RecoveryJournal {
  constructor(jobs,name){this.jobs=jobs;this.name=name;this.gaps=[];this.open=null;this.covered=0;this.bytes=0;this.recorder=new AudioRecorder(path.join(jobs.directory,name+'.recovery.wav'));this.created=Date.now();this.savedAt=0;}
  configure(cfg){this.cfg={...cfg};}
  feed(buf){if(this.bytes+buf.length>32000*7200)throw new Error('补转写缓存最多两小时，请结束当前录制');this.recorder.write(buf);this.bytes+=buf.length;if(Date.now()-this.savedAt>2000){this.checkpoint();this.savedAt=Date.now();}}
  coverage(end){this.covered=Math.max(this.covered,end);}
  failed(){if(this.open===null)this.open=this.covered;this.checkpoint();}
  boundary(t){if(this.open!==null&&t>this.open)this.gaps.push({start:this.open,end:t});this.open=null;this.covered=Math.max(this.covered,t);this.checkpoint();}
  checkpoint(){const gaps=[...this.gaps];if(this.open!==null&&this.bytes/32000>this.open)gaps.push({start:this.open,end:this.bytes/32000});
    // Include an unacknowledged tail for recovery after abnormal termination.
    if(this.open===null&&this.bytes/32000>this.covered)gaps.push({start:this.covered,end:this.bytes/32000});
    this.jobs.records.atomic(path.join(this.jobs.directory,this.name+'.recovery.json'),JSON.stringify({name:this.name,created:this.created,cfg:this.cfg,gaps}));}
  close(){this.recorder.close();this.checkpoint();}
}
