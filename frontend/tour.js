/* ════════════════════════════════════════════════════════════════
   First-visit guide: a mode chooser (desktop or the one-page Read Me) and a short desktop tour.

   Welcome  asks once how the visitor wants to look around. Choosing the desktop is remembered; the Read Me page is a
            plain link away either way.
   Tour     five stops, each a spotlight on a real part of the desktop with a line from a pixel guide. It can be skipped
            at any point and replayed from HELP > Take the Tour or the terminal (`tour`).

   Everything is inserted with textContent. Storage may be blocked: both then simply show again on the next visit.
════════════════════════════════════════════════════════════════ */
const GUIDE_ART = [
  '................',
  '....########....',
  '...##########...',
  '..############..',
  '..##oooooooo##..',
  '..#oooooooooo#..',
  '..#oo#oooo#oo#..',
  '..#oooooooooo#..',
  '..#ooo#oo#ooo#..',
  '..#oooo##oooo#..',
  '...#oooooooo#...',
  '....########....',
  '.....#oooo#.....',
  '..#####oo#####..',
  '.##############.',
  '.##############.',
];

/* The guide: a 16x16 face scaled up on a canvas. `blink` closes the eyes for one frame. */
function drawGuide(canvas, blink){
  if(!canvas) return;
  const c = canvas.getContext('2d'), u = canvas.width / 16;
  c.clearRect(0, 0, canvas.width, canvas.height);
  GUIDE_ART.forEach((row, y)=>{
    for(let x = 0; x < 16; x++){
      let ch = row[x];
      if(blink && y === 6 && ch === '#' && x > 2 && x < 13) ch = 'o';
      if(ch === '.') continue;
      c.fillStyle = ch === '#' ? '#000' : '#fff';
      c.fillRect(x * u, y * u, u, u);
    }
  });
}

const Guide = {
  timer: null,
  /* Keep the given canvases blinking while a guide surface is on screen. */
  start(ids){
    this.stop();
    const all = ()=>ids.map(id=>document.getElementById(id));
    all().forEach(cv=>drawGuide(cv, false));
    this.timer = setInterval(()=>{
      all().forEach(cv=>drawGuide(cv, true));
      setTimeout(()=>all().forEach(cv=>drawGuide(cv, false)), 140);
    }, 3400);
  },
  stop(){ if(this.timer){ clearInterval(this.timer); this.timer = null; } },
  /* Type `text` into `el`; returns a function that finishes it at once. */
  type(el, text){
    if(el._typing) clearInterval(el._typing);
    const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(still){ el.textContent = text; return ()=>{}; }
    let i = 0;
    el.textContent = '';
    const done = ()=>{ clearInterval(el._typing); el._typing = null; el.textContent = text; };
    el._typing = setInterval(()=>{ i += 2; el.textContent = text.slice(0, i); if(i >= text.length) done(); }, 18);
    return done;
  },
  get(key){ try{ return localStorage.getItem(key); }catch(e){ return null; } },
  set(key, v){ try{ localStorage.setItem(key, v); }catch(e){} },
};

/* ── Mode chooser ────────────────────────────────────────── */
const Welcome = {
  open: false,
  /* True until the visitor has picked the desktop once (or arrived with ?mode=os, e.g. from the Read Me page). */
  needed(){
    if(new URLSearchParams(location.search).get('mode') === 'os'){ Guide.set('vc-os-mode', 'os'); return false; }
    return Guide.get('vc-os-mode') !== 'os';
  },
  show(onDesktop){
    const el = document.getElementById('welcome');
    if(!el || this.open) return;
    this.open = true;
    this.onDesktop = onDesktop;
    const first = CONFIG.user.name.split(' ')[0];
    drawMac(document.getElementById('wl-ic-os'));
    drawDoc(document.getElementById('wl-ic-rv'));
    el.classList.add('show');
    Guide.start(['wl-guide']);
    Guide.type(document.getElementById('wl-say'), 'Hi, I’m ' + first + '. Welcome to my portfolio. How would you like to look around?');
    const os = document.getElementById('wl-os'), rv = document.getElementById('wl-rv');
    if(!this.wired){
      this.wired = true;
      os.addEventListener('click', ()=>this.choose('os'));
      rv.addEventListener('click', ()=>this.choose('readme'));
      el.addEventListener('keydown', e=>{
        if(e.key === 'ArrowRight' || e.key === 'ArrowDown'){ e.preventDefault(); rv.focus(); }
        else if(e.key === 'ArrowLeft' || e.key === 'ArrowUp'){ e.preventDefault(); os.focus(); }
        else if(e.key === 'Escape'){ this.choose('os'); }
      });
    }
    os.focus();
  },
  choose(mode){
    if(!this.open) return;
    this.open = false;
    Guide.stop();
    if(mode === 'readme'){ location.href = 'readme.html'; return; }
    Guide.set('vc-os-mode', 'os');
    document.getElementById('welcome').classList.remove('show');
    if(typeof snd === 'function') snd('open');
    if(this.onDesktop) this.onDesktop();
  },
};

