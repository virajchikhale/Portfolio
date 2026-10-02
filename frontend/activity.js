/* ════════════════════════════════════════════════════════════════
   ACTIVITY: a small system monitor for VC·AI, fed by GET /api/stats.

   It shows AGGREGATES only (counts, latency percentiles, per-stage timings). The backend never exposes a question, an
   answer or anything per visitor here. Every value is inserted with textContent.
════════════════════════════════════════════════════════════════ */
const Activity = {
  window: '24h',
  timer: null,
  data: null,

  afterOpen(){
    if(!this.wired){ this.wired = true; this.wire(); }
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(()=>{ if(!document.hidden) this.refresh(); }, 15000);   // only while the window is open
  },
  afterClose(){ clearInterval(this.timer); this.timer = null; },

  wire(){
    document.querySelectorAll('#act-window button').forEach(b=>b.addEventListener('click', ()=>{
      this.window = b.dataset.w; this.refresh();
    }));
    document.getElementById('act-refresh').addEventListener('click', ()=>this.refresh());
  },

  async refresh(){
    document.querySelectorAll('#act-window button').forEach(b=>b.classList.toggle('on', b.dataset.w === this.window));
    try{
      const r = await fetch(aiUrl('/api/stats?window=' + encodeURIComponent(this.window)), {signal: AbortSignal.timeout(6000)});
      if(!r.ok) throw new Error('HTTP ' + r.status);
      this.data = await r.json();
    }catch(e){
      this.data = {unavailable: true};
    }
    this.render();
  },

  fmt(ms){ return ms == null ? 'n/a' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'; },
  dur(s){ const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min`; },

  render(){
    const box = document.getElementById('act-body'); if(!box) return;
    box.textContent = '';
    const d = this.data || {};
    const add = (cls, text, parent)=>{ const e = document.createElement('div'); e.className = cls; e.textContent = text; (parent || box).appendChild(e); return e; };
    if(d.unavailable){ add('act-note', 'Statistics are unavailable: the backend is not reachable from this page.'); return; }
    if(d.enabled === false){ add('act-note', 'Statistics are switched off on this server (TELEMETRY_ENABLED=false).'); return; }

    const total = d.runs.total;
    const section = title=>{ const s = document.createElement('section'); s.className = 'act-sec'; add('act-h', title, s); box.appendChild(s); return s; };
    const kv = (parent, k, v)=>{ const r = add('act-kv', '', parent); add('act-k', k, r); add('act-v', v, r); };
    const bars = (parent, entries, max)=>{
      entries.forEach(([label, value, shown])=>{
        const r = add('act-row', '', parent);
        add('act-rl', label, r);
        const bar = add('act-bar', '', r), i = document.createElement('i');
        i.style.width = (max > 0 && value > 0 ? Math.max(2, Math.round(100 * value / max)) : 0) + '%';
        bar.appendChild(i);
        add('act-rv', shown == null ? String(value) : shown, r);
      });
    };

    let s = section('ANSWERS');
    kv(s, 'questions', String(total));
    kv(s, 'answered with sources', d.answers.with_sources_pct == null ? 'n/a' : d.answers.with_sources_pct + '%');
    kv(s, 'uptime', this.dur(d.uptime_s));
    if(!total){ add('act-note', 'No questions yet in this window. Ask VC·AI something and come back.', box); return; }

    s = section('MODE');
    const mx = Math.max(d.runs.by_mode.pipeline, d.runs.by_mode.agent, 1);
    bars(s, [['pipeline', d.runs.by_mode.pipeline], ['agent', d.runs.by_mode.agent]], mx);

    s = section('OUTCOME');
    const o = d.runs.by_outcome, ox = Math.max(...Object.values(o), 1);
    bars(s, ['ok', 'blocked', 'empty', 'error', 'cancelled'].map(k=>[k, o[k] || 0]), ox);

    s = section('LATENCY (answered)');
    kv(s, 'median total', this.fmt(d.latency_ms.p50));
    kv(s, '95th percentile', this.fmt(d.latency_ms.p95));
    kv(s, 'median first text', this.fmt(d.ttft_ms.p50));

    s = section('STAGES (median)');
    const st = d.stages_p50_ms, sx = Math.max(...Object.values(st).map(v=>v || 0), 1);
    bars(s, Object.entries(st).filter(([, v])=>v != null).map(([k, v])=>[k, v, this.fmt(v)]), sx);

    s = section('AGENT');
    kv(s, 'agent runs', String(d.agent.runs));
    kv(s, 'avg model calls', d.agent.avg_steps == null ? 'n/a' : String(d.agent.avg_steps));
    kv(s, 'avg tool calls', d.agent.avg_tool_calls == null ? 'n/a' : String(d.agent.avg_tool_calls));
    kv(s, 'fell back to pipeline', String(d.agent.fallbacks));
  },
};
function activityOpen(){ openWin('win-activity'); }
