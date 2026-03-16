/* ════════════════════════════════════════════════════════════════
   RENDERER — reads CONFIG and populates every template shell
════════════════════════════════════════════════════════════════ */
function renderFromConfig(){
  const C = CONFIG;

  /* ── page <title> ──────────────────────────────────────────── */
  document.getElementById('page-title').textContent =
    C.meta.osName + ' \u2014 ' + C.user.name;

  /* ── Boot screen ───────────────────────────────────────────── */
  const bootBar = document.getElementById('boot-title-bar');
  if(bootBar) bootBar.textContent =
    C.meta.osName + ' \u2014 ' + C.user.role.toUpperCase() + ' SYSTEM STARTUP v' + C.meta.version;

  const bootVer = document.getElementById('boot-ver-line');
  if(bootVer) bootVer.textContent =
    C.meta.osName + ' v' + C.meta.version + ' \u00a9 ' + C.meta.year + ' ' + C.user.name.toUpperCase() + ' \u2014 ' + C.user.role.toUpperCase();

  /* ── About window title bar ─────────────────────────────────── */
  const awt = document.getElementById('about-win-title');
  if(awt) awt.textContent = 'About ' + C.user.name;

  /* ── About window body ──────────────────────────────────────── */
  const aboutEl = document.getElementById('about-content');
  if(aboutEl){
    const statsHTML = C.stats.map(s=>`
      <div class="stat-box">
        <div class="sv">${s.value}</div>
        <div class="sl">${s.label}</div>
      </div>`).join('');

    const linksHTML = C.links.map(l=>{
      if(l.action==='ie')       return `<span class="badge" onclick="ieOpen('${l.url}')">${l.label}</span>`;
      if(l.action==='contact')  return `<span class="badge" onclick="openWin('win-contact')">${l.label}</span>`;
      if(l.action==='terminal') return `<span class="badge" onclick="openWin('win-terminal')">${l.label}</span>`;
      return `<a class="badge" href="${l.url}" target="_blank">${l.label}</a>`;
    }).join('');

    aboutEl.innerHTML = `
      <div class="aw-head">
        <canvas id="av-canvas" width="64" height="64" class="aw-avatar"></canvas>
        <div class="aw-info">
          <h1>${C.user.name.toUpperCase()}</h1>
          <p>${C.user.role}<span class="blink" style="margin-left:4px;">_</span></p>
          <p style="font-size:6px;color:#777;">${C.user.location} &mdash; ${C.user.tagline}</p>
        </div>
      </div>
      <div class="divider"></div>
      <p style="font-size:7px;line-height:2.3;color:#333;margin-bottom:10px;">${C.user.bio}</p>
      <div class="stats">${statsHTML}</div>
      <div class="divider"></div>
      <div class="badges">${linksHTML}</div>`;

    // draw avatar after injecting canvas
    requestAnimationFrame(()=>{
      const av = document.getElementById('av-canvas');
      if(av) drawAvatar(av);
    });
  }

  /* ── Skills window body ─────────────────────────────────────── */
  const skillsEl = document.getElementById('skills-content');
  if(skillsEl){
    skillsEl.innerHTML = C.skills.map(cat=>`
      <div class="sk-cat">
        <div class="sk-cat-h">${cat.category}</div>
        <div class="sk-chips">${cat.items.map(i=>`<span class="chip">${i}</span>`).join('')}</div>
      </div>`).join('');
  }

  /* ── Projects window body ───────────────────────────────────── */
  const projEl = document.getElementById('projects-content');
  if(projEl){
    const cards = C.projects.map(p=>{
      const tags  = p.tags.map(t=>`<span class="pc-tag">${t}</span>`).join('');
      const links = (p.links||[]).map(l=>`<span class="pc-link" onclick="ieOpen('${l.url}')">${l.label}</span>`).join('');
      return `
        <div class="pc">
          <div class="pc-head"><span>${p.icon} ${p.name}</span></div>
          <div class="pc-body">
            <p>${p.desc}</p>
            <div class="pc-tags">${tags}</div>
            ${links?`<div class="pc-links">${links}</div>`:''}
          </div>
        </div>`;
    }).join('');
    projEl.innerHTML = cards + `
      <div class="pc" style="border-style:dashed;opacity:0.35;">
        <div class="pc-head" style="background:none;"><span style="background:none;color:#999;">+ ADD PROJECT IN CONFIG.projects[]</span></div>
        <div class="pc-body"><p style="color:#aaa;font-size:6px;">Add an object to CONFIG.projects and it will appear here automatically.</p></div>
      </div>`;
  }

  /* ── Contact email ──────────────────────────────────────────── */
  const emailTo = document.getElementById('contact-email-to');
  if(emailTo) emailTo.value = C.user.email;

  /* ── Terminal prompt + welcome ──────────────────────────────── */
  const promptLabel = document.getElementById('term-prompt-label');
  if(promptLabel) promptLabel.textContent = C.user.promptUser + '@vc-os:~$';

  const tw1 = document.getElementById('term-welcome-line1');
  if(tw1) tw1.textContent = C.meta.osName + ' Terminal v' + C.meta.version;

  const tw2 = document.getElementById('term-welcome-line2');
  if(tw2) tw2.textContent = C.user.name + ' \u2014 ' + C.user.role;

  /* ── Desktop marquee ────────────────────────────────────────── */
  const mq = document.getElementById('marquee-text');
  if(mq) mq.textContent = C.marquee;

  /* ── IE favorites sidebar ───────────────────────────────────── */
  const favBar = document.getElementById('ie-fav-bar');
  if(favBar){
    const cats = [...new Set(C.favorites.map(f=>f.cat))];
    let favHTML = '<div class="ie-fav-title"><span>\u2605 Favorites</span></div>';
    cats.forEach(cat=>{
      favHTML += `<div class="ie-fav-cat">${cat}</div>`;
      C.favorites.filter(f=>f.cat===cat).forEach(f=>{
        favHTML += `<div class="ie-fav-item" onclick="ieOpen('${f.url}')">${f.label}</div>`;
      });
    });
    favBar.innerHTML = favHTML;
  }

  /* ── CMDS: update whoami and skills to read from CONFIG ──────── */
  CMDS.whoami = ()=>{
    snd('click');
    return `<span class="t-out">${C.user.name} \u2014 ${C.user.role}</span><span class="t-out">${C.user.location} | ${C.skills.map(s=>s.items.slice(0,2).join(', ')).join(' \u2022 ')}</span>`;
  };
  CMDS.skills = ()=>{
    snd('click');
    return C.skills.map(s=>
      `<span class="t-out">  ${s.category.replace(/[^\w\s&\/]/g,'').trim().padEnd(16,' ')} : ${s.items.join(', ')}</span>`
    ).join('');
  };

  /* ── Terminal prompt string used in termKey ──────────────────── */
  window._TERM_PROMPT = C.user.promptUser + '@vc-os:~$';
}

/* ══════════════════════════════════════════════════════
   PIXEL ART ICONS (canvas)
══════════════════════════════════════════════════════ */
function px(canvas, fn){
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  fn(ctx, canvas.width, canvas.height);
}

function drawPerson(canvas){
  px(canvas,(c,w,h)=>{
    c.fillStyle='#000';
    // head
    c.beginPath();c.arc(w/2,h*0.28,w*0.18,0,Math.PI*2);c.fill();
    // body
    c.fillRect(w/2-w*0.2, h*0.48, w*0.4, h*0.3);
    // arms
    c.fillRect(w/2-w*0.34, h*0.48, w*0.14, h*0.22);
    c.fillRect(w/2+w*0.2,  h*0.48, w*0.14, h*0.22);
  });
}
function drawStar(canvas){
  px(canvas,(c,w,h)=>{
    c.fillStyle='#000';
    const cx=w/2,cy=h/2,pts=5,r=w*0.42,ir=w*0.18;
    c.beginPath();
    for(let i=0;i<pts*2;i++){
      const a=Math.PI/pts*i-Math.PI/2;
      const rad=i%2===0?r:ir;
      i===0?c.moveTo(cx+Math.cos(a)*rad,cy+Math.sin(a)*rad):c.lineTo(cx+Math.cos(a)*rad,cy+Math.sin(a)*rad);
    }
    c.closePath();c.fill();
  });
}
function drawFolder(canvas){
  px(canvas,(c,w,h)=>{
    c.fillStyle='#000';
    c.fillRect(1,h*0.3,w*0.35,h*0.12);
    c.beginPath();c.moveTo(w*0.35,h*0.3);c.lineTo(w*0.43,h*0.3);c.lineTo(w*0.43,h*0.42);c.lineTo(w-1,h*0.42);c.lineTo(w-1,h*0.85);c.lineTo(1,h*0.85);c.lineTo(1,h*0.3);c.closePath();c.stroke();
    c.strokeStyle='#000';c.lineWidth=1.5;
    c.strokeRect(1,h*0.42,w-2,h*0.43);
    // inner lines
    c.lineWidth=1;
    [0.52,0.6,0.68].forEach(yf=>{c.beginPath();c.moveTo(6,h*yf);c.lineTo(w-6,h*yf);c.stroke();});
  });
}
function drawTerm(canvas){
  px(canvas,(c,w,h)=>{
    c.fillStyle='#000';c.fillRect(1,1,w-2,h-2);
    c.fillStyle='#fff';
    c.font=`bold ${Math.round(w*0.28)}px monospace`;
    c.fillText('>_',Math.round(w*0.12),Math.round(h*0.62));
  });
}
function drawMail(canvas){
  px(canvas,(c,w,h)=>{
    c.fillStyle='#000';
    const pad=2,top=h*0.28,bot=h*0.78;
    c.strokeStyle='#000';c.lineWidth=1.5;
    c.strokeRect(pad,top,w-pad*2,bot-top);
    c.beginPath();c.moveTo(pad,top);c.lineTo(w/2,h*0.56);c.lineTo(w-pad,top);c.stroke();
  });
}
function drawIE(canvas){
  px(canvas,(c,w,h)=>{
    // Globe outline
    c.strokeStyle='#000';c.lineWidth=1.5;
    const cx=w/2, cy=h/2, r=w*0.4;
    c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.stroke();
    // Latitude lines
    [0.3,0.55,0.75].forEach(f=>{
      const ry=r*(1-f*2+0.5)*0.7;
      if(Math.abs(ry)<r){
        const hw=Math.sqrt(r*r-ry*ry);
        c.beginPath();c.moveTo(cx-hw,cy+r*(f-0.5)*1.4);c.lineTo(cx+hw,cy+r*(f-0.5)*1.4);c.stroke();
      }
    });
    // Vertical center line
    c.beginPath();c.moveTo(cx,cy-r);c.lineTo(cx,cy+r);c.stroke();
    // Curve lines (longitude)
    c.beginPath();
    c.moveTo(cx,cy-r);
    c.bezierCurveTo(cx+r*0.55,cy-r*0.4, cx+r*0.55,cy+r*0.4, cx,cy+r);c.stroke();
    c.beginPath();
    c.moveTo(cx,cy-r);
    c.bezierCurveTo(cx-r*0.55,cy-r*0.4, cx-r*0.55,cy+r*0.4, cx,cy+r);c.stroke();
    // "e" letter in center
    c.fillStyle='#000';
    c.font=`bold ${Math.round(w*0.32)}px serif`;
    c.textAlign='center';c.textBaseline='middle';
    c.fillText('e',cx,cy+1);
  });
}
function drawMac(canvas){
  px(canvas,(c,w,h)=>{
    c.fillStyle='#fff';c.fillRect(0,0,w,h);
    c.strokeStyle='#000';c.lineWidth=1;
    // monitor body
    c.strokeRect(2,1,w-4,h*0.72);
    // screen
    c.fillStyle='#000';c.fillRect(5,4,w-10,h*0.5);
    c.fillStyle='#fff';c.fillRect(6,5,w-12,h*0.44);
    // face
    c.fillStyle='#000';
    const ey=Math.round(h*0.22);
    c.fillRect(Math.round(w*0.25),ey,2,2);
    c.fillRect(Math.round(w*0.62),ey,2,2);
    // smile
    const sy=Math.round(h*0.34);
    c.fillRect(Math.round(w*0.28),sy,2,1);
    c.fillRect(Math.round(w*0.36),sy+1,Math.round(w*0.28),1);
    c.fillRect(Math.round(w*0.64)+2,sy,2,1);
    // base
    c.strokeRect(Math.round(w*0.22),Math.round(h*0.73),Math.round(w*0.56),Math.round(h*0.18));
    // stand
    c.strokeRect(Math.round(w*0.35),Math.round(h*0.72),Math.round(w*0.3),Math.round(h*0.06));
  });
}
function drawAvatar(canvas){
  px(canvas,(c,w,h)=>{
    // head
    c.fillStyle='#ddd';c.fillRect(10,4,w-20,h*0.45);
    c.fillStyle='#000';
    c.strokeStyle='#000';c.lineWidth=2;
    c.strokeRect(10,4,w-20,h*0.45);
    // eyes
    c.fillRect(17,16,5,5);c.fillRect(w-22,16,5,5);
    // mouth
    c.fillRect(18,30,w-36,3);
    // body
    c.fillStyle='#555';c.fillRect(6,h*0.52,w-12,h*0.44);
    c.fillStyle='#000';c.strokeRect(6,h*0.52,w-12,h*0.44);
    // collar
    c.fillStyle='#fff';c.fillRect(w/2-6,h*0.52,12,10);
  });
}

