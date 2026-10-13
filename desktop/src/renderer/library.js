(() => {
  const el=id=>document.getElementById(id);
  const request=async(url,body)=>{
    const r=await (await apiFetch(url,body===undefined?{}:{method:'POST',body:JSON.stringify(body)})).json();
    if(r.ok===false)throw Error(r.msg||r.message||'操作失败');return r;
  };
  const action=fn=>async()=>{try{await fn();}catch(e){toast(e.message);}};
  let selected=null, shown=0, importId=null, importing=false, cancelImport=false;
  function label(id){return Number(id)>=10000?`片段 ${Math.floor(id/10000)+1} · 说话人 ${id%10000+1}`:`说话人 ${Number(id)+1}`;}
  el('overlayBtn').onclick=action(()=>request('/api/overlay',{}));
  el('glossaryBtn').onclick=action(async()=>{const d=await request('/api/glossary');el('glossaryText').value=d.text;el('recoveryEnabled').checked=d.recovery;el('glossaryDialog').showModal();});
  el('glossaryClose').onclick=()=>el('glossaryDialog').close();
  el('glossarySave').onclick=action(async()=>{await request('/api/glossary',{text:el('glossaryText').value,recovery:el('recoveryEnabled').checked});el('glossaryDialog').close();toast('已保存，下次录制生效');});
  async function list(select){
    const d=await request(`/api/library?q=${encodeURIComponent(el('recordSearch').value)}&category=${encodeURIComponent(el('recordCategoryFilter').value)}`);
    el('libraryList').textContent='';for(const r of d.records)el('libraryList').add(new Option(`${r.title||r.stem}${r.category?' · '+r.category:''}`,r.name));
    if(d.records.length){el('libraryList').value=d.records.some(r=>r.name===select)?select:d.records[0].name;await pick();}
    else{selected=null;el('recordLines').textContent='暂无匹配记录';el('speakerNames').textContent='';}
  }
  async function pick(){selected=await request('/api/library/record?record='+encodeURIComponent(el('libraryList').value));render();}
  function render(){
    shown=0;el('recordTitle').value=selected.meta.title||'';el('recordCategory').value=selected.meta.category||'';
    el('libraryNotice').textContent=selected.meta.stale?'内容已更新，请重新生成笔记/精讲或会议纪要。':'';
    el('speakerNames').textContent='';
    for(const id of [...new Set(selected.lines.filter(l=>Number.isInteger(l.speakerId)).map(l=>l.speakerId))]){
      const row=document.createElement('label');row.textContent=label(id)+'：';const input=document.createElement('input');input.dataset.speaker=id;input.value=selected.meta.speakers?.[id]||'';input.placeholder='输入姓名（仅本记录）';row.append(input);el('speakerNames').append(row);
    }
    el('recordLines').textContent='';more();
  }
  function more(){
    if(!selected)return;
    for(const line of selected.lines.slice(shown,shown+50)){
      const row=document.createElement('section');row.style.borderTop='1px solid #8885';
      const head=document.createElement('p');head.textContent=`${fmt(line.t)}${line.recovered?' · 补转写':''}${Number.isInteger(line.speakerId)?' · '+(selected.meta.speakers?.[line.speakerId]||label(line.speakerId)):''}`;
      const text=document.createElement('textarea'),tr=document.createElement('textarea');text.value=line.text;tr.value=line.tr||'';text.rows=2;tr.rows=2;text.style.width=tr.style.width='100%';text.setAttribute('aria-label','原文');tr.setAttribute('aria-label','译文');
      const save=document.createElement('button'),translate=document.createElement('button');save.textContent='保存修改';translate.textContent='保存并重译';
      const edit=async retranslate=>{save.disabled=translate.disabled=true;try{
        const result=await request('/api/library/edit',{record:selected.record,revision:selected.revision,id:line.id,text:text.value,tr:tr.value,retranslate,target:el('target').value,translator:el('translator').value});
        selected={...result,record:selected.record};render();toast('已保存');
      }finally{save.disabled=translate.disabled=false;}};
      save.onclick=action(()=>edit(false));translate.onclick=action(()=>edit(true));
      row.append(head,text,tr,save,translate);
      if(line.originalText){const old=document.createElement('details');const title=document.createElement('summary');title.textContent='最初识别原文';const p=document.createElement('p');p.textContent=line.originalText;old.append(title,p);row.append(old);}
      el('recordLines').append(row);
    }
    shown+=50;el('moreLines').hidden=shown>=selected.lines.length;
  }
  el('moreLines').onclick=more;
  el('libraryBtn').onclick=action(async()=>{await list();await recoveryList();el('libraryDialog').showModal();});
  el('libraryClose').onclick=()=>el('libraryDialog').close();
  el('recordSearchBtn').onclick=action(()=>list());el('libraryList').onchange=action(pick);
  el('recordMetaSave').onclick=action(async()=>{if(!selected)return;const speakers={};el('speakerNames').querySelectorAll('input').forEach(i=>speakers[i.dataset.speaker]=i.value);
    const r=await request('/api/library/meta',{record:selected.record,revision:selected.revision,title:el('recordTitle').value,category:el('recordCategory').value,speakers});selected={...r,record:selected.record};await list(selected.record);toast('信息已保存');});
  el('libraryExport').onclick=action(async()=>{if(!selected)return;const d=await request('/api/library/export?record='+encodeURIComponent(selected.record));download((safeName(selected.meta.title||selected.record.replace(/\.md$/,'')))+'.md',d.md);});
  el('librarySummary').onclick=action(async()=>{if(!selected)return;await loadRecords(selected.record);showTab('report');el('libraryDialog').close();});
  async function recoveryList(){const d=await request('/api/recovery');el('recoveryList').textContent=d.items.length?'':'没有待补转写缓存';
    for(const item of d.items){const row=document.createElement('p'),retry=document.createElement('button'),del=document.createElement('button');row.textContent=`${item.record} · ${item.gaps} 个待处理时段 `;retry.textContent='重试补转写';del.textContent='删除缓存';
      retry.onclick=action(async()=>{retry.disabled=true;try{await request('/api/recovery/retry',{record:item.record});await recoveryList();await list(item.record);}finally{retry.disabled=false;}});
      del.onclick=action(async()=>{if(confirm('删除本机补转写缓存？已有文字记录保留。')){await request('/api/recovery/delete',{record:item.record});await recoveryList();}});row.append(retry,del);el('recoveryList').append(row);}}
  el('refreshRecovery').onclick=action(recoveryList);
  el('importBtn').onclick=()=>el('importDialog').showModal();el('importClose').onclick=()=>el('importDialog').close();
  el('importCancel').onclick=action(async()=>{cancelImport=true;if(importId)await request('/api/import/cancel',{id:importId});el('importState').textContent='正在取消，当前请求结束后停止';});
  async function duration(file){const audio=document.createElement('audio'),url=URL.createObjectURL(file);try{return await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('读取音频时长超时')),15000);audio.onloadedmetadata=()=>{clearTimeout(timeout);resolve(audio.duration);};audio.onerror=()=>{clearTimeout(timeout);reject(Error('不支持的音频格式'));};audio.src=url;
  });}finally{audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url);}}
  el('importStart').onclick=action(async()=>{
    if(importing)return;const file=el('importFile').files[0];if(!file)throw Error('请选择录音文件');if(file.size>50*1024*1024)throw Error('文件不能超过 50 MB');
    importing=true;cancelImport=false;importId=null;el('importStart').disabled=true;el('importProgress').value=0;
    let context;
    try{
      const seconds=await duration(file);if(!Number.isFinite(seconds)||seconds>1800||seconds<=0)throw Error('仅支持 30 分钟以内的音频');
      el('importState').textContent='正在本机解码音频…';context=new AudioContext();const decoded=await context.decodeAudioData(await file.arrayBuffer());
      if(decoded.duration>1800)throw Error('音频超过 30 分钟');
      const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000),source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start();
      const rendered=await offline.startRendering();if(cancelImport)return;
      const task=await request('/api/import/begin',{title:file.name.replace(/\.[^.]+$/,''),asr:el('importAsr').value,speaker:el('speaker').value,target:el('target').value,translator:el('translator').value,saveAudio:el('importSaveAudio').checked});importId=task.id;
      const samples=rendered.getChannelData(0);
      for(let i=0;i<samples.length;i+=16000*5){if(cancelImport){await request('/api/import/cancel',{id:importId});return;}
        const part=samples.subarray(i,i+16000*5),pcm=new Int16Array(part.length);for(let n=0;n<part.length;n++)pcm[n]=Math.round(Math.max(-1,Math.min(1,part[n]))*32767);
        const uploaded=await window.api.call('/api/import/chunk','POST',{id:importId,audio:pcm.buffer});if(uploaded.ok===false)throw Error(uploaded.msg);
      }
      await request('/api/import/finish',{id:importId});
      while(true){const state=await request('/api/import/status?id='+importId);el('importProgress').value=state.progress;el('importState').textContent=state.message||`正在转写和翻译 ${state.progress}%`;
        if(!['uploading','processing'].includes(state.phase)){if(state.phase==='done'){await loadRecords(state.record);toast('导入完成，可在记录管理中查看');}break;}
        await new Promise(r=>setTimeout(r,800));
      }
    }catch(e){if(importId)await request('/api/import/cancel',{id:importId}).catch(()=>{});el('importState').textContent=e.message;throw e;}
    finally{await context?.close();if(cancelImport)el('importState').textContent='已取消';importing=false;el('importStart').disabled=false;}
  });
})();
