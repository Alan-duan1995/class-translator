import { TARGET_LANGS } from './langs.js';
import { parseGlossary } from './glossary.js';
export function libraryApi({records,settings,llm,jobs,locked,toggleOverlay,translateOffline}) {
  const assertIdle = name => {if(locked.has(name)||jobs.runningRecovery.has(name))throw new Error('请先结束该记录的录制或处理任务');};
  return async (url,method='GET',body={}) => {
    const u=new URL(url,'app://local'), q=u.searchParams;
    try {
      switch(`${method} ${u.pathname}`) {
        case 'GET /api/library': {
          const term=(q.get('q')??'').toLowerCase(),category=q.get('category')??'';
          return {ok:true,records:records.list().filter(r=>(!category||r.category===category)&&(!term||[r.name,r.title,r.category,records.markdown(r.name)].join('\n').toLowerCase().includes(term)))};
        }
        case 'GET /api/library/record': return {ok:true,...records.load(q.get('record')),record:q.get('record')};
        case 'GET /api/library/export': return {ok:true,md:records.markdown(q.get('record'))};
        case 'POST /api/library/meta': {
          assertIdle(body.record);
          const result=records.edit(body.record,body.revision,d=>{
            d.meta.title=String(body.title??'').replace(/[\r\n]/g,' ').slice(0,100);
            d.meta.category=String(body.category??'').replace(/[\r\n]/g,' ').slice(0,60);
            const names={};
            for(const [id,label] of Object.entries(body.speakers??{})){if(!/^\d+$/.test(id))throw new Error('说话人编号不正确');names[id]=String(label).replace(/[\r\n]/g,' ').slice(0,60);}
            d.meta.speakers=names;d.meta.stale=true;d.summary="";
          });records.invalidate(body.record);return {ok:true,...result};
        }
        case 'POST /api/library/edit': {
          assertIdle(body.record);
          let data=records.load(body.record);
          if(data.revision!==body.revision)throw new Error('记录已改变，请刷新后再修改');
          const line=data.lines.find(l=>l.id===body.id);if(!line)throw new Error('找不到这句转写');
          const text=String(body.text??'').trim();if(!text||text.length>20000)throw new Error('原文需为 1–20000 个字符');
          let tr=String(body.tr??'').slice(0,20000);
          if(body.retranslate){
            if(!(body.target in TARGET_LANGS))throw new Error('目标语言不正确');
            locked.add(body.record);
            try{tr=["local","apple"].includes(body.translator)&&translateOffline ? await translateOffline(text,line.lang||"en",body.target,body.translator) : await llm.translate(text,data.lines.filter(l=>l.t<line.t).slice(-3).map(l=>l.text),TARGET_LANGS[body.target],body.translator);}
            finally{locked.delete(body.record);}
          }
          data=records.edit(body.record,body.revision,d=>{const l=d.lines.find(l=>l.id===body.id);l.originalText??=l.text;l.text=text;l.tr=tr;l.edited=true;d.meta.stale=true;d.summary="";});
          records.invalidate(body.record);return {ok:true,...data};
        }
        case 'GET /api/glossary': return {ok:true,text:settings.pref('glossary',''),recovery:settings.pref('recoveryEnabled',false)};
        case 'POST /api/glossary': parseGlossary(body.text);settings.setPref('glossary',String(body.text));settings.setPref('recoveryEnabled',body.recovery===true);return {ok:true};
        case 'POST /api/import/begin': return {ok:true,...jobs.begin(body)};
        case 'POST /api/import/chunk': return jobs.append(body.id,body.audio);
        case 'POST /api/import/finish': return {ok:true,...jobs.finish(body.id)};
        case 'POST /api/import/cancel': jobs.cancel(body.id);return {ok:true};
        case 'GET /api/import/status': return {ok:true,...jobs.status(q.get('id'))};
        case 'GET /api/recovery': return {ok:true,items:jobs.pending()};
        case 'POST /api/recovery/retry': return jobs.recover(body.record);
        case 'POST /api/recovery/delete': jobs.discard(body.record);return {ok:true};
        case 'POST /api/overlay': toggleOverlay();return {ok:true};
        default:return undefined;
      }
    }catch(e){return {ok:false,msg:String(e.message??e).slice(0,200)};}
  };
}