/* ══════════════════════════════════════════════════════
   BOOT SEQUENCE
══════════════════════════════════════════════════════ */
const BOOT_MSGS = CONFIG.bootMessages;

function runBoot(){
  drawMac(document.getElementById('boot-canvas'));
  const linesEl = document.getElementById('boot-lines');
  const bar = document.getElementById('boot-bar');
  const total = BOOT_MSGS.length;

  BOOT_MSGS.forEach((msg, i) => {
    setTimeout(()=>{
      const s = document.createElement('span');
      s.className = 'boot-line';
      s.textContent = '> ' + msg;
      linesEl.appendChild(s);
      // force reflow then show
      requestAnimationFrame(()=>{ s.classList.add('show'); });
      bar.style.width = Math.round((i+1)/total*100) + '%';
    }, 300 + i * 340);
  });

  setTimeout(()=>{
    const boot = document.getElementById('boot');
    boot.style.transition = 'opacity 0.45s';
    boot.style.opacity = '0';
    setTimeout(()=>{
      boot.style.display = 'none';
      document.getElementById('os').classList.add('visible');
      initOS();
      setTimeout(()=>snd('boot'), 100);
    }, 460);
  }, 300 + BOOT_MSGS.length * 340 + 300);
}

/* ══════════════════════════════════════════════════════
   OS INIT
══════════════════════════════════════════════════════ */
function initOS(){
  renderFromConfig();
  // Desktop icons
  drawPerson(document.getElementById('ic0'));
  drawStar(document.getElementById('ic1'));
  drawFolder(document.getElementById('ic2'));
  drawTerm(document.getElementById('ic3'));
  drawMail(document.getElementById('ic4'));
  drawIE(document.getElementById('ic5'));
  // Dock icons
  drawPerson(document.getElementById('dk0'));
  drawStar(document.getElementById('dk1'));
  drawFolder(document.getElementById('dk2'));
  drawTerm(document.getElementById('dk3'));
  drawMail(document.getElementById('dk4'));
  drawIE(document.getElementById('dk5'));
  // Avatar
  drawAvatar(document.getElementById('av-canvas'));
  // Clock
  startClock();
  // Register window mousedown for focus
  document.querySelectorAll('.mac-win').forEach(w=>{
    w.addEventListener('mousedown', ()=>bringFront(w.id));
  });
}

/* ══════════════════════════════════════════════════════
   CLOCK
══════════════════════════════════════════════════════ */
function startClock(){
  const el = document.getElementById('mb-clock');
  const tick = ()=>{
    const d = new Date();
    el.textContent = String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  };
  tick(); setInterval(tick, 1000);
}

/* ══════════════════════════════════════════════════════
   MENU BAR
══════════════════════════════════════════════════════ */
function mbToggle(id){
  const el = document.getElementById(id);
  const wasOpen = el.classList.contains('open');
  mbCloseAll();
  if(!wasOpen) el.classList.add('open');
}
function mbCloseAll(){
  document.querySelectorAll('.mb-item').forEach(m=>m.classList.remove('open'));
}
// Close menus on outside click
document.addEventListener('mousedown', e=>{
  if(!e.target.closest('.mb-item')) mbCloseAll();
});

/* ══════════════════════════════════════════════════════
   WINDOW MANAGEMENT
══════════════════════════════════════════════════════ */
let zTop = 30;

// Maps win-id -> dock-id
const WIN_DOCK = {
  'win-about':'dk-about','win-skills':'dk-skills',
  'win-projects':'dk-projects','win-terminal':'dk-terminal','win-contact':'dk-contact',
  'win-ie':'dk-ie'
};

function bringFront(id){
  document.querySelectorAll('.mac-win').forEach(w=>w.classList.remove('active'));
  const el = document.getElementById(id);
  el.style.zIndex = ++zTop;
  el.classList.add('active');
}

function openWin(id){
  mbCloseAll();
  const el = document.getElementById(id);
  // remove animation class so we can re-add it
  el.classList.remove('win-open-anim');
  el.style.display = 'flex';
  // trigger reflow for animation
  void el.offsetWidth;
  el.classList.add('win-open-anim');
  bringFront(id);
  // dock dot
  const dk = document.getElementById(WIN_DOCK[id]);
  if(dk) dk.classList.add('running');
}

function closeWin(id){
  snd('close');
  const el = document.getElementById(id);
  el.style.display = 'none';
  const dk = document.getElementById(WIN_DOCK[id]);
  if(dk) dk.classList.remove('running');
  // remove active if it was active — give active to topmost visible
  if(el.classList.contains('active')){
    el.classList.remove('active');
    // find highest z-index visible window and make it active
    let topEl=null, topZ=0;
    document.querySelectorAll('.mac-win').forEach(w=>{
      if(w.style.display!=='none'){
        const z=parseInt(w.style.zIndex)||0;
        if(z>topZ){topZ=z;topEl=w;}
      }
    });
    if(topEl) topEl.classList.add('active');
  }
}

function toggleWin(id){
  const el = document.getElementById(id);
  if(el.style.display === 'none' || el.style.display === ''){
    openWin(id);
  } else {
    closeWin(id);
  }
}

function closeAll(){
  mbCloseAll();
  Object.keys(WIN_DOCK).forEach(closeWin);
}

function zoomWin(id){
  const el = document.getElementById(id);
  if(el.dataset.zoomed==='1'){
    el.style.top = el.dataset.ot;
    el.style.left = el.dataset.ol;
    el.style.width = el.dataset.ow;
    el.style.height = el.dataset.oh||'';
    el.dataset.zoomed = '0';
  } else {
    el.dataset.ot = el.style.top;
    el.dataset.ol = el.style.left;
    el.dataset.ow = el.style.width;
    el.dataset.oh = el.style.height;
    const desk = document.getElementById('desktop');
    el.style.top = '0';
    el.style.left = '0';
    el.style.width = desk.clientWidth + 'px';
    el.style.height = desk.clientHeight + 'px';
    el.dataset.zoomed = '1';
  }
  bringFront(id);
}

function tileWindows(){
  mbCloseAll();
  const wins = ['win-about','win-skills','win-projects','win-terminal'];
  const desk = document.getElementById('desktop');
  const dw = desk.clientWidth, dh = desk.clientHeight;
  const w = Math.floor(dw/2), h = Math.floor(dh/2);
  wins.forEach((id,i)=>{
    const el = document.getElementById(id);
    el.style.display='flex';
    el.style.left = (i%2*w)+'px';
    el.style.top = (Math.floor(i/2)*h)+'px';
    el.style.width = w+'px';
    el.style.height = h+'px';
    el.dataset.zoomed='0';
    const dk=document.getElementById(WIN_DOCK[id]);
    if(dk) dk.classList.add('running');
  });
}

function cascadeWindows(){
  mbCloseAll();
  const wins = ['win-about','win-skills','win-projects','win-terminal','win-contact'];
  wins.forEach((id,i)=>{
    const el = document.getElementById(id);
    el.style.display='flex';
    el.style.left=(24+i*28)+'px';
    el.style.top=(8+i*26)+'px';
    el.style.width=''; el.style.height='';
    el.dataset.zoomed='0';
    bringFront(id);
    const dk=document.getElementById(WIN_DOCK[id]);
    if(dk) dk.classList.add('running');
  });
}

/* ── DRAG ──────────────────────────────────── */
let drag = null;
function tbDown(e, id){
  // Don't start drag if clicking a button
  if(e.target.classList.contains('tb-btn')) return;
  const el = document.getElementById(id);
  const r = el.getBoundingClientRect();
  drag = {id, ox: e.clientX - r.left, oy: e.clientY - r.top};
  bringFront(id);
  e.preventDefault();
}
document.addEventListener('mousemove', e=>{
  if(!drag) return;
  const el = document.getElementById(drag.id);
  const desk = document.getElementById('desktop');
  const mbH = document.getElementById('menubar').offsetHeight;
  const maxY = mbH + desk.clientHeight - 22; // keep titlebar visible
  const ny = Math.max(mbH, Math.min(maxY, e.clientY - drag.oy));
  const nx = Math.max(-el.offsetWidth + 60, e.clientX - drag.ox);
  el.style.left = nx + 'px';
  el.style.top  = ny + 'px';
});
document.addEventListener('mouseup', ()=>{ drag=null; });

/* ── RESIZE ─────────────────────────────────── */
let rsz = null;
function rszDown(e, id){
  const el = document.getElementById(id);
  const r = el.getBoundingClientRect();
  rsz = {id, sx:e.clientX, sy:e.clientY, sw:r.width, sh:r.height};
  e.preventDefault(); e.stopPropagation();
}
document.addEventListener('mousemove', e=>{
  if(!rsz) return;
  const el = document.getElementById(rsz.id);
  el.style.width  = Math.max(260, rsz.sw + (e.clientX - rsz.sx)) + 'px';
  el.style.height = Math.max(160, rsz.sh + (e.clientY - rsz.sy)) + 'px';
});
document.addEventListener('mouseup', ()=>{ rsz=null; });

/* ── DESKTOP CLICK ──────────────────────────── */
function desktopClick(e){
  if(!e.target.closest('.dsk-icon')) dskClearAll();
  mbCloseAll();
}
function dskSelect(el){ dskClearAll(); el.classList.add('sel'); }
function dskClearAll(){ document.querySelectorAll('.dsk-icon').forEach(i=>i.classList.remove('sel')); }

