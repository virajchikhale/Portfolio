/* ════════════════════════════════════════════════════════════════
   VC·AI client — streams answers from the backend (/api/chat, SSE).

   SECURITY: model output is untrusted. It is ONLY ever inserted with
   textContent — never innerHTML — so it cannot inject markup or script.
════════════════════════════════════════════════════════════════ */
const AI = {
  history: [],      // [{role:'user'|'assistant', content}] — sent back for context
  busy: false,
  online: null,     // null = unknown, true/false after the first health check
  MAX_HISTORY: 12,  // server only uses the last few turns anyway
  TIMEOUT_MS: 60000,
};

function aiUrl(path){ return ((typeof CONFIG!=='undefined' && CONFIG.apiBase) || '') + path; }

/* Turn any failure into a short message that is safe to show the visitor. */
function aiErrorMessage(status, body){
  if(status === 404 || status === 405 || status === 0)
    return 'VC·AI is offline right now (no backend on this deployment).';
  if(status === 429) return 'Too many questions — please wait a moment and try again.';
  if(status === 503) return (body && (body.detail || body.error)) || 'The AI service is busy. Try again later.';
  if(status === 413) return (body && body.error) || 'That message is too long.';
  if(status === 400 || status === 422) return (body && body.error) || 'I can’t help with that question.';
  return 'Something went wrong. Please try again.';
}

/**
 * Ask a question. Calls onDelta(text) for each streamed chunk.
 * Resolves with the full answer; rejects with Error(message) (message is display-safe).
 */
async function aiAsk(message, onDelta){
  if(AI.busy) throw new Error('Still answering the previous question…');
  AI.busy = true;
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), AI.TIMEOUT_MS);
  try{
    let res;
    try{
      res = await fetch(aiUrl('/api/chat'), {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({message, history: AI.history.slice(-AI.MAX_HISTORY)}),
        signal: ctrl.signal,
      });
    }catch(e){
      throw new Error(aiErrorMessage(0));
    }
    if(!res.ok){
      let body = null;
      try{ body = await res.json(); }catch(e){}
      throw new Error(aiErrorMessage(res.status, body));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for(;;){
      const {done, value} = await reader.read();
      if(done) break;
      buf += dec.decode(value, {stream:true});
      let i;
      while((i = buf.indexOf('\n\n')) >= 0){
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if(!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if(data === '[DONE]') continue;
        let evt;
        try{ evt = JSON.parse(data); }catch(e){ continue; }
        if(evt.error) throw new Error(evt.error);
        if(evt.delta){ full += evt.delta; onDelta(evt.delta); }
      }
    }
    if(!full.trim()) throw new Error('No answer came back. Please try again.');
    AI.history.push({role:'user', content:message}, {role:'assistant', content:full});
    AI.history = AI.history.slice(-AI.MAX_HISTORY);
    return full;
  }catch(e){
    if(e.name === 'AbortError') throw new Error('The answer timed out. Please try again.');
    throw e;
  }finally{
    clearTimeout(timer);
    AI.busy = false;
  }
}

/* ── Health check (decides whether the UI says "online" or "offline") ── */
async function aiPing(){
  try{
    const r = await fetch(aiUrl('/api/health'), {signal: AbortSignal.timeout(4000)});
    AI.online = r.ok;
  }catch(e){ AI.online = false; }
  aiRenderStatus();
  return AI.online;
}

function aiRenderStatus(){
  const el = document.getElementById('chat-status');
  if(!el) return;
  el.textContent = AI.online === null ? '○ checking…'
                 : AI.online ? '● online' : '○ offline';
}

/* ── Chat window ───────────────────────────────────────── */
function chatAppend(role, text){
  const log = document.getElementById('chat-log');
  const row = document.createElement('div');
  row.className = 'chat-msg ' + role;
  const who = document.createElement('div');
  who.className = 'chat-who';
  who.textContent = role === 'user' ? 'YOU' : 'VC·AI';
  const body = document.createElement('div');
  body.className = 'chat-text';
  body.textContent = text;            // textContent only — see SECURITY note
  row.append(who, body);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return body;
}

function chatOpen(){
  openWin('win-chat');
  if(AI.online === null) aiPing();
  setTimeout(()=>{ const i = document.getElementById('chat-in'); if(i) i.focus(); }, 80);
}

async function chatSend(preset){
  const input = document.getElementById('chat-in');
  const sendBtn = document.getElementById('chat-send');
  const text = (preset || input.value).trim();
  if(!text || AI.busy) return;
  input.value = '';
  const sugg = document.getElementById('chat-suggest');
  if(sugg) sugg.remove();

  chatAppend('user', text);
  const out = chatAppend('ai', '…');
  let started = false;
  sendBtn.disabled = true; input.disabled = true;
  try{
    await aiAsk(text, chunk=>{
      if(!started){ out.textContent = ''; started = true; }
      out.textContent += chunk;
      const log = document.getElementById('chat-log');
      log.scrollTop = log.scrollHeight;
    });
  }catch(e){
    out.textContent = e.message;
    out.classList.add('chat-err');
    if(e.message.indexOf('offline') >= 0){ AI.online = false; aiRenderStatus(); }
  }finally{
    sendBtn.disabled = false; input.disabled = false;
    input.focus();
  }
}

function chatKey(e){ if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); chatSend(); } }

function chatInit(){
  const sugg = document.getElementById('chat-suggest');
  if(sugg){
    sugg.textContent = '';
    ((typeof CONFIG!=='undefined' && CONFIG.chatSuggestions) || []).forEach(q=>{
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chat-chip'; b.textContent = q;
      b.addEventListener('click', ()=>chatSend(q));
      sugg.appendChild(b);
    });
  }
  aiRenderStatus();
}

/* ── Terminal: `ask <question>` ───────────────────────────── */
async function askInTerminal(question, promptLabel){
  const out = document.getElementById('term-out');
  const block = document.createElement('div');
  block.className = 'term-block';
  const cmd = document.createElement('span');
  cmd.className = 't-cmd';
  cmd.textContent = promptLabel + ' ask ' + question;
  const ans = document.createElement('span');
  ans.className = 't-out';
  ans.style.whiteSpace = 'pre-wrap';
  ans.textContent = '…';
  block.append(cmd, ans);
  out.appendChild(block);
  out.scrollTop = out.scrollHeight;

  let started = false;
  try{
    await aiAsk(question, chunk=>{
      if(!started){ ans.textContent = ''; started = true; }
      ans.textContent += chunk;
      out.scrollTop = out.scrollHeight;
    });
  }catch(e){
    ans.className = 't-err';
    ans.textContent = e.message;
  }
  out.scrollTop = out.scrollHeight;
}
