/* ═══════════════════════════════════════════════════════════════
   Cedaris — Interactive JS  ·  v3
   Neon Blue + White  ·  2027 Redesign
   styles.css owns all static colours — this file handles:
   dynamic elements, dark mode, interactions, animations
═══════════════════════════════════════════════════════════════ */

const ready = fn =>
  document.readyState !== 'loading'
    ? fn()
    : document.addEventListener('DOMContentLoaded', fn);

ready(() => {

  /* ══════════════════════════════════════════════════
     DYNAMIC STYLES — only for JS-injected elements
     and dark-mode overrides not in styles.css
  ══════════════════════════════════════════════════ */
  const dynStyle = document.createElement('style');
  dynStyle.textContent = `

    /* ── Page entry ── */
    @keyframes pageIn { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }
    body { animation: pageIn 0.38s ease both; }

    /* ── Scroll progress bar ── */
    #scroll-progress {
      position: fixed; top: 0; left: 0; height: 3px; width: 0%;
      background: linear-gradient(90deg, #00A8E8, #00E0FF, #fff);
      z-index: 9999; border-radius: 0 2px 2px 0;
      box-shadow: 0 0 12px rgba(0,194,255,0.65);
      pointer-events: none; transition: width 0.1s linear;
    }

    /* ── Dark mode toggle pill ── */
    #darkToggle {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 12px; border-radius: 999px;
      background: rgba(0,194,255,0.07);
      border: 1px solid rgba(0,194,255,0.22);
      cursor: pointer; font-size: 12px; font-weight: 600;
      color: #0088CC; font-family: var(--font-body);
      transition: all 0.2s; white-space: nowrap; flex-shrink: 0;
    }
    #darkToggle:hover { background: #00A8E8; color: #fff; border-color: #00A8E8; }
    #darkToggle svg { width: 13px; height: 13px; flex-shrink: 0; }

    /* ── Scroll-to-top ── */
    #scrollTop {
      position: fixed; bottom: 28px; right: 28px;
      width: 44px; height: 44px; border-radius: 50%;
      background: linear-gradient(135deg, #00A8E8, #007BB5);
      color: #fff; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 18px rgba(0,160,220,0.42), 0 0 0 0 rgba(0,194,255,0);
      opacity: 0; transform: translateY(16px) scale(0.85);
      transition: opacity 0.3s, transform 0.3s, background 0.2s, box-shadow 0.2s;
      z-index: 90;
    }
    #scrollTop.visible { opacity: 1; transform: translateY(0) scale(1); }
    #scrollTop:hover {
      background: linear-gradient(135deg, #00C2FF, #0090D0);
      transform: translateY(-3px) scale(1.08);
      box-shadow: 0 8px 24px rgba(0,194,255,0.50), 0 0 0 4px rgba(0,194,255,0.10);
    }
    #scrollTop svg { width: 18px; height: 18px; }
    #scrollTop::before {
      content: 'Top';
      position: absolute; right: calc(100% + 10px);
      font-size: 11px; font-weight: 600; color: #0088CC;
      font-family: var(--font-body); opacity: 0;
      transition: opacity 0.2s; white-space: nowrap; pointer-events: none;
      background: #fff; padding: 3px 9px; border-radius: 20px;
      border: 1px solid rgba(0,194,255,0.25);
      box-shadow: 0 2px 8px rgba(0,30,60,0.08);
    }
    #scrollTop.visible:hover::before { opacity: 1; }
    @media (max-width: 480px) { #scrollTop { bottom: 16px; right: 16px; width: 40px; height: 40px; } }

    /* ── Tooltip ── */
    [data-tip] { position: relative; }
    [data-tip]:hover::after {
      content: attr(data-tip);
      position: absolute; bottom: calc(100% + 8px); left: 50%;
      transform: translateX(-50%);
      background: #020D18; color: rgba(200,235,255,0.90);
      font-size: 11px; font-weight: 500;
      padding: 5px 10px; border-radius: 6px;
      white-space: nowrap; pointer-events: none; z-index: 200;
      font-family: var(--font-body);
      border: 1px solid rgba(0,194,255,0.20);
      box-shadow: 0 4px 16px rgba(0,0,0,0.30);
    }

    /* ── Ripple ── */
    .ripple-host { position: relative; overflow: hidden; }
    @keyframes rippleAnim { from { transform:scale(0); opacity:0.45; } to { transform:scale(4); opacity:0; } }
    .ripple-wave {
      position: absolute; border-radius: 50%;
      width: 100px; height: 100px; margin: -50px;
      background: rgba(255,255,255,0.38);
      pointer-events: none;
      animation: rippleAnim 0.55s ease-out forwards;
    }

    /* ── Typed cursor ── */
    @keyframes blink { 50% { opacity:0; } }
    .typed-cursor {
      display: inline-block; width: 2px; height: 1em;
      background: #00C2FF; margin-left: 3px;
      vertical-align: text-bottom;
      animation: blink 0.85s step-end infinite; border-radius: 1px;
      box-shadow: 0 0 8px rgba(0,194,255,0.60);
    }

    /* ── Module tabs ── */
    .module-tabs-wrap {
      display: flex; justify-content: center;
      margin-bottom: 36px;
    }
    .module-tabs {
      display: inline-flex; gap: 5px;
      background: rgba(0,194,255,0.06);
      border: 1px solid rgba(0,194,255,0.18);
      border-radius: 999px; padding: 5px; position: relative;
    }
    .mtab-pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 9px 18px; border-radius: 999px;
      border: 1.5px solid transparent; background: transparent;
      cursor: pointer; font-family: var(--font-body);
      font-size: 13px; font-weight: 600; color: #4A7090;
      letter-spacing: 0.01em;
      transition: color 0.2s, background 0.2s, border-color 0.2s, box-shadow 0.2s, transform 0.15s;
      white-space: nowrap; position: relative; z-index: 1;
    }
    .mtab-pill:hover:not(.active) { color: #07192A; background: rgba(255,255,255,0.65); }
    .mtab-pill.active {
      background: #fff; color: #0088CC;
      border-color: rgba(0,194,255,0.32);
      box-shadow: 0 2px 14px rgba(0,194,255,0.22), 0 1px 3px rgba(0,0,0,0.07);
    }
    .mtab-icon-bg {
      width: 26px; height: 26px; border-radius: 50%;
      background: rgba(0,194,255,0.09);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: background 0.2s;
    }
    .mtab-pill.active .mtab-icon-bg { background: rgba(0,194,255,0.16); }
    .mtab-icon-bg svg {
      width: 13px; height: 13px; stroke: currentColor; fill: none;
      stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
    }
    .mtab-label { line-height: 1; }
    @media (max-width: 720px) {
      .module-tabs-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; justify-content: flex-start; padding: 0 20px; }
      .module-tabs { flex-wrap: nowrap; border-radius: 16px; }
      .mtab-pill { font-size: 12px; padding: 8px 13px; }
      .mtab-icon-bg { width: 22px; height: 22px; }
    }

    /* ── Module panels ── */
    .module-panel { display: none; }
    .module-panel.active { display: grid; }
    @keyframes panelFadeUp { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }
    .module-panel.panel-in .mcard { animation: panelFadeUp 0.38s cubic-bezier(0.22,0.61,0.36,1) both; }
    .module-panel.panel-in .mcard:nth-child(1) { animation-delay: 0ms; }
    .module-panel.panel-in .mcard:nth-child(2) { animation-delay: 65ms; }
    .module-panel.panel-in .mcard:nth-child(3) { animation-delay: 130ms; }

    /* ── Hover lifts ── */
    .pillar      { transition: transform 0.28s var(--ease), box-shadow 0.28s, border-color 0.28s; }
    .pillar:hover{ transform: translateY(-5px); box-shadow: 0 14px 38px rgba(0,160,220,0.14); border-color: rgba(0,194,255,0.32); }
    .mcard       { transition: transform 0.22s, box-shadow 0.22s, border-color 0.22s; }
    .mcard:hover { transform: translateY(-3px); box-shadow: 0 8px 28px rgba(0,100,180,0.10); border-color: rgba(0,194,255,0.28); }
    .ind-card    { transition: transform 0.22s, background 0.2s; }
    .ind-card:hover { transform: translateY(-3px); }
    .svc-card    { transition: transform 0.22s, background 0.2s; }
    .svc-card:hover { transform: translateY(-3px); }
    .gal-item    { transition: transform 0.25s var(--ease), box-shadow 0.25s, border-color 0.25s; }
    .gal-item:hover { transform: translateY(-4px); box-shadow: 0 12px 36px rgba(0,100,180,0.13); border-color: rgba(0,194,255,0.30); }
    .quote-card  { transition: transform 0.22s, background 0.2s; }
    .quote-card:hover { transform: translateY(-3px); }
    .impact-card { transition: transform 0.22s, background 0.2s; }
    .impact-card:hover { transform: translateY(-3px) scale(1.015); }
    .step        { transition: background 0.2s; }
    .fv-frame    { transition: border-color 0.25s, box-shadow 0.25s; }
    .fv-frame:hover { border-color: rgba(0,194,255,0.30); box-shadow: 0 14px 44px rgba(0,100,180,0.12); }
    .compare-row { transition: background 0.18s; }

    /* ── Focus ring ── */
    :focus-visible { outline: 2px solid #00C2FF; outline-offset: 3px; border-radius: 4px; }

    /* ── Form animations ── */
    @keyframes formShake {
      0%,100% { transform:translateX(0); }
      20%     { transform:translateX(-6px); }
      40%     { transform:translateX(6px); }
      60%     { transform:translateX(-4px); }
      80%     { transform:translateX(4px); }
    }
    @keyframes successPop { 0%{transform:scale(0.97);} 60%{transform:scale(1.02);} 100%{transform:scale(1);} }

    /* ── Dark mode overrides ── */
    body.dark {
      --bg:       #040E18;
      --bg-soft:  #071525;
      --bg-mid:   #0A1E2E;
      --bg-card:  #071525;
      --border:   rgba(0,194,255,0.09);
      --border-2: rgba(0,194,255,0.17);
      --ink:      #E8F5FF;
      --text:     rgba(190,225,255,0.60);
      --muted:    rgba(140,195,235,0.38);
    }
    body.dark body { background: #040E18; }
    body.dark .site-header {
      background: rgba(4,14,24,0.95);
      border-bottom-color: rgba(0,194,255,0.09);
    }
    body.dark .nav-links {
      background: rgba(4,14,24,0.97);
      border-bottom-color: rgba(0,194,255,0.09);
    }
    body.dark .nav-links a      { color: rgba(180,220,255,0.55); }
    body.dark .nav-links a.active { color: #00C2FF; }
    body.dark .nav-links a:hover  { color: #fff; }
    body.dark .brand            { color: #E8F5FF; }
    body.dark h1, body.dark h2, body.dark h3, body.dark h4, body.dark h5 { color: #E8F5FF; }
    body.dark .kicker           { color: #00C2FF; background: rgba(0,194,255,0.08); border-color: rgba(0,194,255,0.22); }
    body.dark .kicker-light     { color: #00C2FF; }
    body.dark .pillar           { background: var(--bg-card); }
    body.dark .mcard            { background: var(--bg-card); }
    body.dark .demo-form        { background: var(--bg-card); border-color: rgba(0,194,255,0.12); }
    body.dark .field input,
    body.dark .field select,
    body.dark .field textarea   { background: #040E18; color: #E8F5FF; border-color: rgba(0,194,255,0.14); }
    body.dark .gal-item         { background: var(--bg-card); }
    body.dark .section-alt      { background: var(--bg-soft); }
    body.dark .compare-table    { border-color: rgba(0,194,255,0.10); }
    body.dark .compare-head     { background: rgba(0,194,255,0.04); border-bottom-color: rgba(0,194,255,0.10); }
    body.dark .compare-row      { background: var(--bg-card); border-bottom-color: rgba(0,194,255,0.07); }
    body.dark .compare-row:hover { background: rgba(0,194,255,0.05); }
    body.dark .compare-row .c-us { background: rgba(0,194,255,0.06); }
    body.dark .nav-toggle       { border-color: rgba(0,194,255,0.18); }
    body.dark .nav-toggle span  { background: #E8F5FF; }
    body.dark .btn-outline      { border-color: rgba(0,194,255,0.28); color: rgba(255,255,255,0.80); }
    body.dark #darkToggle       { background: rgba(0,194,255,0.08); border-color: rgba(0,194,255,0.20); color: #00C2FF; }
    body.dark #darkToggle:hover { background: #00A8E8; color: #fff; border-color: #00A8E8; }
    body.dark .lang-pill        { color: #00C2FF; background: rgba(0,194,255,0.08); border-color: rgba(0,194,255,0.20); }
    body.dark .faq details      { background: var(--bg-card); border-color: rgba(0,194,255,0.10); box-shadow: none; }
    body.dark .faq details[open] { border-color: rgba(0,194,255,0.28); }
    body.dark .faq summary      { color: #E8F5FF; }
    body.dark .faq details[open] summary { color: #00C2FF; }
    body.dark .faq p            { color: rgba(180,220,255,0.60); }
    body.dark .mtab-pill        { color: rgba(180,220,255,0.50); }
    body.dark .mtab-pill.active { background: rgba(0,194,255,0.12); color: #00C2FF; border-color: rgba(0,194,255,0.32); box-shadow: 0 0 18px rgba(0,194,255,0.16); }
    body.dark .mtab-pill:hover:not(.active) { color: #E8F5FF; background: rgba(255,255,255,0.05); }
    body.dark .module-tabs      { background: rgba(0,194,255,0.05); border-color: rgba(0,194,255,0.14); }
    body.dark .mtab-icon-bg     { background: rgba(0,194,255,0.10); }
    body.dark .industries-strip { background: rgba(0,194,255,0.03); }
    body.dark .pillar-icon,
    body.dark .mic,
    body.dark .ind-ic,
    body.dark .svc-ic           { background: rgba(0,194,255,0.10); border-color: rgba(0,194,255,0.20); }
    body.dark .cta-section      { background: var(--bg-soft); border-top-color: rgba(0,194,255,0.09); }
    body.dark .ind-card,
    body.dark .svc-card         { background: var(--bg-card); }
    body.dark .hero-stats       { border-top-color: rgba(0,194,255,0.10); }
    body.dark .stat-div         { background: rgba(0,194,255,0.10); }
    body.dark #scrollTop        { box-shadow: 0 4px 18px rgba(0,160,220,0.30); }
    body.dark #scrollTop::before { background: var(--bg-card); border-color: rgba(0,194,255,0.22); color: #00C2FF; }
    body.dark .hv-badge         { background: var(--bg-card); border-color: rgba(0,194,255,0.22); }
    body.dark .fv-chrome        { background: var(--bg-soft); border-bottom-color: rgba(0,194,255,0.09); }
    body.dark .gal-meta         { background: var(--bg-card); border-bottom-color: rgba(0,194,255,0.09); }
    body.dark .gal-frame        { background: var(--bg-soft); }

    /* ── Reduced motion ── */
    @media (prefers-reduced-motion: reduce) {
      body { animation: none; }
      .reveal { opacity:1 !important; transform:none !important; transition:none !important; }
      .typed-cursor { animation: none; opacity:1; }
      .industries-track { animation: none !important; }
      .hv-chip { animation: none !important; }
      .pulse-dot { animation: none !important; }
    }
  `;
  document.head.appendChild(dynStyle);


  /* ══════════════════════════════════════════════════
     1. SCROLL PROGRESS BAR
  ══════════════════════════════════════════════════ */
  const progressBar = document.createElement('div');
  progressBar.id = 'scroll-progress';
  document.body.prepend(progressBar);

  window.addEventListener('scroll', () => {
    const pct = Math.min(100,
      window.scrollY / (document.documentElement.scrollHeight - window.innerHeight) * 100);
    progressBar.style.width = pct + '%';
  }, { passive: true });


  /* ══════════════════════════════════════════════════
     2. HEADER SCROLL STATE
  ══════════════════════════════════════════════════ */
  const header = document.querySelector('.site-header');
  const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 10);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();


  /* ══════════════════════════════════════════════════
     3. SCROLL REVEAL — staggered siblings
  ══════════════════════════════════════════════════ */
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const siblings = [...entry.target.parentElement.querySelectorAll('.reveal:not(.in)')];
      const delay = siblings.indexOf(entry.target) * 70;
      setTimeout(() => entry.target.classList.add('in'), delay);
      revealObserver.unobserve(entry.target);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));


  /* ══════════════════════════════════════════════════
     4. ACTIVE NAV LINK
  ══════════════════════════════════════════════════ */
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-links a');

  const navObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const id = entry.target.id;
      navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${id}`));
    });
  }, { threshold: 0.25, rootMargin: '-10% 0px -70% 0px' });

  sections.forEach(s => navObserver.observe(s));


  /* ══════════════════════════════════════════════════
     5. MOBILE NAV TOGGLE
  ══════════════════════════════════════════════════ */
  const navToggle = document.getElementById('navToggle');
  const navMenu   = document.getElementById('navLinks');

  navToggle?.addEventListener('click', () => {
    const open = navToggle.getAttribute('aria-expanded') === 'true';
    navToggle.setAttribute('aria-expanded', String(!open));
    navMenu?.classList.toggle('open', !open);
    document.body.style.overflow = open ? '' : 'hidden';
  });
  navMenu?.querySelectorAll('a').forEach(a =>
    a.addEventListener('click', () => {
      navToggle?.setAttribute('aria-expanded', 'false');
      navMenu.classList.remove('open');
      document.body.style.overflow = '';
    })
  );


  /* ══════════════════════════════════════════════════
     6. STAT COUNTERS — animated on scroll-in
  ══════════════════════════════════════════════════ */
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  function animateCounter(el) {
    const raw   = el.textContent.trim();
    const match = raw.match(/^([+\-−$€£]?)([\d.,]+)(.*)$/);
    if (!match) return;
    const [, prefix, numStr, suffix] = match;
    const target   = parseFloat(numStr.replace(/,/g, ''));
    if (isNaN(target)) return;
    const decimals  = numStr.includes('.') ? numStr.split('.')[1].length : 0;
    const duration  = 1600;
    const startTime = performance.now();
    const step = now => {
      const p = Math.min((now - startTime) / duration, 1);
      el.textContent = prefix + (easeOut(p) * target).toFixed(decimals) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting || entry.target.dataset.counted) return;
      entry.target.dataset.counted = '1';
      animateCounter(entry.target);
      counterObserver.unobserve(entry.target);
    });
  }, { threshold: 0.6 });

  document.querySelectorAll('.impact-num').forEach(el => counterObserver.observe(el));


  /* ══════════════════════════════════════════════════
     7. MODULE TABS — stylish pill rebuild
  ══════════════════════════════════════════════════ */
  const tabData = [
    {
      panel: 'sales',
      label: 'Sales',
      icon: `<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`
    },
    {
      panel: 'ops',
      label: 'Operations',
      icon: `<svg viewBox="0 0 24 24"><path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`
    },
    {
      panel: 'finance',
      label: 'Finance',
      icon: `<svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`
    },
    {
      panel: 'team',
      label: 'Team',
      icon: `<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
    },
    {
      panel: 'intel',
      label: 'Intelligence',
      icon: `<svg viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z"/></svg>`
    }
  ];

  const oldTabList = document.querySelector('.module-tabs');
  if (oldTabList) {
    const wrap    = document.createElement('div');
    wrap.className = 'module-tabs-wrap';
    const newTabs = document.createElement('div');
    newTabs.className = 'module-tabs';
    newTabs.setAttribute('role', 'tablist');
    newTabs.setAttribute('aria-label', 'Module categories');

    tabData.forEach((t, i) => {
      const btn = document.createElement('button');
      btn.className = 'mtab-pill' + (i === 0 ? ' active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      btn.dataset.panel = t.panel;
      btn.innerHTML = `<span class="mtab-icon-bg">${t.icon}</span><span class="mtab-label">${t.label}</span>`;
      newTabs.appendChild(btn);
    });

    wrap.appendChild(newTabs);
    oldTabList.replaceWith(wrap);
  }

  const mTabs   = document.querySelectorAll('.mtab-pill');
  const mPanels = document.querySelectorAll('.module-panel');

  function switchTab(btn) {
    mTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    mPanels.forEach(p => { p.classList.remove('active', 'panel-in'); p.style.display = 'none'; });
    const target = document.getElementById(`panel-${btn.dataset.panel}`);
    if (target) {
      target.style.display = '';
      void target.offsetWidth;
      target.classList.add('active', 'panel-in');
    }
  }

  // Init: show first panel, hide rest
  const firstPanel = document.getElementById('panel-sales');
  if (firstPanel) { firstPanel.style.display = ''; firstPanel.classList.add('active', 'panel-in'); }
  mPanels.forEach(p => { if (p.id !== 'panel-sales') p.style.display = 'none'; });

  mTabs.forEach(btn => btn.addEventListener('click', () => switchTab(btn)));

  // Keyboard navigation for tabs
  const tabList = document.querySelector('.module-tabs[role="tablist"]');
  tabList?.addEventListener('keydown', e => {
    const tabs = [...tabList.querySelectorAll('[role="tab"]')];
    const idx  = tabs.indexOf(document.activeElement);
    if (idx === -1) return;
    const map = { ArrowRight: 1, ArrowLeft: -1, Home: -idx, End: tabs.length - 1 - idx };
    const delta = map[e.key];
    if (delta !== undefined) {
      e.preventDefault();
      const next = tabs[(idx + delta + tabs.length) % tabs.length];
      next.focus();
      switchTab(next);
    }
  });


  /* ══════════════════════════════════════════════════
     8. RIPPLE on buttons
  ══════════════════════════════════════════════════ */
  document.querySelectorAll('.btn-primary, .btn').forEach(btn => {
    btn.classList.add('ripple-host');
    btn.addEventListener('click', e => {
      const rect = btn.getBoundingClientRect();
      const wave = document.createElement('span');
      wave.className = 'ripple-wave';
      wave.style.left = `${e.clientX - rect.left}px`;
      wave.style.top  = `${e.clientY - rect.top}px`;
      btn.appendChild(wave);
      setTimeout(() => wave.remove(), 600);
    });
  });


  /* ══════════════════════════════════════════════════
     9. SCROLL-TO-TOP BUTTON
  ══════════════════════════════════════════════════ */
  const scrollTopBtn = document.createElement('button');
  scrollTopBtn.id = 'scrollTop';
  scrollTopBtn.setAttribute('aria-label', 'Back to top');
  scrollTopBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  document.body.appendChild(scrollTopBtn);
  scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () =>
    scrollTopBtn.classList.toggle('visible', window.scrollY > 500),
    { passive: true }
  );


  /* ══════════════════════════════════════════════════
     10. DARK MODE TOGGLE
  ══════════════════════════════════════════════════ */
  const navActions = document.querySelector('.nav-actions');

  const darkToggle = document.createElement('button');
  darkToggle.id = 'darkToggle';
  darkToggle.setAttribute('aria-label', 'Toggle dark mode');

  const sunIcon  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
  const moonIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>`;

  const stored     = localStorage.getItem('cedaris-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  let isDark = stored === 'dark' || (!stored && prefersDark);

  function applyTheme(dark) {
    isDark = dark;
    document.body.classList.toggle('dark', dark);
    darkToggle.innerHTML = dark
      ? sunIcon  + '<span>Light</span>'
      : moonIcon + '<span>Dark</span>';
    localStorage.setItem('cedaris-theme', dark ? 'dark' : 'light');
  }

  applyTheme(isDark);
  darkToggle.addEventListener('click', () => applyTheme(!isDark));
  if (navActions) navActions.insertBefore(darkToggle, navActions.firstChild);


  /* ══════════════════════════════════════════════════
     11. TYPING EFFECT — hero gradient text cycles
  ══════════════════════════════════════════════════ */
  const gradSpan = document.querySelector('.hero-copy h1 .grad-text');
  if (gradSpan) {
    const phrases = [
      'Every department.',
      'All your data.',
      'One source of truth.',
      'Your whole business.'
    ];
    let pIdx = 0, cIdx = 0, deleting = false;

    const cursor = document.createElement('span');
    cursor.className = 'typed-cursor';
    gradSpan.insertAdjacentElement('afterend', cursor);

    function tick() {
      const phrase = phrases[pIdx];
      if (!deleting) {
        cIdx++;
        gradSpan.textContent = phrase.slice(0, cIdx);
        if (cIdx === phrase.length) {
          setTimeout(() => { deleting = true; tick(); }, 2400);
          return;
        }
      } else {
        cIdx--;
        gradSpan.textContent = phrase.slice(0, cIdx);
        if (cIdx === 0) {
          deleting = false;
          pIdx = (pIdx + 1) % phrases.length;
          setTimeout(tick, 380);
          return;
        }
      }
      setTimeout(tick, deleting ? 36 : 56);
    }
    setTimeout(tick, 1000);
  }


  /* ══════════════════════════════════════════════════
     12. HERO PARALLAX — orbs drift on scroll
  ══════════════════════════════════════════════════ */
  const orb1 = document.querySelector('.hb-orb-1');
  const orb2 = document.querySelector('.hb-orb-2');
  const grid  = document.querySelector('.hb-grid');

  if (orb1 && orb2) {
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (y < 900) {
        orb1.style.transform = `translateY(${y * 0.13}px)`;
        orb2.style.transform = `translateY(${y * 0.07}px)`;
        if (grid) grid.style.transform = `translateY(${y * 0.04}px)`;
      }
    }, { passive: true });
  }


  /* ══════════════════════════════════════════════════
     13. FAQ — only one open at a time
  ══════════════════════════════════════════════════ */
  const faqDetails = document.querySelectorAll('.faq details');
  faqDetails.forEach(det =>
    det.addEventListener('toggle', () => {
      if (det.open) faqDetails.forEach(other => { if (other !== det) other.open = false; });
    })
  );


  /* ══════════════════════════════════════════════════
     14. SMOOTH SCROLL for anchor links
  ══════════════════════════════════════════════════ */
  document.querySelectorAll('a[href^="#"]').forEach(a =>
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    })
  );


  /* ══════════════════════════════════════════════════
     15. DEMO FORM — validate + animated feedback
  ══════════════════════════════════════════════════ */
  const form      = document.getElementById('demoForm');
  const submitBtn = document.getElementById('demoSubmit');
  const formNote  = document.getElementById('formNote');

  if (form) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      let valid = true;

      form.querySelectorAll('[required]').forEach(field => {
        field.classList.remove('invalid');
        const empty    = !field.value.trim();
        const badEmail = field.type === 'email' && !/\S+@\S+\.\S+/.test(field.value);
        if (empty || badEmail) { field.classList.add('invalid'); valid = false; }
      });

      if (!valid) {
        if (formNote) { formNote.textContent = 'Please fill in all required fields correctly.'; formNote.className = 'form-note err'; }
        form.style.animation = 'none';
        void form.offsetWidth;
        form.style.animation = 'formShake 0.35s ease';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      await new Promise(r => setTimeout(r, 1400));

      form.reset();
      submitBtn.disabled    = false;
      submitBtn.textContent = 'Request my demo';
      if (formNote) {
        formNote.textContent = "✓ Request received. We'll be in touch within one business day.";
        formNote.className   = 'form-note ok';
      }
      form.style.animation = 'successPop 0.4s ease';
    });

    form.querySelectorAll('input, textarea').forEach(f =>
      f.addEventListener('input', () => f.classList.remove('invalid'))
    );
  }


  /* ══════════════════════════════════════════════════
     16. TOOLTIPS — contextual on stats & CTAs
  ══════════════════════════════════════════════════ */
  const statTips = [
    'Finance, Sales, CRM, POS, Inventory, Purchasing, Manufacturing, Projects, HR, Cash, Fixed Assets, Reports',
    'Set your own rate with full history — quote, invoice and report in two currencies simultaneously.',
    'Every screen, document and report — with proper RTL layout. Switch in one click.',
    'Runs on your PC, office server or private cloud. You own the database forever.'
  ];
  document.querySelectorAll('.stat-item').forEach((el, i) => {
    if (statTips[i]) el.setAttribute('data-tip', statTips[i]);
  });
  document.querySelector('.hero-cta .btn-primary')?.setAttribute('data-tip', 'Free · No obligation');
  document.querySelector('.hero-cta .btn-outline')?.setAttribute('data-tip', '13 integrated modules');
  document.querySelectorAll('.gal-item').forEach(el => el.setAttribute('data-tip', 'Actual Cedaris screen'));


  /* ══════════════════════════════════════════════════
     17. INDUSTRIES MARQUEE — pause on hover
  ══════════════════════════════════════════════════ */
  const strip = document.querySelector('.industries-strip');
  const track = document.querySelector('.industries-track');
  if (strip && track) {
    strip.addEventListener('mouseenter', () => track.style.animationPlayState = 'paused');
    strip.addEventListener('mouseleave', () => track.style.animationPlayState = '');
  }


  /* ══════════════════════════════════════════════════
     18. YEAR IN FOOTER
  ══════════════════════════════════════════════════ */
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();


  /* ══════════════════════════════════════════════════
     19. REDUCED MOTION — fast-skip all animations
  ══════════════════════════════════════════════════ */
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.querySelectorAll('.reveal').forEach(el => {
      el.classList.add('in');
      revealObserver.unobserve(el);
    });
  }

  console.log('%cCedaris v3 ✓  Neon Blue + White', 'color:#00A8E8;font-weight:700;font-size:13px;');

}); // end ready()