/* ══════════════════════════════════════════════════════
   TERMINAL
══════════════════════════════════════════════════════ */
const CMDS = {
  help: ()=>{
    snd('click');
    return [
      '<span class="t-out" style="color:#000;text-decoration:underline;">COMMANDS</span>',
      '<span class="t-out">  whoami   &mdash; about me</span>',
      '<span class="t-out">  skills   &mdash; tech stack</span>',
      '<span class="t-out">  projects &mdash; open projects</span>',
      '<span class="t-out">  contact  &mdash; send message</span>',
      '<span class="t-out">  github   &mdash; open GitHub</span>',
      '<span class="t-out">  linkedin &mdash; open LinkedIn</span>',
      '<span class="t-out">  ie       &mdash; launch browser</span>',
      '<span class="t-out">  open [url] &mdash; browse URL</span>',
      '<span class="t-out">  date     &mdash; current time</span>',
      '<span class="t-out">  matrix   &mdash; neural matrix</span>',
      '<span class="t-out">  clear    &mdash; clear screen</span>',
      '<span class="t-out" style="color:#000;text-decoration:underline;">GAMES</span>',
      '<span class="t-out">  snake    &mdash; classic snake</span>',
      '<span class="t-out">  tetris   &mdash; falling blocks</span>',
      '<span class="t-out">  invaders &mdash; space invaders</span>',
    ].join('');
  },
  whoami:   ()=>{ snd('click'); return `<span class="t-out">Viraj Chikhale &mdash; AI/ML Engineer</span><span class="t-out">India &#127470;&#127475; | Agentic AI &bull; LangChain &bull; LiteLLM &bull; MCP</span>`; },
  skills:   ()=>{ snd('click'); return [
    '<span class="t-out" style="text-decoration:underline;">STACK</span>',
    '<span class="t-out">  AI/ML  : LangChain, LiteLLM, Agentic AI</span>',
    '<span class="t-out">         : RAG, Fine-tuning, Prompt Eng.</span>',
    '<span class="t-out">  Agents : MCP Tools, Multi-Agent, AutoGen</span>',
    '<span class="t-out">  Code   : Python, TypeScript, Bash</span>',
    '<span class="t-out">  Infra  : Docker, AWS, FastAPI, Linux</span>',
  ].join(''); },
  projects: ()=>{ snd('open'); openWin('win-projects'); return `<span class="t-out">Opening Projects...</span>`; },
  contact:  ()=>{ snd('open'); openWin('win-contact');  return `<span class="t-out">Opening Contact...</span>`; },
  github:   ()=>{ snd('open'); ieOpen((CONFIG.links.find(l=>l.label.includes('GitHub'))||{}).url||'https://github.com'); return `<span class="t-out">Opening GitHub in Explorer...</span>`; },
  linkedin: ()=>{ snd('open'); ieOpen((CONFIG.links.find(l=>l.label.includes('LinkedIn'))||{}).url||'https://linkedin.com'); return `<span class="t-out">Opening LinkedIn in Explorer...</span>`; },
  ie:       ()=>{ snd('open'); openWin('win-ie'); return `<span class="t-out">Launching Internet Explorer...</span>`; },
  date:     ()=>{ snd('click'); return `<span class="t-out">${new Date().toLocaleString()}</span>`; },
  matrix:   ()=>{ snd('chime'); startMatrixEgg(); return `<span class="t-out">INITIATING NEURAL MATRIX...</span>`; },
  snake:    ()=>{ snd('game'); setTimeout(()=>gameStart('snake'),60);    return `<span class="t-out">Loading SNAKE...</span><span class="t-out">  ARROWS/WASD=move  SPACE=pause  Q=quit</span>`; },
  tetris:   ()=>{ snd('game'); setTimeout(()=>gameStart('tetris'),60);   return `<span class="t-out">Loading TETRIS...</span><span class="t-out">  ARROWS/WASD=move  SPACE=drop   Q=quit</span>`; },
  invaders: ()=>{ snd('game'); setTimeout(()=>gameStart('invaders'),60); return `<span class="t-out">Loading SPACE INVADERS...</span><span class="t-out">  LEFT/RIGHT=move   SPACE=shoot  Q=quit</span>`; },
  clear:    ()=>'__CLEAR__',
};

function termKey(e){
  if(e.key !== 'Enter') return;
  const inp = document.getElementById('term-in');
  const raw = inp.value.trim();
  inp.value = '';
  if(!raw) return;

  const out = document.getElementById('term-out');
  const parts = raw.split(' ');
  const cmd = parts[0].toLowerCase();

  let res = '';
  if(cmd === 'echo'){
    res = `<span class="t-out">${parts.slice(1).join(' ')}</span>`;
  } else if(cmd === 'open'){
    const url = parts.slice(1).join(' ').trim();
    if(!url){ res = `<span class="t-err">Usage: open [url]</span>`; }
    else { ieOpen(url); res = `<span class="t-out">Opening ${url} in Internet Explorer...</span>`; }
  } else if(CMDS[cmd]){
    res = CMDS[cmd]();
  } else {
    res = `<span class="t-err">-bash: ${cmd}: command not found</span>`;
  }

  if(res === '__CLEAR__'){ out.innerHTML=''; return; }

  const block = document.createElement('div');
  block.className = 'term-block';
  block.innerHTML = `<span class="t-cmd">${window._TERM_PROMPT||"$"} ${raw}</span>${res}`;
  out.appendChild(block);
  out.scrollTop = out.scrollHeight;
}

function termRun(cmd){
  openWin('win-terminal');
  setTimeout(()=>{
    document.getElementById('term-in').value = cmd;
    termKey({key:'Enter'});
    document.getElementById('term-in').focus();
  }, 150);
}

/* ══════════════════════════════════════════════════════
   CONTACT SEND
══════════════════════════════════════════════════════ */
function handleSend(){
  const btn = document.getElementById('send-btn');
  btn.textContent = '✓ SENT!';
  btn.disabled = true;
  setTimeout(()=>{ btn.textContent='SEND'; btn.disabled=false; }, 2500);
}

/* ══════════════════════════════════════════════════════
   ALERT
══════════════════════════════════════════════════════ */
function showAlert(msg){
  mbCloseAll();
  snd('alert');
  document.getElementById('alert-msg').innerHTML = msg.replace(/\n/g,'<br>');
  document.getElementById('mac-alert').classList.add('show');
}

/* ══════════════════════════════════════════════════════
   INTERNET EXPLORER — CARD PREVIEW ENGINE
══════════════════════════════════════════════════════ */
const ieHistory = [];
let ieHPos = -1;
let ieFavVisible = false;

/* ── Site database ───────────────────────────────── */
const IE_SITES = {
  // keyed by hostname or special '#slug'
  'github.com': {
    name: 'GitHub — virajchikhale',
    logo: '&#128008;',
    banner: 'code',
    desc: 'Viraj\'s GitHub profile. Explore repositories covering agentic AI workflows, LLM tooling, MCP integrations, RAG pipelines and more.',
    tags: ['Python','TypeScript','LangChain','LiteLLM','Agentic AI','MCP'],
    stats: [{v:'AI',l:'FOCUSED'},{v:'Open',l:'SOURCE'},{v:'&#9679;',l:'ACTIVE'}],
    actions: [{label:'&#128279; View Profile', url:'https://github.com/virajchikhale'},{label:'&#128008; Explore', url:'https://github.com/virajchikhale', ghost:true}],
    hint: 'github.com/virajchikhale'
  },
  'linkedin.com': {
    name: 'LinkedIn — Viraj Chikhale',
    logo: '&#128188;',
    banner: 'network',
    desc: 'Viraj Chikhale on LinkedIn. AI/ML Engineer specialising in agentic workflows, LangChain, LiteLLM and MCP protocol. Open to collaborations.',
    tags: ['AI/ML','Agentic AI','LangChain','Python','TypeScript','MCP'],
    stats: [{v:'AI/ML',l:'ENGINEER'},{v:'India',l:'&#127470;&#127475;'},{v:'Open',l:'TO WORK'}],
    actions: [{label:'&#128188; View Profile', url:'https://linkedin.com/in/virajchikhale'},{label:'&#127760; Visit Site', url:'https://linkedin.com', ghost:true}],
    hint: 'linkedin.com/in/virajchikhale'
  },
  'google.com': {
    name: 'Google',
    logo: '&#128269;',
    banner: 'search',
    desc: 'Google Search is the world\'s most widely used web search engine. Search billions of web pages, images, videos, maps and more in milliseconds.',
    tags: ['Search','Web','Maps','Gmail','Chrome'],
    stats: [{v:'8.5B',l:'SEARCHES/DAY'},{v:'4.3B',l:'USERS'},{v:'200+',l:'PRODUCTS'}],
    actions: [{label:'&#128279; Open Google', url:'https://google.com'}],
    hint: 'google.com'
  },
  'wikipedia.org': {
    name: 'Wikipedia',
    logo: '&#128214;',
    banner: 'wiki',
    desc: 'Wikipedia is a free, multilingual online encyclopedia written and maintained by a community of volunteer contributors. The world\'s largest reference website.',
    tags: ['Encyclopedia','Free','Open','Knowledge','Wiki'],
    stats: [{v:'60M+',l:'ARTICLES'},{v:'300+',l:'LANGUAGES'},{v:'1.7B',l:'VISITORS/MO'}],
    actions: [{label:'&#128214; Visit Wikipedia', url:'https://wikipedia.org'}],
    hint: 'wikipedia.org'
  },
  // special slugs for projects without live URLs
  '#ecommerce': {
    name: 'E-Commerce App',
    logo: '&#128722;',
    banner: 'shop',
    desc: 'Full-stack e-commerce platform with product listings, cart management, user authentication, and Stripe payment integration. Mobile-first responsive design.',
    tags: ['React','Node.js','MongoDB','Stripe','REST API'],
    stats: [{v:'20+',l:'FEATURES'},{v:'<2s',l:'LOAD TIME'},{v:'100%',l:'RESPONSIVE'}],
    actions: [{label:'&#128008; View on GitHub', url:'https://github.com/virajchikhale', ghost:true}],
    hint: 'Project by Viraj Chikhale'
  },
  '#chat': {
    name: 'Real-time Chat App',
    logo: '&#128172;',
    banner: 'chat',
    desc: 'WebSocket-based real-time chat application featuring rooms, private messaging, emoji reactions, file sharing, and live online presence tracking.',
    tags: ['Socket.io','React','Redis','Node.js','WebSockets'],
    stats: [{v:'<50ms',l:'LATENCY'},{v:'∞',l:'ROOMS'},{v:'Real-time',l:'PRESENCE'}],
    actions: [{label:'&#128008; View on GitHub', url:'https://github.com/virajchikhale', ghost:true}],
    hint: 'Project by Viraj Chikhale'
  },
  'virajchikhale.github.io': {
    name: 'VC\u00B7OS Portfolio',
    logo: '&#127968;',
    banner: 'pyos',
    desc: 'You are inside it! A Mac OS 1984-inspired interactive portfolio built by Viraj Chikhale with vanilla HTML, CSS &amp; JS. Draggable windows, terminal, dock, menu bar and this very browser.',
    tags: ['HTML','CSS','JavaScript','Mac OS','Pixel Art','No Frameworks'],
    stats: [{v:'0',l:'FRAMEWORKS'},{v:'6+',l:'APPS'},{v:'100%',l:'HAND-CODED'}],
    actions: [{label:'&#127968; Live Site', url:'https://github.com/virajchikhale'},{label:'&#128008; GitHub', url:'https://github.com/virajchikhale', ghost:true}],
    hint: 'VC\u00B7OS by Viraj Chikhale'
  },
};