/* ── Desktop tour ────────────────────────────────────────── */
const Tour = {
  active: false, i: 0, asked: false, opened: [],
  seen(){ return Guide.get('vc-os-toured') === '1'; },
  mobile(){ return window.innerWidth <= 768; },

  /* target: element the spotlight frames (desktop / mobile, where windows are full-screen so the icon is framed instead).
     open: window to open first (desktop only). ask: offer a sample question on this stop. */
  steps(){
    const first = CONFIG.user.name.split(' ')[0];
    return [
      { text: 'Hi, I’m ' + first + '. This portfolio is a working desktop: drag windows by the title bar, open things from the dock. Four quick stops and you’re on your own.' },
      { target: '#win-chat', mTarget: '#ic6', open: 'win-chat', ask: true,
        text: 'This is VC·AI. Ask it anything about my work. It answers from my real documents and lists the sources it used.' },
      { target: '#win-flow', mTarget: '#ic7', open: 'win-flow',
        text: 'The Flow Monitor shows how each answer is made, step by step: safety checks, search, then the model.' },
      { target: '#dock',
        text: 'The dock opens everything else: About, Skills, Projects and a Terminal. Type snake in it when you need a break.' },
      { target: '.mb-readme',
        text: 'Short on time? READ ME tells the same story on one page.',
        more: ' You can replay this tour from the HELP menu.' },
    ];
  },

  start(){
    const root = document.getElementById('tour');
    if(!root || this.active || Welcome.open) return;
    this.active = true; this.i = 0; this.asked = false; this.opened = [];
    this.list = this.steps();
    if(typeof mbCloseAll === 'function') mbCloseAll();
    if(!this.wired){
      this.wired = true;
      document.getElementById('tour-next').addEventListener('click', ()=>this.next());
      document.getElementById('tour-back').addEventListener('click', ()=>this.back());
      document.getElementById('tour-skip').addEventListener('click', ()=>this.end());
      document.getElementById('tour-ask').addEventListener('click', ()=>this.ask());
      document.addEventListener('keydown', e=>{
        if(!this.active) return;
        if(e.key === 'Escape'){ e.preventDefault(); this.end(); }
        else if(e.key === 'ArrowRight'){ e.preventDefault(); this.next(); }
        else if(e.key === 'ArrowLeft'){ e.preventDefault(); this.back(); }
      });
      window.addEventListener('resize', ()=>{ if(this.active) this.frame(); });
    }
    const dots = document.getElementById('tour-dots');
    dots.textContent = '';
    this.list.forEach(()=>dots.appendChild(document.createElement('i')));
    root.classList.add('show');
    Guide.start(['tour-guide']);
    this.render();
  },

  next(){ if(this.i >= this.list.length - 1) this.end(); else { this.i++; this.render(); } },
  back(){ if(this.i > 0){ this.i--; this.render(); } },

  /* The interactive stop: send a real question, then move on to the Flow Monitor to watch it being answered. */
  ask(){
    const q = (CONFIG.chatSuggestions || [])[0];
    if(!q || typeof chatSend !== 'function' || AI.busy) return;
    this.asked = true;
    if(document.getElementById('win-flow').style.display === 'none'){ this.opened.push('win-flow'); openWin('win-flow'); }
    chatSend(q);
    this.next();
  },

  render(){
    const s = this.list[this.i], mobile = this.mobile(), last = this.i === this.list.length - 1;
    if(s.open && !mobile){
      const w = document.getElementById(s.open);
      if(w.style.display === 'none'){ this.opened.push(s.open); openWin(s.open); } else bringFront(s.open);
    }
    Guide.type(document.getElementById('tour-say'), s.text + (s.more && !mobile ? s.more : ''));
    document.getElementById('tour-step').textContent = (this.i + 1) + ' / ' + this.list.length;
    [...document.getElementById('tour-dots').children].forEach((d, n)=>d.classList.toggle('on', n === this.i));
    document.getElementById('tour-back').disabled = this.i === 0;
    document.getElementById('tour-next').textContent = last ? 'START EXPLORING' : 'NEXT';
    document.getElementById('tour-skip').hidden = last;
    document.getElementById('tour-ask').hidden = !(s.ask && !mobile && !this.asked && AI.online === true && (CONFIG.chatSuggestions || []).length);
    this.frame();
    // again once the window-open animation (a short scale-up) has settled, or the frame would be measured too small
    const again = ()=>{ if(this.active) this.frame(); };
    if(s.open && !mobile) document.getElementById(s.open).addEventListener('animationend', again, {once: true});
    setTimeout(again, 200);
    document.getElementById('tour-next').focus();
  },

  /* Put the spotlight on the current target and the card next to it, wherever there is room. */
  frame(){
    const s = this.list[this.i], hole = document.getElementById('tour-hole'), card = document.getElementById('tour-card');
    const sel = this.mobile() ? (s.mTarget || s.target) : s.target;
    let el = sel ? document.querySelector(sel) : null;
    if(el && sel.startsWith('#ic')) el = el.closest('.dsk-icon') || el;
    const vw = window.innerWidth, vh = window.innerHeight, m = 12, gap = 16;
    const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
    if(r){
      const p = 5;
      hole.style.left = (r.left - p) + 'px'; hole.style.top = (r.top - p) + 'px';
      hole.style.width = (r.width + 2 * p) + 'px'; hole.style.height = (r.height + 2 * p) + 'px';
      hole.classList.remove('none');
    }else{
      hole.style.left = (vw / 2) + 'px'; hole.style.top = (vh / 2) + 'px'; hole.style.width = hole.style.height = '0px';
      hole.classList.add('none');
    }
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const cx = x=>Math.max(m, Math.min(vw - cw - m, x)), cy = y=>Math.max(m, Math.min(vh - ch - m, y));
    let x = (vw - cw) / 2, y = (vh - ch) / 2;
    if(r){
      if(r.right + gap + cw <= vw - m){ x = r.right + gap; y = cy(r.top); }
      else if(r.left - gap - cw >= m){ x = r.left - gap - cw; y = cy(r.top); }
      else if(r.bottom + gap + ch <= vh - m){ y = r.bottom + gap; x = cx(r.left + (r.width - cw) / 2); }
      else if(r.top - gap - ch >= m){ y = r.top - gap - ch; x = cx(r.left + (r.width - cw) / 2); }
      else { x = cx(r.right - cw - gap); y = cy(r.bottom - ch - gap); }
    }
    card.style.left = Math.round(x) + 'px'; card.style.top = Math.round(y) + 'px';
  },

  end(){
    if(!this.active) return;
    this.active = false;
    Guide.stop();
    Guide.set('vc-os-toured', '1');
    document.getElementById('tour').classList.remove('show');
    // Leave the desktop tidy: windows the tour opened are closed again, unless a question is being answered in them.
    if(!this.asked && !this.mobile()){
      this.opened.forEach(id=>{ if(id !== 'win-chat') closeWin(id); });
      if(typeof landingLayout === 'function') landingLayout();
    }
    const i = document.getElementById('chat-in');
    if(i && !this.mobile() && document.getElementById('win-chat').style.display !== 'none') i.focus();
  },
};