/* Banner canvas drawers */
function ieBannerDraw(canvas, type){
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#f4f4f4'; ctx.fillRect(0,0,W,H);

  if(type==='code'){
    // terminal-style lines
    ctx.fillStyle='#000';
    const lines=['>_ git commit -m "portfolio update"','const hello = () => "world";','npm run build && npm start','// TODO: sleep','import React from "react";'];
    ctx.font=`${Math.round(H*0.11)}px "Press Start 2P",monospace`;
    lines.forEach((l,i)=>{ ctx.globalAlpha=0.08+i*0.04; ctx.fillText(l,10,22+i*Math.round(H*0.18)); });
    ctx.globalAlpha=1;
    // big icon
    ctx.font=`bold ${Math.round(H*0.55)}px serif`; ctx.fillStyle='#000'; ctx.globalAlpha=0.12;
    ctx.fillText('{ }', W/2-40, H*0.75);
    ctx.globalAlpha=1;
  } else if(type==='network'){
    // dots connected
    ctx.fillStyle='#000'; ctx.strokeStyle='#000'; ctx.globalAlpha=0.12;
    const nodes=[[W*.2,H*.3],[W*.5,H*.2],[W*.8,H*.35],[W*.35,H*.7],[W*.65,H*.65],[W*.5,H*.5]];
    const edges=[[0,1],[1,2],[0,3],[1,5],[2,4],[3,5],[4,5],[0,5]];
    ctx.lineWidth=1.5;
    edges.forEach(([a,b])=>{ ctx.beginPath();ctx.moveTo(nodes[a][0],nodes[a][1]);ctx.lineTo(nodes[b][0],nodes[b][1]);ctx.stroke(); });
    nodes.forEach(([x,y])=>{ ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fill(); });
    ctx.globalAlpha=1;
  } else if(type==='search'){
    ctx.strokeStyle='#000'; ctx.lineWidth=3; ctx.globalAlpha=0.1;
    // magnifier
    ctx.beginPath();ctx.arc(W*.42,H*.48,H*.28,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();ctx.moveTo(W*.63,H*.68);ctx.lineTo(W*.8,H*.84);ctx.stroke();
    ctx.globalAlpha=1;
  } else if(type==='wiki'){
    ctx.fillStyle='#000'; ctx.globalAlpha=0.07;
    for(let i=0;i<8;i++){
      ctx.fillRect(20, 14+i*14, W*0.4+Math.random()*W*0.3, 6);
    }
    ctx.globalAlpha=1;
  } else if(type==='shop'){
    ctx.strokeStyle='#000'; ctx.lineWidth=2; ctx.globalAlpha=0.1;
    // shopping bag shape
    ctx.strokeRect(W*.3,H*.35,W*.4,H*.45);
    ctx.beginPath();ctx.moveTo(W*.38,H*.35);ctx.quadraticCurveTo(W*.38,H*.18,W*.5,H*.18);ctx.quadraticCurveTo(W*.62,H*.18,W*.62,H*.35);ctx.stroke();
    ctx.globalAlpha=1;
  } else if(type==='chat'){
    ctx.fillStyle='#000'; ctx.globalAlpha=0.08;
    // speech bubbles
    ctx.beginPath(); ctx.roundRect(W*.1,H*.15,W*.55,H*.32,8); ctx.fill();
    ctx.beginPath(); ctx.roundRect(W*.35,H*.55,W*.55,H*.3,8); ctx.fill();
    ctx.globalAlpha=1;
  } else if(type==='pyos'){
    // mac icon tiled
    ctx.fillStyle='#000'; ctx.globalAlpha=0.06;
    for(let col=0;col<4;col++) for(let row=0;row<2;row++){
      const cx=col*W/4+W/8, cy=row*H/2+H/4;
      ctx.strokeStyle='#000'; ctx.lineWidth=1.5;
      ctx.strokeRect(cx-16,cy-14,32,22);
      ctx.fillRect(cx-12,cy-11,24,14);
    }
    ctx.globalAlpha=1;
  }
  // subtle grid overlay
  ctx.strokeStyle='#000'; ctx.lineWidth=0.5; ctx.globalAlpha=0.04;
  for(let x=0;x<W;x+=20){ ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke(); }
  for(let y=0;y<H;y+=20){ ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke(); }
  ctx.globalAlpha=1;
}

/* Resolve a URL to a site key */
function ieResolveKey(url){
  if(!url || url==='about:blank') return null;
  if(url.startsWith('#')) return url; // slug
  try{
    const u = new URL(url);
    const host = u.hostname.replace('www.','');
    // exact match
    if(IE_SITES[host]) return host;
    // subdomain match
    for(const k of Object.keys(IE_SITES)){
      if(host===k || host.endsWith('.'+k)) return k;
    }
  }catch(e){}
  return '__unknown__';
}

/* Render home screen */
function ieRenderHome(){
  const el = document.getElementById('ie-page-content');
  const c = document.createElement('canvas');
  c.width=60; c.height=60;
  // draw IE globe
  drawIE(c);
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'ie-home-screen';
  wrap.innerHTML = `
    <div style="border:2px solid #000;padding:8px;">${c.outerHTML}</div>
    <div class="ie-home-title">Internet Explorer</div>
    <div class="ie-home-sub">VC\u00B7OS Browser v1.0<br>Type a URL above or click a Favorite to browse.</div>
    <div class="ie-home-links">
      <span class="ie-home-link" onclick="ieOpen('https://github.com/virajchikhale')">&#128008; GitHub</span>
      <span class="ie-home-link" onclick="ieOpen('https://linkedin.com/in/virajchikhale')">&#128188; LinkedIn</span>
      <span class="ie-home-link" onclick="ieOpen('https://virajchikhale.github.io/')">&#127968; Portfolio</span>
      <span class="ie-home-link" onclick="ieOpen('https://google.com')">&#128269; Google</span>
    </div>`;
  el.appendChild(wrap);
}

/* ── OG Meta Fetcher via CORS proxy ─────────────── */
async function ieFetchOG(url){
  // allorigins returns {contents: '<html>...'} — free CORS proxy
  const proxy = 'https://api.allorigins.win/get?url=' + encodeURIComponent(url);
  const res = await fetch(proxy, {signal: AbortSignal.timeout(8000)});
  if(!res.ok) throw new Error('proxy error');
  const json = await res.json();
  const html = json.contents || '';

  // Parse meta tags with regex (no DOM parser needed)
  const og = {};
  const metas = [
    ['title',       /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i],
    ['title',       /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i],
    ['desc',        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i],
    ['desc',        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i],
    ['desc',        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i],
    ['image',       /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i],
    ['image',       /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i],
    ['siteName',    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i],
    ['siteName',    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i],
    ['themeColor',  /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i],
  ];
  metas.forEach(([key, rx])=>{
    if(!og[key]){ const m = html.match(rx); if(m) og[key] = m[1]; }
  });
  // Fallback title from <title>
  if(!og.title){ const m = html.match(/<title[^>]*>([^<]+)<\/title>/i); if(m) og.title = m[1].trim(); }

  return og;
}

/* Render a live OG preview card */
function ieRenderOGCard(url, og){
  const el = document.getElementById('ie-page-content');
  let host = url;
  try{ host = new URL(url).hostname.replace('www.',''); }catch(e){}

  const title    = og.title    || host;
  const desc     = og.desc     || 'No description available.';
  const siteName = og.siteName || host;
  const imgUrl   = og.image    || '';

  // Banner: og:image if available, else pattern
  const bannerHTML = imgUrl
    ? `<img src="${imgUrl}" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.parentElement.innerHTML='<span style=font-size:36px;opacity:0.15>&#127760;</span>'">`
    : `<span style="font-size:36px;opacity:0.15;">&#127760;</span>`;

  el.innerHTML = `
    <div class="ie-card">
      <div class="ie-card-banner" style="background:#f0f0f0;overflow:hidden;">
        ${bannerHTML}
      </div>
      <div class="ie-card-info">
        <div class="ie-card-top">
          <div class="ie-card-logo">
            <img src="https://www.google.com/s2/favicons?domain=${host}&sz=32"
              width="32" height="32"
              style="image-rendering:pixelated;"
              onerror="this.outerHTML='&#127760;'"/>
          </div>
          <div class="ie-card-meta">
            <div class="ie-card-name">${title}</div>
            <div class="ie-card-url">${siteName} &mdash; ${host}</div>
            <div class="ie-card-desc">${desc}</div>
          </div>
        </div>
        <div class="ie-card-divider"></div>
        <div class="ie-card-actions">
          <a class="ie-action-btn" href="${url}" target="_blank">&#128279; Open ${host} &#8599;</a>
        </div>
        <div class="ie-newtab-hint">&#9432; Live preview via Open Graph metadata &mdash; VC\u00B7OS Internet Explorer v1.0</div>
      </div>
    </div>`;
}

/* Render unknown — now tries OG fetch first */
async function ieRenderUnknown(url){
  const el = document.getElementById('ie-page-content');
  let host = url;
  try{ host = new URL(url).hostname.replace('www.',''); }catch(e){}

  // Show skeleton while fetching
  el.innerHTML = `
    <div class="ie-card">
      <div class="ie-card-banner" style="background:#f0f0f0;align-items:center;justify-content:center;display:flex;">
        <span style="font-size:7px;color:#aaa;font-family:'Press Start 2P',monospace;">FETCHING PREVIEW...</span>
      </div>
      <div class="ie-card-info">
        <div class="ie-card-top">
          <div class="ie-card-logo" style="background:#f0f0f0;border:2px solid #ddd;">
            <img src="https://www.google.com/s2/favicons?domain=${host}&sz=32" width="32" height="32" style="image-rendering:pixelated;" onerror="this.outerHTML='&#127760;'"/>
          </div>
          <div class="ie-card-meta">
            <div class="ie-card-name" style="background:#eee;color:#eee;border-radius:2px;">Loading title...</div>
            <div class="ie-card-url">${host}</div>
            <div class="ie-card-desc" style="color:#bbb;">Fetching Open Graph metadata from the page...</div>
          </div>
        </div>
      </div>
    </div>`;

  try {
    const og = await ieFetchOG(url);
    // If we got at least a title or description, show the real card
    if(og.title || og.desc){
      ieRenderOGCard(url, og);
      // update title bar with real title
      if(og.title) document.getElementById('ie-title').textContent = og.title + ' \u2014 Internet Explorer';
    } else {
      ieFallbackUnknown(url, host);
    }
  } catch(e){
    ieFallbackUnknown(url, host);
  }
}

/* Pure fallback when OG fetch fails */
function ieFallbackUnknown(url, host){
  document.getElementById('ie-page-content').innerHTML = `
    <div class="ie-card">
      <div class="ie-card-banner" style="background:#f4f4f4;align-items:center;justify-content:center;display:flex;">
        <span style="font-size:36px;opacity:0.12;">&#127760;</span>
      </div>
      <div class="ie-card-info">
        <div class="ie-card-top">
          <div class="ie-card-logo">
            <img src="https://www.google.com/s2/favicons?domain=${host}&sz=32" width="32" height="32" style="image-rendering:pixelated;" onerror="this.outerHTML='&#127760;'"/>
          </div>
          <div class="ie-card-meta">
            <div class="ie-card-name">${host}</div>
            <div class="ie-card-url">${url}</div>
            <div class="ie-card-desc">Preview could not be loaded. This may be due to network restrictions or the site not providing Open Graph metadata.</div>
          </div>
        </div>
        <div class="ie-card-actions">
          <a class="ie-action-btn" href="${url}" target="_blank">&#128279; Open in New Tab &#8599;</a>
        </div>
        <div class="ie-newtab-hint">VC\u00B7OS Internet Explorer v1.0</div>
      </div>
    </div>`;
}

/* Main render function */

/* Main render function */
function ieRenderCard(key, url){
  const site = IE_SITES[key];
  const el = document.getElementById('ie-page-content');
  el.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'ie-card';

  // Banner
  const banner = document.createElement('div');
  banner.className = 'ie-card-banner';
  const bc = document.createElement('canvas');
  bc.width = 560; bc.height = 100;
  bc.style.width='100%'; bc.style.height='100%';
  banner.appendChild(bc);
  card.appendChild(banner);

  // Info box
  const statsHTML = (site.stats||[]).map(s=>`<div class="ie-stat"><div class="isv">${s.v}</div><div class="isl">${s.l}</div></div>`).join('');
  const tagsHTML  = (site.tags||[]).map(t=>`<span class="ie-card-tag">${t}</span>`).join('');
  const actsHTML  = (site.actions||[]).map(a=>
    `<a class="ie-action-btn ${a.ghost?'ghost':''}" href="${a.url}" target="_blank">${a.label}</a>`
  ).join('');

  const info = document.createElement('div');
  info.className = 'ie-card-info';
  info.innerHTML = `
    <div class="ie-card-top">
      <div class="ie-card-logo">${site.logo}</div>
      <div class="ie-card-meta">
        <div class="ie-card-name">${site.name}</div>
        <div class="ie-card-url">${site.hint||url}</div>
        <div class="ie-card-desc">${site.desc}</div>
      </div>
    </div>
    ${tagsHTML ? `<div class="ie-card-tags">${tagsHTML}</div>` : ''}
    ${statsHTML ? `<div class="ie-card-divider"></div><div class="ie-card-stats">${statsHTML}</div>` : ''}
    ${actsHTML  ? `<div class="ie-card-actions">${actsHTML}</div>` : ''}
    <div class="ie-newtab-hint">&#8599; Links open in your real browser &mdash; VC\u00B7OS Internet Explorer v1.0</div>`;
  card.appendChild(info);
  el.appendChild(card);

  // Draw banner after DOM insertion (needs layout)
  requestAnimationFrame(()=>{
    bc.width = banner.clientWidth || 560;
    ieBannerDraw(bc, site.banner||'code');
  });
}

/* Loading animation */
function ieShowLoading(msg){
  const ld = document.getElementById('ie-loading');
  document.getElementById('ie-loading-txt').textContent = msg;
  document.getElementById('ie-loading-bar').style.width = '0%';
  ld.classList.add('show');
  // animate bar
  let pct = 0;
  const iv = setInterval(()=>{
    pct = Math.min(95, pct + (Math.random()*18+5));
    document.getElementById('ie-loading-bar').style.width = pct + '%';
    if(pct >= 95) clearInterval(iv);
  }, 120);
  return iv;
}
function ieHideLoading(iv){
  const bar = document.getElementById('ie-loading-bar');
  bar.style.width = '100%';
  setTimeout(()=>{
    document.getElementById('ie-loading').classList.remove('show');
    if(iv) clearInterval(iv);
  }, 200);
}

/* ── Public API ─────────────────────────────────── */
function ieSetStatus(msg, loading=false){
  document.getElementById('ie-status').textContent = msg;
  const dot = document.getElementById('ie-dot');
  dot.className = 'ie-status-dot ' + (loading ? 'loading' : 'done');
}
function ieUpdateNav(){
  document.getElementById('ie-back').disabled = ieHPos <= 0;
  document.getElementById('ie-fwd').disabled  = ieHPos >= ieHistory.length - 1;
}

function ieOpen(url){
  if(!url) return;
  // Normalize
  if(!url.startsWith('http') && !url.startsWith('about:') && !url.startsWith('#')){
    url = 'https://' + url;
  }

  // Update URL bar + title
  document.getElementById('ie-url').value = url === 'about:blank' ? '' : url;
  let title = url;
  try{ title = url.startsWith('#') ? url.slice(1) : new URL(url).hostname.replace('www.',''); }catch(e){}
  document.getElementById('ie-title').textContent = title + ' \u2014 Internet Explorer';

  // Push history
  if(ieHistory[ieHPos] !== url){
    ieHistory.splice(ieHPos + 1);
    ieHistory.push(url);
    ieHPos = ieHistory.length - 1;
  }
  ieUpdateNav();

  // Open IE window
  openWin('win-ie');

  // Scroll viewport to top
  document.getElementById('ie-viewport').scrollTop = 0;

  if(url === 'about:blank'){
    ieHideLoading(null);
    ieRenderHome();
    ieSetStatus('Ready', false);
    return;
  }

  // Show loading
  const iv = ieShowLoading('Connecting to ' + title + '...');
  ieSetStatus('Loading ' + title + '...', true);

  setTimeout(async ()=>{
    const key = ieResolveKey(url);
    if(key === '__unknown__'){
      ieHideLoading(iv);
      ieSetStatus('Fetching preview...', true);
      await ieRenderUnknown(url);
      ieSetStatus('Done', false);
    } else if(key){
      ieHideLoading(iv);
      ieRenderCard(key, url);
      ieSetStatus('Done', false);
    } else {
      ieHideLoading(iv);
      ieRenderHome();
      ieSetStatus('Ready', false);
    }
  }, 600 + Math.random()*300);
}

function ieNavigate(){
  let url = document.getElementById('ie-url').value.trim();
  if(!url){ ieOpen('about:blank'); return; }
  if(!url.startsWith('http') && !url.startsWith('#') && !url.startsWith('about:')) url = 'https://' + url;
  // Reset history pos if navigating from url bar (don't push duplicate)
  if(ieHistory[ieHPos] === url){ return; }
  ieOpen(url);
}

function ieBack(){
  if(ieHPos > 0){
    ieHPos--;
    ieUpdateNav();
    const url = ieHistory[ieHPos];
    document.getElementById('ie-url').value = url;
    // navigate directly without pushing history
    _ieNavigateDirect(url);
  }
}
function ieFwd(){
  if(ieHPos < ieHistory.length - 1){
    ieHPos++;
    ieUpdateNav();
    const url = ieHistory[ieHPos];
    document.getElementById('ie-url').value = url;
    _ieNavigateDirect(url);
  }
}
async function _ieNavigateDirect(url){
  let title = url;
  try{ title = url.startsWith('#') ? url.slice(1) : new URL(url).hostname.replace('www.',''); }catch(e){}
  document.getElementById('ie-title').textContent = title + ' \u2014 Internet Explorer';
  document.getElementById('ie-viewport').scrollTop = 0;
  const iv = ieShowLoading('Loading ' + title + '...');
  ieSetStatus('Loading...', true);
  await new Promise(r=>setTimeout(r, 500));
  const key = ieResolveKey(url);
  if(key === '__unknown__'){
    ieHideLoading(iv);
    ieSetStatus('Fetching preview...', true);
    await ieRenderUnknown(url);
    ieSetStatus('Done', false);
  } else if(key){
    ieHideLoading(iv);
    ieRenderCard(key, url);
    ieSetStatus('Done', false);
  } else {
    ieHideLoading(iv);
    ieRenderHome();
    ieSetStatus('Ready', false);
  }
}

function ieReload(){
  const url = ieHistory[ieHPos];
  if(url) _ieNavigateDirect(url);
}
function ieHome(){
  const homeUrl = (CONFIG.links.find(l=>l.action==='ie')||{}).url || 'about:blank';
  ieOpen(homeUrl);
}
function ieFavToggle(){
  ieFavVisible = !ieFavVisible;
  const bar = document.getElementById('ie-fav-bar');
  const btn = document.getElementById('ie-fav-toggle');
  bar.classList.toggle('hidden', !ieFavVisible);
  btn.style.background = ieFavVisible ? '#000' : '#fff';
  btn.style.color = ieFavVisible ? '#fff' : '#000';
}



/* ══════════════════════════════════════════════════════
   SOUND ENGINE — Web Audio API synthesized Mac sounds
   All sounds recreated from scratch, no files needed.
══════════════════════════════════════════════════════ */
let _AC = null;
function getAC(){
  if(!_AC){ try{ _AC = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
  return _AC;
}

/* Core tone builder */
function _tone(freq, type, dur, vol, when, envA, envR){
  const ac = getAC(); if(!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain); gain.connect(ac.destination);
  osc.type = type||'square';
  osc.frequency.setValueAtTime(freq, when||ac.currentTime);
  gain.gain.setValueAtTime(0, when||ac.currentTime);
  gain.gain.linearRampToValueAtTime(vol||0.18, (when||ac.currentTime)+(envA||0.01));
  gain.gain.exponentialRampToValueAtTime(0.001, (when||ac.currentTime)+dur+(envR||0.05));
  osc.start(when||ac.currentTime);
  osc.stop((when||ac.currentTime)+dur+(envR||0.05)+0.05);
}

/* Noise burst (for explosions, error) */
function _noise(dur, vol, when){
  const ac = getAC(); if(!ac) return;
  const buf = ac.createBuffer(1, ac.sampleRate*dur, ac.sampleRate);
  const data = buf.getChannelData(0);
  for(let i=0;i<data.length;i++) data[i]=(Math.random()*2-1);
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  const filt = ac.createBiquadFilter();
  filt.type='bandpass'; filt.frequency.value=800;
  src.buffer=buf; src.connect(filt); filt.connect(gain); gain.connect(ac.destination);
  gain.gain.setValueAtTime(vol||0.12, when||ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001,(when||ac.currentTime)+dur);
  src.start(when||ac.currentTime); src.stop((when||ac.currentTime)+dur+0.05);
}

/* Named sounds */
const SOUNDS = {
  /* Mac 1984 startup: 600Hz square wave beep (Andy Hertzfeld's original) */
  boot: ()=>{
    _tone(600,'square',0.18,0.22,null,0.005,0.08);
  },

  /* Window open: quick two-note ascending "bloop" */
  open: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    _tone(523,'square',0.06,0.14,t,0.005,0.04);
    _tone(784,'square',0.08,0.14,t+0.07,0.005,0.06);
  },

  /* Window close: descending two notes */
  close: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    _tone(784,'square',0.05,0.12,t,0.005,0.03);
    _tone(440,'square',0.07,0.10,t+0.06,0.005,0.05);
  },

  /* Button/menu click: single short tick */
  click: ()=>{
    _tone(1200,'square',0.025,0.10,null,0.002,0.02);
  },

  /* Alert/error: classic Mac "sosumi" style descending chord */
  alert: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    _tone(880,'square',0.12,0.15,t,0.01,0.08);
    _tone(698,'square',0.14,0.12,t+0.01,0.01,0.08);
    _tone(523,'square',0.18,0.14,t+0.02,0.01,0.10);
  },

  /* Mac startup chime recreation: C-major chord shimmer */
  chime: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    const notes=[261,329,392,523,659];
    notes.forEach((f,i)=>{
      _tone(f,'sine',0.6,0.07,t+i*0.04,0.02,0.5);
    });
  },

  /* Game start: ascending arpeggio */
  game: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    [523,659,784,1047].forEach((f,i)=>{
      _tone(f,'square',0.06,0.12,t+i*0.055,0.005,0.04);
    });
  },

  /* Snake: eat food — short high blip */
  eat: ()=>{ _tone(1318,'square',0.04,0.12,null,0.003,0.02); },

  /* Snake/game: die — descending sad tones */
  die: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    [523,415,330,262].forEach((f,i)=>{
      _tone(f,'square',0.09,0.14,t+i*0.09,0.005,0.06);
    });
  },

  /* Tetris: line clear — quick fanfare */
  lineclear: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    [523,523,659,784].forEach((f,i)=>{
      _tone(f,'square',0.07,0.14,t+i*0.065,0.005,0.04);
    });
  },

  /* Tetris: piece land — short thud */
  land: ()=>{ _noise(0.04,0.18); _tone(180,'square',0.04,0.12,null,0.002,0.03); },

  /* Invaders: shoot — classic laser zap */
  shoot: ()=>{
    const ac=getAC();if(!ac)return;
    const osc=ac.createOscillator();
    const gain=ac.createGain();
    osc.connect(gain); gain.connect(ac.destination);
    osc.type='square';
    const t=ac.currentTime;
    osc.frequency.setValueAtTime(900,t);
    osc.frequency.exponentialRampToValueAtTime(200,t+0.12);
    gain.gain.setValueAtTime(0.15,t);
    gain.gain.exponentialRampToValueAtTime(0.001,t+0.14);
    osc.start(t); osc.stop(t+0.16);
  },

  /* Invaders: alien explode — noise burst + low boom */
  explode: ()=>{
    _noise(0.15,0.20);
    _tone(80,'square',0.15,0.18,null,0.005,0.12);
  },

  /* Invaders: player hit — ugly descending crash */
  playerhit: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    _noise(0.3,0.22,t);
    [400,300,200,100].forEach((f,i)=>_tone(f,'sawtooth',0.09,0.14,t+i*0.06,0.005,0.06));
  },

  /* Game over screen */
  gameover: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    [392,330,294,261].forEach((f,i)=>{
      _tone(f,'square',0.14,0.16,t+i*0.14,0.01,0.10);
    });
  },

  /* Wave complete fanfare */
  wave: ()=>{
    const ac=getAC();if(!ac)return;
    const t=ac.currentTime;
    [523,659,784,1047,784,1047].forEach((f,i)=>{
      _tone(f,'square',0.07,0.14,t+i*0.07,0.005,0.04);
    });
  },
};

function snd(name){ try{ SOUNDS[name]&&SOUNDS[name](); }catch(e){} }

/* ══════════════════════════════════════════════════════
   ARCADE GAME ENGINE
   Commands: snake | tetris | invaders
══════════════════════════════════════════════════════ */

let gameLoop = null;
let gameState = null;
let gameName  = null;
let gamePaused = false;

const GCVS = ()=> document.getElementById('game-canvas');
const GCTX = ()=> GCVS().getContext('2d');

/* ── Shared helpers ─────────────────────────────── */
function gameSetTitle(t){ document.getElementById('game-title').textContent = t; }
function gameSetScore(s){ document.getElementById('game-score').textContent = 'SCORE: '+s; }
function gameSetControls(t){ document.getElementById('game-footer').textContent = t; }

function gameShowMsg(html, sub=''){
  const m = document.getElementById('game-msg');
  m.innerHTML = html + (sub?`<br><span style="font-size:6px;color:#777;">${sub}</span>`:'');
  m.classList.add('show');
}
function gameHideMsg(){ document.getElementById('game-msg').classList.remove('show'); }

function gameQuit(){
  if(gameLoop){ clearInterval(gameLoop); gameLoop=null; }
  gameState=null; gameName=null; gamePaused=false;
  document.getElementById('game-overlay').classList.remove('show');
  document.getElementById('term-title').textContent = 'Terminal \u2014 VC\u00B7OS';
  document.getElementById('term-in').focus();
  // remove game key listener
  document.removeEventListener('keydown', gameKeyHandler);
}

function gameStart(name){
  openWin('win-terminal');
  // resize terminal window bigger for games
  const tw = document.getElementById('win-terminal');
  if(parseInt(tw.style.width)<480){ tw.style.width='480px'; }
  if(parseInt(tw.style.height)<360){ tw.style.height='360px'; }

  gameName = name;
  gamePaused = false;
  gameHideMsg();
  document.getElementById('game-overlay').classList.add('show');
  document.getElementById('term-title').textContent = name.toUpperCase()+' \u2014 VC\u00B7OS';
  document.removeEventListener('keydown', gameKeyHandler);
  document.addEventListener('keydown', gameKeyHandler);

  // size canvas to fill wrap
  setTimeout(()=>{
    const wrap = document.getElementById('game-canvas-wrap');
    const W = Math.min(wrap.clientWidth - 16, 320);
    const H = Math.min(wrap.clientHeight - 8, 260);
    const cv = GCVS();
    cv.width  = W;
    cv.height = H;
    if(name==='snake')    snakeInit();
    if(name==='tetris')   tetrisInit();
    if(name==='invaders') invadersInit();
  }, 60);
}

/* Global key router */
function gameKeyHandler(e){
  if(!gameName) return;
  // Q = quit
  if(e.key==='q'||e.key==='Q'){ e.preventDefault(); gameQuit(); return; }
  // Space = pause (all games)
  if(e.key===' '){ e.preventDefault();
    if(gameName==='tetris'){ tetrisHardDrop(); return; }
    if(gameName==='invaders'){ invadersShoot(); return; }
    // snake: toggle pause
    gamePaused=!gamePaused;
    if(gamePaused) gameShowMsg('PAUSED','SPACE to resume');
    else gameHideMsg();
    return;
  }
  if(gamePaused) return;
  if(gameName==='snake')    snakeKey(e);
  if(gameName==='tetris')   tetrisKey(e);
  if(gameName==='invaders') invadersKey(e);
}

/* ══════════════════════════════════════════════════════
   SNAKE
══════════════════════════════════════════════════════ */
let SN = {};
function snakeInit(){
  gameSetTitle('SNAKE');
  gameSetScore(0);
  gameSetControls('ARROWS / WASD \u00b7 SPACE=pause \u00b7 Q=quit');
  const cv=GCVS(); const W=cv.width, H=cv.height;
  const CELL=12;
  const COLS=Math.floor(W/CELL), ROWS=Math.floor(H/CELL);
  SN = {
    CELL, COLS, ROWS,
    body:[{x:Math.floor(COLS/2),y:Math.floor(ROWS/2)}],
    dir:{x:1,y:0}, nextDir:{x:1,y:0},
    food:null, score:0, speed:160,
    dead:false,
  };
  snakeSpawnFood();
  if(gameLoop) clearInterval(gameLoop);
  gameLoop = setInterval(snakeTick, SN.speed);
  gameShowMsg('SNAKE','SPACE / any key to start \u00b7 Q=quit');
  const startOnce = (e)=>{
    if(e.key==='q'||e.key==='Q') return;
    gameHideMsg(); document.removeEventListener('keydown',startOnce);
  };
  document.addEventListener('keydown', startOnce);
}
function snakeSpawnFood(){
  const {COLS,ROWS,body}=SN;
  let f;
  do{ f={x:Math.floor(Math.random()*COLS),y:Math.floor(Math.random()*ROWS)}; }
  while(body.some(s=>s.x===f.x&&s.y===f.y));
  SN.food=f;
}
function snakeKey(e){
  const d=SN.nextDir;
  if((e.key==='ArrowUp'||e.key==='w'||e.key==='W')    && SN.dir.y===0) SN.nextDir={x:0,y:-1};
  if((e.key==='ArrowDown'||e.key==='s'||e.key==='S')  && SN.dir.y===0) SN.nextDir={x:0,y:1};
  if((e.key==='ArrowLeft'||e.key==='a'||e.key==='A')  && SN.dir.x===0) SN.nextDir={x:-1,y:0};
  if((e.key==='ArrowRight'||e.key==='d'||e.key==='D') && SN.dir.x===0) SN.nextDir={x:1,y:0};
  e.preventDefault();
}
function snakeTick(){
  if(gamePaused||SN.dead) return;
  SN.dir={...SN.nextDir};
  const head={x:SN.body[0].x+SN.dir.x, y:SN.body[0].y+SN.dir.y};
  // wall wrap
  head.x=(head.x+SN.COLS)%SN.COLS;
  head.y=(head.y+SN.ROWS)%SN.ROWS;
  // self collision
  if(SN.body.some(s=>s.x===head.x&&s.y===head.y)){
    SN.dead=true;
    snd('gameover');
    gameShowMsg('GAME OVER<br>SCORE: '+SN.score,'SPACE to restart \u00b7 Q=quit');
    document.addEventListener('keydown', function restart(e){
      if(e.key===' '){ document.removeEventListener('keydown',restart); snakeInit(); }
    });
    return;
  }
  SN.body.unshift(head);
  if(head.x===SN.food.x && head.y===SN.food.y){
    SN.score+=10; gameSetScore(SN.score);
    snd('eat');
    snakeSpawnFood();
    // speed up every 5 food
    if(SN.score%50===0 && SN.speed>60){
      SN.speed=Math.max(60,SN.speed-20);
      clearInterval(gameLoop);
      gameLoop=setInterval(snakeTick,SN.speed);
    }
  } else {
    SN.body.pop();
  }
  snakeDraw();
}
function snakeDraw(){
  const cv=GCVS(), ctx=GCTX();
  const {CELL,COLS,ROWS,body,food}=SN;
  const W=cv.width, H=cv.height;
  // background
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  // grid dots
  ctx.fillStyle='rgba(0,0,0,0.06)';
  for(let x=0;x<COLS;x++) for(let y=0;y<ROWS;y++)
    ctx.fillRect(x*CELL+CELL/2-1,y*CELL+CELL/2-1,2,2);
  // food — blinking pixel art apple
  ctx.fillStyle='#000';
  ctx.fillRect(food.x*CELL+2, food.y*CELL+2, CELL-4, CELL-4);
  ctx.fillStyle='#fff';
  ctx.fillRect(food.x*CELL+4, food.y*CELL+4, 2, 2);
  // snake body
  body.forEach((s,i)=>{
    ctx.fillStyle= i===0 ? '#000' : (i%2===0?'#222':'#444');
    ctx.fillRect(s.x*CELL+1, s.y*CELL+1, CELL-2, CELL-2);
    if(i===0){
      // eyes
      ctx.fillStyle='#fff';
      const ex = SN.dir.x===1?CELL-4:SN.dir.x===-1?2:3;
      const ey = SN.dir.y===1?CELL-4:SN.dir.y===-1?2:3;
      ctx.fillRect(s.x*CELL+ex,   s.y*CELL+ey,   2,2);
      ctx.fillRect(s.x*CELL+ex+3, s.y*CELL+ey,   2,2);
    }
  });
  // score overlay
  ctx.fillStyle='rgba(0,0,0,0.5)';
  ctx.fillRect(0,0,W,10);
  ctx.fillStyle='#fff';
  ctx.font='6px "Press Start 2P",monospace';
  ctx.fillText('SCORE:'+SN.score, 3, 8);
}

/* ══════════════════════════════════════════════════════
   TETRIS
══════════════════════════════════════════════════════ */
let TT = {};
const SHAPES=[
  [[1,1,1,1]],                          // I
  [[1,1],[1,1]],                        // O
  [[0,1,0],[1,1,1]],                    // T
  [[1,0],[1,0],[1,1]],                  // L
  [[0,1],[0,1],[1,1]],                  // J
  [[0,1,1],[1,1,0]],                    // S
  [[1,1,0],[0,1,1]],                    // Z
];
const PATTERNS=[
  repeating_line,repeating_cross,repeating_dot,
  repeating_checker,repeating_diag,repeating_square,repeating_wave
];
function repeating_line(ctx,x,y,w,h){
  ctx.fillStyle='#000';ctx.fillRect(x,y,w,h);
  ctx.fillStyle='#fff';
  for(let i=2;i<h-1;i+=3) ctx.fillRect(x+1,y+i,w-2,1);
}
function repeating_cross(ctx,x,y,w,h){
  ctx.fillStyle='#000';ctx.fillRect(x,y,w,h);
  ctx.fillStyle='#fff';
  ctx.fillRect(x+w/2-1,y+1,2,h-2);
  ctx.fillRect(x+1,y+h/2-1,w-2,2);
}
function repeating_dot(ctx,x,y,w,h){
  ctx.fillStyle='#000';ctx.fillRect(x,y,w,h);
  ctx.fillStyle='#fff';
  for(let dx=2;dx<w-1;dx+=3) for(let dy=2;dy<h-1;dy+=3) ctx.fillRect(x+dx,y+dy,1,1);
}
function repeating_checker(ctx,x,y,w,h){
  ctx.fillStyle='#000';ctx.fillRect(x,y,w,h);
  ctx.fillStyle='#fff';
  for(let dx=0;dx<w;dx+=2) for(let dy=0;dy<h;dy+=2) if((dx/2+dy/2)%2===0) ctx.fillRect(x+dx,y+dy,2,2);
}
function repeating_diag(ctx,x,y,w,h){
  ctx.fillStyle='#000';ctx.fillRect(x,y,w,h);
  ctx.fillStyle='#fff';
  for(let d=0;d<w+h;d+=3) ctx.fillRect(x+d,y,1,h);
}
function repeating_square(ctx,x,y,w,h){
  ctx.fillStyle='#000';ctx.fillRect(x,y,w,h);
  ctx.fillStyle='#fff';ctx.strokeStyle='#fff';ctx.lineWidth=1;
  ctx.strokeRect(x+2,y+2,w-4,h-4);
}
function repeating_wave(ctx,x,y,w,h){
  ctx.fillStyle='#000';ctx.fillRect(x,y,w,h);
  ctx.fillStyle='#fff';
  for(let dx=1;dx<w-1;dx+=2){
    const dy=Math.round(Math.sin(dx/2)*2)+Math.floor(h/2);
    ctx.fillRect(x+dx,y+dy,1,1);
  }
}

function tetrisInit(){
  gameSetTitle('TETRIS');
  gameSetScore(0);
  gameSetControls('ARROWS/WASD \u00b7 SPACE=hard drop \u00b7 Q=quit');
  const cv=GCVS(); const W=cv.width, H=cv.height;
  const CELL=Math.floor(Math.min(W,H*0.6)/10);
  const COLS=10, ROWS=Math.floor(H/CELL);
  TT={
    CELL,COLS,ROWS,
    board: Array.from({length:ROWS},()=>Array(COLS).fill(0)),
    patBoard: Array.from({length:ROWS},()=>Array(COLS).fill(0)),
    piece:null, score:0, lines:0, speed:600, dead:false,
    ox:Math.floor((W-COLS*CELL)/2),
  };
  tetrisSpawn();
  if(gameLoop) clearInterval(gameLoop);
  gameLoop=setInterval(tetrisTick,TT.speed);
}
function tetrisSpawn(){
  const idx=Math.floor(Math.random()*SHAPES.length);
  const shape=SHAPES[idx].map(r=>[...r]);
  TT.piece={shape, x:Math.floor(TT.COLS/2)-Math.floor(shape[0].length/2), y:0, pat:idx};
  if(tetrisCollide(TT.piece,0,0)){
    TT.dead=true;
    snd('gameover');
    gameShowMsg('GAME OVER<br>SCORE:'+TT.score,'SPACE to restart \u00b7 Q=quit');
    document.addEventListener('keydown',function restart(e){
      if(e.key===' '){document.removeEventListener('keydown',restart);tetrisInit();}
    });
  }
}
function tetrisCollide(p,dx,dy){
  return p.shape.some((row,r)=>row.some((cell,c)=>{
    if(!cell) return false;
    const nx=p.x+c+dx, ny=p.y+r+dy;
    return nx<0||nx>=TT.COLS||ny>=TT.ROWS||(ny>=0&&TT.board[ny][nx]);
  }));
}
function tetrisPlace(){
  snd('land');
  TT.piece.shape.forEach((row,r)=>row.forEach((cell,c)=>{
    if(cell&&TT.piece.y+r>=0){
      TT.board[TT.piece.y+r][TT.piece.x+c]=1;
      TT.patBoard[TT.piece.y+r][TT.piece.x+c]=TT.piece.pat+1;
    }
  }));
  // clear lines
  let cleared=0;
  for(let r=TT.ROWS-1;r>=0;r--){
    if(TT.board[r].every(c=>c)){
      TT.board.splice(r,1); TT.board.unshift(Array(TT.COLS).fill(0));
      TT.patBoard.splice(r,1); TT.patBoard.unshift(Array(TT.COLS).fill(0));
      cleared++; r++;
    }
  }
  if(cleared){
    TT.lines+=cleared;
    TT.score+=[0,100,300,500,800][cleared]||800;
    snd('lineclear');
    gameSetScore(TT.score);
    if(TT.lines%10===0&&TT.speed>150){
      TT.speed=Math.max(150,TT.speed-60);
      clearInterval(gameLoop);gameLoop=setInterval(tetrisTick,TT.speed);
    }
  }
  tetrisSpawn();
}
function tetrisKey(e){
  if(e.key==='ArrowLeft'||e.key==='a'||e.key==='A'){if(!tetrisCollide(TT.piece,-1,0))TT.piece.x--;}
  if(e.key==='ArrowRight'||e.key==='d'||e.key==='D'){if(!tetrisCollide(TT.piece,1,0))TT.piece.x++;}
  if(e.key==='ArrowDown'||e.key==='s'||e.key==='S'){if(!tetrisCollide(TT.piece,0,1))TT.piece.y++;}
  if(e.key==='ArrowUp'||e.key==='w'||e.key==='W'){
    const rot=TT.piece.shape[0].map((_,i)=>TT.piece.shape.map(r=>r[i]).reverse());
    const tmp={...TT.piece,shape:rot};
    if(!tetrisCollide(tmp,0,0))TT.piece.shape=rot;
  }
  e.preventDefault();
  tetrisDraw();
}
function tetrisHardDrop(){
  while(!tetrisCollide(TT.piece,0,1)) TT.piece.y++;
  tetrisPlace(); tetrisDraw();
}
function tetrisTick(){
  if(gamePaused||TT.dead)return;
  if(!tetrisCollide(TT.piece,0,1)) TT.piece.y++;
  else tetrisPlace();
  tetrisDraw();
}
function tetrisDraw(){
  const cv=GCVS(),ctx=GCTX(),{CELL,COLS,ROWS,board,patBoard,piece,ox}=TT;
  const W=cv.width,H=cv.height;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
  // board cells
  board.forEach((row,r)=>row.forEach((cell,c)=>{
    if(cell){
      const pat=patBoard[r][c];
      PATTERNS[pat-1](ctx,ox+c*CELL,r*CELL,CELL,CELL);
      ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.strokeRect(ox+c*CELL+0.5,r*CELL+0.5,CELL-1,CELL-1);
    } else {
      ctx.strokeStyle='rgba(0,0,0,0.05)';ctx.lineWidth=0.5;
      ctx.strokeRect(ox+c*CELL,r*CELL,CELL,CELL);
    }
  }));
  // ghost piece
  let gy=piece.y;
  while(!tetrisCollide({...piece,y:gy+1},0,0)) gy++;
  piece.shape.forEach((row,r)=>row.forEach((cell,c)=>{
    if(cell&&gy+r>=0){
      ctx.fillStyle='rgba(0,0,0,0.08)';
      ctx.fillRect(ox+(piece.x+c)*CELL+1,(gy+r)*CELL+1,CELL-2,CELL-2);
    }
  }));
  // current piece
  piece.shape.forEach((row,r)=>row.forEach((cell,c)=>{
    if(cell&&piece.y+r>=0){
      PATTERNS[piece.pat](ctx,ox+(piece.x+c)*CELL,(piece.y+r)*CELL,CELL,CELL);
      ctx.strokeStyle='#fff';ctx.lineWidth=1;
      ctx.strokeRect(ox+(piece.x+c)*CELL+0.5,(piece.y+r)*CELL+0.5,CELL-1,CELL-1);
    }
  }));
  // board border
  ctx.strokeStyle='#000';ctx.lineWidth=2;
  ctx.strokeRect(ox,0,COLS*CELL,ROWS*CELL);
  // score
  ctx.fillStyle='rgba(0,0,0,0.55)';ctx.fillRect(0,0,W,10);
  ctx.fillStyle='#fff';ctx.font='6px "Press Start 2P",monospace';
  ctx.fillText('SCORE:'+TT.score+' LINES:'+TT.lines,3,8);
}

/* ══════════════════════════════════════════════════════
   SPACE INVADERS
══════════════════════════════════════════════════════ */
let IV = {};
function invadersInit(){
  gameSetTitle('INVADERS');
  gameSetScore(0);
  gameSetControls('LEFT/RIGHT \u00b7 SPACE=shoot \u00b7 Q=quit');
  const cv=GCVS();const W=cv.width,H=cv.height;
  const ROWS=4,COLS=8,SW=22,SH=14,PAD=6;
  const gridW=COLS*(SW+PAD),gridH=ROWS*(SH+PAD);
  IV={
    W,H,
    player:{x:W/2-8,w:20,h:8,speed:4},
    bullet:null, bombs:[],
    aliens: buildAliens(COLS,ROWS,SW,SH,PAD,W),
    dir:1,stepTimer:0,stepInterval:40,
    score:0,lives:3,dead:false,wave:1,
    bombTimer:0,bombInterval:90,
    particles:[],
  };
  if(gameLoop) clearInterval(gameLoop);
  gameLoop=setInterval(invadersTick,1000/30);
  gameShowMsg('SPACE INVADERS','SPACE to start');
  document.addEventListener('keydown',function start(e){
    if(e.key==='q'||e.key==='Q')return;
    gameHideMsg();document.removeEventListener('keydown',start);
  });
}
function buildAliens(COLS,ROWS,SW,SH,PAD,W){
  const aliens=[];
  const totalW=COLS*(SW+PAD);
  const startX=(W-totalW)/2;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    aliens.push({
      x:startX+c*(SW+PAD), y:24+r*(SH+PAD),
      w:SW,h:SH, alive:true, row:r, col:c, frame:0
    });
  }
  return aliens;
}
function invadersKey(e){
  if(e.key==='ArrowLeft'||e.key==='a'||e.key==='A')  IV.player.vx=-IV.player.speed;
  if(e.key==='ArrowRight'||e.key==='d'||e.key==='D') IV.player.vx= IV.player.speed;
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'||e.key==='a'||e.key==='A'||e.key==='d'||e.key==='D') e.preventDefault();
}
function invadersShoot(){
  if(!IV.bullet){
    snd('shoot');
    IV.bullet={x:IV.player.x+10,y:IV.H-30,w:2,h:8,vy:-10};
  }
}
// also fire on keydown space
document.addEventListener('keydown', e=>{
  if(gameName==='invaders'&&e.key===' '){ e.preventDefault(); invadersShoot(); }
});

function invadersTick(){
  if(gamePaused||IV.dead) return;
  const {W,H}=IV;

  // move player
  if(IV.player.vx){
    IV.player.x=Math.max(0,Math.min(W-IV.player.w,IV.player.x+IV.player.vx));
    IV.player.vx*=0.7;
    if(Math.abs(IV.player.vx)<0.2) IV.player.vx=0;
  }

  // move bullet
  if(IV.bullet){
    IV.bullet.y+=IV.bullet.vy;
    if(IV.bullet.y<0) IV.bullet=null;
  }

  // move aliens en masse
  IV.stepTimer++;
  if(IV.stepTimer>=IV.stepInterval){
    IV.stepTimer=0;
    const alive=IV.aliens.filter(a=>a.alive);
    const minX=Math.min(...alive.map(a=>a.x));
    const maxX=Math.max(...alive.map(a=>a.x+a.w));
    // reverse direction + drop when hitting wall
    if((IV.dir>0&&maxX>=W-4)||(IV.dir<0&&minX<=4)){
      IV.dir*=-1;
      alive.forEach(a=>a.y+=10);
    } else {
      alive.forEach(a=>{ a.x+=IV.dir*8; a.frame^=1; });
    }
    IV.stepInterval=Math.max(10,40-IV.aliens.filter(a=>a.alive).length*0.5);
  }

  // bombs
  IV.bombTimer++;
  if(IV.bombTimer>=IV.bombInterval){
    IV.bombTimer=0;
    const alive=IV.aliens.filter(a=>a.alive);
    if(alive.length){
      const bomber=alive[Math.floor(Math.random()*alive.length)];
      IV.bombs.push({x:bomber.x+bomber.w/2-1,y:bomber.y+bomber.h,w:3,h:6,vy:4});
    }
  }
  IV.bombs.forEach(b=>b.y+=b.vy);
  IV.bombs=IV.bombs.filter(b=>b.y<H);

  // bullet-alien collision
  if(IV.bullet){
    for(const a of IV.aliens){
      if(!a.alive) continue;
      if(IV.bullet.x<a.x+a.w&&IV.bullet.x+IV.bullet.w>a.x&&
         IV.bullet.y<a.y+a.h&&IV.bullet.y+IV.bullet.h>a.y){
        a.alive=false; IV.bullet=null;
        IV.score+=a.row===0?30:a.row===1?20:10;
        snd('explode');
        gameSetScore(IV.score);
        // explosion particles
        for(let i=0;i<8;i++) IV.particles.push({
          x:a.x+a.w/2,y:a.y+a.h/2,
          vx:(Math.random()-0.5)*4,vy:(Math.random()-0.5)*4,
          life:12
        });
        break;
      }
    }
  }

  // bomb-player collision
  for(const b of IV.bombs){
    if(b.x<IV.player.x+IV.player.w&&b.x+b.w>IV.player.x&&
       b.y<H-10&&b.y+b.h>H-20){
      IV.lives--;
      snd('playerhit');
      IV.bombs=IV.bombs.filter(bb=>bb!==b);
      for(let i=0;i<12;i++) IV.particles.push({
        x:IV.player.x+10,y:H-16,
        vx:(Math.random()-0.5)*5,vy:(Math.random()-0.5)*5,
        life:16
      });
      if(IV.lives<=0){
        IV.dead=true;
        snd('gameover');
        gameShowMsg('GAME OVER<br>SCORE:'+IV.score,'SPACE to restart \u00b7 Q=quit');
        document.addEventListener('keydown',function restart(e){
          if(e.key===' '){document.removeEventListener('keydown',restart);invadersInit();}
        });
        return;
      }
      break;
    }
  }

  // alien reaches player line
  if(IV.aliens.some(a=>a.alive&&a.y+a.h>=H-22)){
    IV.dead=true;
    snd('gameover');
    gameShowMsg('INVADED!<br>SCORE:'+IV.score,'SPACE to restart');
    document.addEventListener('keydown',function restart(e){
      if(e.key===' '){document.removeEventListener('keydown',restart);invadersInit();}
    });
    return;
  }

  // all aliens dead — next wave
  if(!IV.aliens.some(a=>a.alive)){
    IV.wave++;
    IV.stepInterval=Math.max(8,40-IV.wave*4);
    IV.bombInterval=Math.max(40,90-IV.wave*8);
    IV.aliens=buildAliens(8,4,22,14,6,W);
    snd('wave');
    gameShowMsg('WAVE '+IV.wave,'Get ready!');
    setTimeout(gameHideMsg,1200);
  }

  // particles
  IV.particles.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.life--;});
  IV.particles=IV.particles.filter(p=>p.life>0);

  invadersDraw();
}

function invadersDraw(){
  const cv=GCVS(),ctx=GCTX(),{W,H,player,bullet,bombs,aliens,particles,lives,wave}=IV;
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);

  // starfield
  ctx.fillStyle='rgba(0,0,0,0.12)';
  for(let i=0;i<30;i++){
    const sx=(i*73+wave*17)%W, sy=(i*41+wave*7)%H;
    ctx.fillRect(sx,sy,1,1);
  }

  // aliens
  aliens.forEach(a=>{
    if(!a.alive) return;
    ctx.fillStyle='#000';
    // body
    ctx.fillRect(a.x+2,a.y,a.w-4,a.h);
    // legs (animated)
    if(a.frame){
      ctx.fillRect(a.x,a.y+4,3,a.h-4);
      ctx.fillRect(a.x+a.w-3,a.y+4,3,a.h-4);
    } else {
      ctx.fillRect(a.x+2,a.y+a.h-3,3,3);
      ctx.fillRect(a.x+a.w-5,a.y+a.h-3,3,3);
    }
    // eyes
    ctx.fillStyle='#fff';
    ctx.fillRect(a.x+4,a.y+3,3,3);
    ctx.fillRect(a.x+a.w-7,a.y+3,3,3);
    ctx.fillStyle='#000';
    ctx.fillRect(a.x+5,a.y+4,2,2);
    ctx.fillRect(a.x+a.w-6,a.y+4,2,2);
  });

  // bombs
  ctx.fillStyle='#000';
  bombs.forEach(b=>{
    // zigzag bolt
    ctx.fillRect(b.x,b.y,b.w,2);
    ctx.fillRect(b.x-1,b.y+2,b.w,2);
    ctx.fillRect(b.x,b.y+4,b.w,2);
  });

  // bullet
  if(bullet){
    ctx.fillStyle='#000';
    ctx.fillRect(bullet.x,bullet.y,bullet.w,bullet.h);
    // trail
    ctx.fillStyle='rgba(0,0,0,0.2)';
    ctx.fillRect(bullet.x,bullet.y+bullet.h,bullet.w,4);
  }

  // player ship
  ctx.fillStyle='#000';
  ctx.fillRect(player.x+8,H-26,4,4);       // top nub
  ctx.fillRect(player.x+2,H-22,player.w-4,6); // body
  ctx.fillRect(player.x,H-16,player.w,8);   // base

  // particles
  particles.forEach(p=>{
    ctx.fillStyle=`rgba(0,0,0,${p.life/16})`;
    ctx.fillRect(p.x,p.y,2,2);
  });

  // HUD
  ctx.fillStyle='rgba(0,0,0,0.6)';
  ctx.fillRect(0,0,W,11);
  ctx.fillStyle='#fff';
  ctx.font='6px "Press Start 2P",monospace';
  ctx.fillText('SCORE:'+IV.score,3,8);
  ctx.fillText('WAVE:'+IV.wave,W/2-20,8);
  ctx.fillText('LIVES:'+'■'.repeat(IV.lives),W-60,8);

  // ground line
  ctx.strokeStyle='rgba(0,0,0,0.25)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(0,H-8);ctx.lineTo(W,H-8);ctx.stroke();
}

/* ══════════════════════════════════════════════════════
   RETRO EFFECTS
══════════════════════════════════════════════════════ */

/* Pixel Rain */
function initPixelRain(){
  const rain = document.getElementById('desk-rain');
  if(!rain) return;
  const chars = '01アLANGCHAINMCPLLM∞∑∆∇PYTHON';
  for(let i=0;i<24;i++){
    const d = document.createElement('div');
    const sz = 6+Math.floor(Math.random()*5);
    d.style.cssText=[
      'position:absolute',
      'left:'+Math.random()*96+'%',
      'top:-40px',
      "font-family:'Press Start 2P',monospace",
      'font-size:'+sz+'px',
      'color:#000',
      'opacity:'+(0.028+Math.random()*0.05),
      'animation:rainFall '+(7+Math.random()*13)+'s linear '+(Math.random()*10)+'s infinite',
      'pointer-events:none','user-select:none','white-space:nowrap'
    ].join(';');
    d.textContent=chars[Math.floor(Math.random()*chars.length)];
    setInterval(()=>{d.textContent=chars[Math.floor(Math.random()*chars.length)];},700+Math.random()*1400);
    rain.appendChild(d);
  }
}

/* Matrix Easter Egg */
let matrixActive=false;
function startMatrixEgg(){
  if(matrixActive)return;
  matrixActive=true;
  openWin('win-terminal');
  const out=document.getElementById('term-out');
  const chars='01アLANGCHAINMCPAGENTPYTHON LLM RAG';
  let count=0;
  const iv=setInterval(()=>{
    let line='';
    for(let i=0;i<34;i++)line+=chars[Math.floor(Math.random()*chars.length)];
    const s=document.createElement('div');
    s.className='term-block';
    s.innerHTML='<span class="t-out" style="opacity:'+(0.2+Math.random()*0.8)+';letter-spacing:0.06em;">'+line+'</span>';
    out.appendChild(s);out.scrollTop=out.scrollHeight;
    if(++count>20){
      clearInterval(iv);matrixActive=false;
      const end=document.createElement('div');end.className='term-block';
      end.innerHTML='<span class="t-out" style="display:block;border-top:1px solid #000;padding-top:4px;margin-top:4px;">&#9829; NEURAL MATRIX ONLINE &mdash; WELCOME, '+CONFIG.user.name.toUpperCase()+'.</span>';
      out.appendChild(end);out.scrollTop=out.scrollHeight;
    }
  },80);
}

/* CRT menubar flicker */
function initMenubarFlicker(){
  const mb=document.getElementById('menubar');
  setInterval(()=>{
    if(Math.random()>0.97){mb.style.opacity='0.82';setTimeout(()=>{mb.style.opacity='1';},55);}
  },350);
}

/* Blinking clock colon */
function startClock(){
  const el=document.getElementById('mb-clock');
  let flip=true;
  const tick=()=>{
    const d=new Date();
    const hh=String(d.getHours()).padStart(2,'0');
    const mm=String(d.getMinutes()).padStart(2,'0');
    flip=!flip;
    el.textContent=hh+(flip?':':' ')+mm;
  };
  tick();setInterval(tick,500);
}

/* Window title flash on open */
function flashTitle(id){
  const el=document.getElementById(id);if(!el)return;
  const tb=el.querySelector('.tb-title');if(!tb)return;
  const orig=tb.textContent;let n=0;
  const iv=setInterval(()=>{
    tb.textContent=(n%2===0)?'\u2588 '+orig+' \u2588':orig;
    if(++n>5){clearInterval(iv);tb.textContent=orig;}
  },100);
}

/* Patch openWin to flash title */
const _openWinBase=window.openWin;
window.openWin=function(id){snd('open');_openWinBase(id);setTimeout(()=>flashTitle(id),130);};

/* Desktop icon wobble */
function dskSelect(el){
  dskClearAll();el.classList.add('sel');
  const cv=el.querySelector('canvas');if(!cv)return;
  cv.style.transition='transform 0.08s';
  cv.style.transform='rotate(-5deg) scale(1.1)';
  setTimeout(()=>{cv.style.transform='rotate(3deg)';},80);
  setTimeout(()=>{cv.style.transform='rotate(0deg) scale(1)';},160);
}

/* Dock click flash */
function initDockFlash(){
  document.querySelectorAll('.dk-item').forEach(dk=>{
    dk.addEventListener('mousedown',()=>{
      dk.style.background='rgba(0,0,0,0.22)';
      dk.style.transform='translateY(0) scale(0.93)';
      setTimeout(()=>{dk.style.background='';dk.style.transform='';},130);
    });
  });
}

/* Boot label typewriter */
function animateBootLabel(){
  const el=document.getElementById('boot-ver-line');
  if(!el) return;
  const txt = CONFIG.meta.osName+' v'+CONFIG.meta.version+' \u00a9 '+CONFIG.meta.year+' '+
              CONFIG.user.name.toUpperCase()+' \u2014 '+CONFIG.user.role.toUpperCase();
  el.textContent = '';
  let i = 0;
  const iv = setInterval(()=>{
    el.textContent += txt[i++];
    if(i >= txt.length) clearInterval(iv);
  }, 24);
  const bt = document.getElementById('boot-title-bar');
  if(bt) bt.textContent = CONFIG.meta.osName+' \u2014 '+CONFIG.user.role.toUpperCase()+' SYSTEM STARTUP v'+CONFIG.meta.version;
}

/* ══════════════════════════════════════════════════════
   KICK OFF
══════════════════════════════════════════════════════ */
animateBootLabel();
runBoot();
const _bootDur=300+9*340+760;
setTimeout(initPixelRain,   _bootDur);
setTimeout(initMenubarFlicker,_bootDur+200);
setTimeout(initDockFlash,   _bootDur+100);

