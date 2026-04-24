// Minimal SPA: login, dashboard, knowledge-base upload + search.
// Sprints 2-5 extend this with leads / campaigns / pipeline / analytics.

const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};

const state = { token: localStorage.getItem('token') || '', user: null, route: location.hash || '#/dashboard' };

function describeHttpFailure(res, data) {
  if (data && typeof data === 'object' && data.error) return data.error;
  if (typeof data === 'string' && data.trim()) {
    const snippet = data.trim().replace(/\s+/g, ' ').slice(0, 200);
    return `HTTP ${res.status}: ${snippet}`;
  }
  if (res.statusText) return `HTTP ${res.status}: ${res.statusText}`;
  if (res.status === 401) return 'HTTP 401: your session has expired. Please log out and log in again.';
  if (res.status === 403) return 'HTTP 403: you are not allowed to do this (superadmin only).';
  if (res.status === 429) return 'HTTP 429: too many requests — slow down.';
  return `HTTP ${res.status} (no response body)`;
}

function throwApiError(res, data) {
  const err = new Error(describeHttpFailure(res, data));
  if (data && typeof data === 'object') {
    if (data.code) err.code = data.code;
    if (data.billingUrl) err.billingUrl = data.billingUrl;
  }
  err.status = res.status;
  throw err;
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throwApiError(res, data);
  return data;
}

async function apiUpload(path, formData) {
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: state.token ? { Authorization: 'Bearer ' + state.token } : {},
    body: formData,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throwApiError(res, data);
  return data;
}

function render() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  if (!state.token) return root.append(LoginView());
  root.append(Shell());
}

function LoginView() {
  const wrap = el('div', { class: 'login-wrap' });
  const card = el('div', { class: 'login-card' });
  const err = el('div', { class: 'err' });
  const u = el('input', { type: 'text', placeholder: 'Username or email', autofocus: '' });
  const p = el('input', { type: 'password', placeholder: 'Password' });
  const btn = el('button', {
    onclick: async () => {
      err.textContent = '';
      try {
        const { token, user } = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: u.value, password: p.value }) });
        state.token = token; state.user = user;
        localStorage.setItem('token', token);
        render();
      } catch (e) { err.textContent = e.message; }
    },
  }, 'Sign in');
  p.addEventListener('keydown', ev => { if (ev.key === 'Enter') btn.click(); });
  card.append(
    el('h1', {}, 'Nuren Sales Agent'),
    el('p', {}, 'Inside-sales workspace — media + community + KOL ecosystem.'),
    u, p, err, btn,
  );
  wrap.append(card);
  return wrap;
}

function Shell() {
  const shell = el('div', { class: 'shell' });
  const side = el('aside', { class: 'sidebar' });
  side.append(el('div', { class: 'brand' }, 'Nuren ', el('span', {}, 'Media')));
  const navLinks = [
    ['#/dashboard', 'Dashboard'],
    ['#/knowledge', 'Knowledge Base'],
    ['#/leads', 'Leads'],
    ['#/drafts', 'Drafts'],
    ['#/campaigns', 'Campaigns'],
    ['#/pipeline', 'Pipeline'],
    ['#/appointments', 'Appointments'],
    ['#/analytics', 'Analytics'],
    ['#/settings', 'Settings'],
  ];
  const nav = el('nav');
  for (const [href, label] of navLinks) {
    const a = el('a', { href, class: state.route === href ? 'active' : '' }, label);
    nav.append(a);
  }
  side.append(nav, el('div', { class: 'user' }, `${state.user?.displayName || state.user?.username || ''} — `, el('a', { href: '#', onclick: (e) => { e.preventDefault(); logout(); } }, 'Sign out')));
  shell.append(side);

  // Campaign detail view uses a wider layout because it stacks a gen card +
  // enroll table + enrollment list side-by-side at full page width.
  const isWide = state.route.startsWith('#/campaign/');
  const main = el('main', { class: 'main' + (isWide ? ' wide' : '') });
  shell.append(main);

  const view = routeView();
  main.append(view);

  // Ensure the floating assistant widget is mounted once (outside #root so
  // route changes don't wipe its history). Idempotent — no-op if already there.
  ensureAssistantWidget();

  return shell;
}

// ====================== ASSISTANT (floating chatbot) ======================
const assistantState = {
  open: false,
  messages: [], // { role: 'user' | 'bot' | 'error', text, citations? }
  pending: false,
  panel: null,
  fab: null,
};

function ensureAssistantWidget() {
  if (!state.token) return; // no widget on login screen
  if (document.getElementById('assistant-fab')) return;

  const fab = el('button', {
    id: 'assistant-fab',
    class: 'assistant-fab',
    title: 'Ask the Nuren assistant',
    'aria-label': 'Open assistant',
    onclick: toggleAssistant,
  });
  // Speech-bubble icon
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  document.body.appendChild(fab);
  assistantState.fab = fab;
}

function toggleAssistant() {
  if (assistantState.open) closeAssistant();
  else openAssistant();
}

function openAssistant() {
  if (assistantState.panel) return;
  assistantState.open = true;

  const panel = el('div', { class: 'assistant-panel', id: 'assistant-panel', role: 'dialog', 'aria-label': 'Nuren assistant' });

  const head = el('div', { class: 'assistant-head' });
  head.append(
    el('div', {},
      el('h4', {}, 'Nuren assistant'),
      el('div', { class: 'sub-line' }, 'Answers from the KB + app docs. Pennies per question.'),
    ),
    el('button', { class: 'assistant-close', 'aria-label': 'Close', onclick: closeAssistant }, '×'),
  );
  const body = el('div', { class: 'assistant-body', id: 'assistant-body' });
  const foot = el('div', { class: 'assistant-foot' });
  const ta = el('textarea', {
    placeholder: 'Ask about rates, features, or how to do something…',
    rows: 1,
    'aria-label': 'Your question',
    onkeydown: (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendBtn.click(); }
    },
    oninput: (ev) => {
      ev.target.style.height = 'auto';
      ev.target.style.height = Math.min(ev.target.scrollHeight, 120) + 'px';
    },
  });
  const sendBtn = el('button', { class: 'send-btn', onclick: async () => {
    const q = ta.value.trim();
    if (!q || assistantState.pending) return;
    ta.value = ''; ta.style.height = 'auto';
    await sendAssistantMessage(q);
  } }, 'Send');
  foot.append(ta, sendBtn);

  panel.append(head, body, foot);
  document.body.appendChild(panel);
  assistantState.panel = panel;

  renderAssistantBody();
  setTimeout(() => ta.focus(), 50);
}

function closeAssistant() {
  assistantState.open = false;
  if (assistantState.panel) {
    assistantState.panel.remove();
    assistantState.panel = null;
  }
}

function renderAssistantBody() {
  const body = document.getElementById('assistant-body');
  if (!body) return;
  body.innerHTML = '';

  if (!assistantState.messages.length) {
    const welcome = el('div', { class: 'assistant-welcome' });
    welcome.append(
      el('div', {}, 'Ask me anything grounded in Nuren\'s knowledge base or this app\'s features. I keep answers short and cite sources where I can.'),
      el('div', { class: 'quick-prompts' },
        el('button', { onclick: () => askQuick('What\'s the Motherhood Short Drama sponsorship package?') }, 'What\'s the Motherhood Short Drama sponsorship package?'),
        el('button', { onclick: () => askQuick('Walk me through setting up my first campaign') }, 'Walk me through setting up my first campaign'),
        el('button', { onclick: () => askQuick('What does Apollo Generate do and how much does it cost?') }, 'What does Apollo Generate do and how much does it cost?'),
      ),
    );
    body.append(welcome);
    return;
  }

  for (const m of assistantState.messages) {
    const cls = m.role === 'user' ? 'assistant-msg user'
             : m.role === 'error' ? 'assistant-msg bot error'
             : 'assistant-msg bot';
    const node = el('div', { class: cls });
    node.textContent = m.text;
    if (m.citations && m.citations.length) {
      const cites = el('div', { class: 'citations' });
      for (const c of m.citations) {
        const label = `${(c.title || c.filename || 'deck').replace(/\.pptx$/i, '')} · slide ${c.slide_number}`;
        cites.append(el('span', { class: 'cite-chip', title: c.filename }, label));
      }
      node.append(cites);
    }
    body.append(node);
  }

  if (assistantState.pending) {
    const t = el('div', { class: 'assistant-typing' });
    t.append(el('span', {}), el('span', {}), el('span', {}));
    body.append(t);
  }
  body.scrollTop = body.scrollHeight;
}

function askQuick(q) {
  sendAssistantMessage(q);
}

async function sendAssistantMessage(question) {
  assistantState.messages.push({ role: 'user', text: question });
  assistantState.pending = true;
  renderAssistantBody();
  try {
    const r = await api('/assistant/chat', { method: 'POST', body: JSON.stringify({ question }) });
    assistantState.pending = false;
    assistantState.messages.push({ role: 'bot', text: r.answer || '(empty response)', citations: r.citations || [] });
  } catch (e) {
    assistantState.pending = false;
    const msg = /credit balance/i.test(e.message)
      ? 'Anthropic credits are depleted — the assistant can\'t answer until an admin tops up. No charge was made for this question.'
      : e.message;
    assistantState.messages.push({ role: 'error', text: msg });
  }
  renderAssistantBody();
}

function routeView() {
  const r = state.route;
  if (r.startsWith('#/lead/')) return LeadDetailView(r.slice(7));
  if (r.startsWith('#/campaign/')) return CampaignDetailView(r.slice(11));
  switch (r) {
    case '#/knowledge': return KnowledgeView();
    case '#/settings': return SettingsView();
    case '#/leads': return LeadsView();
    case '#/drafts': return DraftsView();
    case '#/campaigns': return CampaignsView();
    case '#/pipeline': return PipelineView();
    case '#/appointments': return AppointmentsView();
    case '#/analytics': return AnalyticsView();
    default: return DashboardView();
  }
}

function DashboardView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Dashboard'));
  wrap.append(el('p', { class: 'sub' }, 'Today at a glance. Nuren inside-sales funnel, AI cost, and things that need your attention.'));

  const attention = el('div', { class: 'grid', style: 'margin-bottom:18px' });
  wrap.append(attention);
  const funnel = el('div', { class: 'card', style: 'margin-bottom:18px; padding:22px' });
  wrap.append(funnel);
  const grid = el('div', { class: 'grid' });
  wrap.append(grid);

  const mkCard = (title, big, hint) => {
    const c = el('div', { class: 'card' });
    c.append(el('h3', {}, title), el('div', { class: 'big' }, big || '—'), hint ? el('div', { class: 'hint' }, hint) : null);
    return c;
  };

  api('/analytics/dashboard').then(d => {
    attention.innerHTML = '';
    attention.append(
      mkCardLinked('Hot leads', String(d.hot_leads), 'open, not yet closed', '#/leads'),
      mkCardLinked('Drafts pending', String(d.drafts_pending), 'click to review', '#/drafts'),
      mkCardLinked('Needs human review', String(d.needs_review), 'low-confidence drafts', '#/drafts'),
      mkCardLinked('Upcoming meetings', String(d.upcoming_meetings), 'next 30 days', '#/appointments'),
      mkCardLinked('Active campaigns', String(d.active_campaigns), '', '#/campaigns'),
    );

    // Funnel strip
    const f = d.funnel;
    funnel.innerHTML = '';
    funnel.append(el('h3', {}, 'Funnel'));
    const strip = el('div', { style: 'display:grid; grid-template-columns:repeat(8,1fr); gap:8px; margin-top:10px' });
    const steps = [
      ['Leads', f.leads_total, ''],
      ['Contacted', f.contacted, f.rates.contact_rate + '%'],
      ['Opened', f.opened, f.rates.open_rate + '%'],
      ['Clicked', f.clicked, f.rates.click_rate + '%'],
      ['Replied', f.replied, f.rates.reply_rate + '%'],
      ['Positive', f.positive_replies, f.rates.positive_reply_rate + '%'],
      ['Meetings', f.meetings_booked, f.rates.meeting_booked_rate + '%'],
      ['Won (MYR)', 'RM ' + (f.revenue_myr || 0).toLocaleString(), f.rates.meeting_to_won + '%'],
    ];
    for (const [label, value, rate] of steps) {
      strip.append(el('div', { style: 'background:#fff7ef; border:1px solid #e7dfd1; border-radius:10px; padding:10px; text-align:center' },
        el('div', { style: 'font-size:11px; color:#7b708f; text-transform:uppercase; letter-spacing:0.04em' }, label),
        el('div', { style: 'font-size:18px; font-weight:700; color:#1b1147; margin:4px 0' }, value),
        el('div', { style: 'font-size:11px; color:#40309c' }, rate),
      ));
    }
    funnel.append(strip);

    // KB + AI cost
    grid.innerHTML = '';
    grid.append(
      mkCard('KB assets', String(d.kb.assets), d.kb.slides + ' slides · ' + d.kb.chunks + ' chunks'),
      mkCard('AI cost this month', '$' + (d.ai_cost?.this_month?.cost || 0).toFixed(2), (d.ai_cost?.this_month?.calls || 0) + ' calls'),
      mkCard('AI cost total', '$' + (d.ai_cost?.total?.cost || 0).toFixed(2), (d.ai_cost?.total?.calls || 0) + ' lifetime'),
    );
  }).catch(err => {
    attention.innerHTML = '<div class="card"><h3>Failed to load</h3><p class="hint">' + err.message + '</p></div>';
  });

  return wrap;
}

function mkCardLinked(title, big, hint, href) {
  const c = el('a', { href, class: 'card', style: 'display:block; text-decoration:none; color:inherit' });
  c.append(el('h3', {}, title), el('div', { class: 'big' }, big || '—'), hint ? el('div', { class: 'hint' }, hint) : null);
  return c;
}

function LeadsView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Leads'));
  wrap.append(el('p', { class: 'sub' }, 'CSV upload with verification gate. Every lead must have ≥1 verification source + LinkedIn or company website. Unverified rows are rejected.'));

  // Upload card
  const up = el('div', { class: 'uploader' });
  const file = el('input', { type: 'file', accept: '.csv' });
  const enrichCheck = el('input', { type: 'checkbox', id: 'enrich' });
  const enrichLabel = el('label', { for: 'enrich', style: 'display:inline; margin-left:8px' }, 'AI-enrich each row (web search — uses Anthropic credits)');
  const uploadBtn = el('button', { class: 'btn primary', onclick: async () => {
    if (!file.files[0]) return alert('Pick a CSV.');
    uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading…';
    try {
      const fd = new FormData();
      fd.append('file', file.files[0]);
      const r = await apiUpload('/leads/upload' + (enrichCheck.checked ? '?enrich=1' : ''), fd);
      alert(`Queued ${r.queued} rows${r.enrich ? ' (AI enrichment)' : ''}. Refresh in a moment.`);
      load();
    } catch (e) { alert('Upload failed: ' + e.message); }
    uploadBtn.disabled = false; uploadBtn.textContent = 'Upload CSV';
  } }, 'Upload CSV');
  up.append(
    el('div', { class: 'sub', style: 'margin-bottom:10px' }, 'Expected columns: name, company, email, phone, title, linkedin_url, company_website, verification_sources (URLs comma-separated), reason_for_fit, buying_signal. Missing columns are OK if you enable enrichment.'),
    file, uploadBtn, enrichCheck, enrichLabel,
  );
  wrap.append(up);

  // Filters
  const filters = el('div', { class: 'row', style: 'margin-bottom:16px' });
  const statusSel = el('select');
  ['', 'new', 'contacted', 'engaged', 'qualified', 'unsubscribed', 'bounced'].forEach(s => statusSel.append(el('option', { value: s }, s || 'Any status')));
  const heatSel = el('select');
  ['', 'hot', 'cold'].forEach(s => heatSel.append(el('option', { value: s }, s || 'Any heat')));
  const search = el('input', { type: 'text', placeholder: 'Search name / email / company' });
  const refreshBtn = el('button', { class: 'btn', onclick: () => load() }, 'Refresh');
  const rejectsBtn = el('button', { class: 'btn ghost', onclick: () => showRejected() }, 'View rejected');
  filters.append(statusSel, heatSel, search, refreshBtn, rejectsBtn);
  wrap.append(filters);

  const listWrap = el('div');
  wrap.append(listWrap);

  async function load() {
    listWrap.innerHTML = 'Loading…';
    try {
      const params = new URLSearchParams();
      if (statusSel.value) params.set('status', statusSel.value);
      if (heatSel.value) params.set('lead_type', heatSel.value);
      if (search.value) params.set('search', search.value);
      const leads = await api('/leads?' + params.toString());
      listWrap.innerHTML = '';
      if (!leads.length) return listWrap.append(el('p', { class: 'sub' }, 'No leads yet. Upload a CSV above.'));
      const tbl = el('table');
      tbl.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Name'), el('th', {}, 'Company'), el('th', {}, 'Persona'),
        el('th', {}, 'Heat'), el('th', {}, 'Confidence'), el('th', {}, 'Score'),
        el('th', {}, 'Email'), el('th', {}, 'Status'), el('th', {}, ''),
      )));
      const tbody = el('tbody');
      for (const l of leads) {
        tbody.append(el('tr', {},
          el('td', {}, el('a', { href: '#/lead/' + l.id }, l.name)),
          el('td', {}, l.account_name || '—'),
          el('td', {}, (l.persona || '').replace(/_/g, ' ')),
          el('td', {}, el('span', { class: 'badge ' + (l.lead_type === 'hot' ? 'warn' : '') }, l.lead_type || '')),
          el('td', {}, l.confidence_score || ''),
          el('td', {}, String(l.score)),
          el('td', {}, l.email || '—'),
          el('td', {}, el('span', { class: 'badge' }, l.status)),
          el('td', {}, el('a', { href: '#/lead/' + l.id, class: 'btn' }, 'Open')),
        ));
      }
      tbl.append(tbody);
      listWrap.append(tbl);
    } catch (e) { listWrap.innerHTML = 'Load failed: ' + e.message; }
  }

  async function showRejected() {
    listWrap.innerHTML = 'Loading rejects…';
    try {
      const rows = await api('/leads/rejected');
      listWrap.innerHTML = '';
      if (!rows.length) return listWrap.append(el('p', { class: 'sub' }, 'No rejects — the verification gate approved everything.'));
      const tbl = el('table');
      tbl.append(el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Source'), el('th', {}, 'Reasons'), el('th', {}, 'Raw input'),
      )));
      const tbody = el('tbody');
      for (const r of rows) {
        tbody.append(el('tr', {},
          el('td', {}, new Date(r.created_at + 'Z').toLocaleString()),
          el('td', {}, r.source || ''),
          el('td', {}, (r.reasons || []).join(', ')),
          el('td', {}, el('code', { style: 'font-size:11.5px' }, JSON.stringify(r.raw_input).slice(0, 200))),
        ));
      }
      tbl.append(tbody);
      listWrap.append(tbl);
    } catch (e) { listWrap.innerHTML = 'Load failed: ' + e.message; }
  }

  [statusSel, heatSel].forEach(e => e.addEventListener('change', load));
  search.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
  load();

  return wrap;
}

function LeadDetailView(leadId) {
  const wrap = el('div');
  const backLink = el('a', { href: '#/leads', style: 'font-size:13px; color:#40309c' }, '← All leads');
  wrap.append(backLink);

  const head = el('div');
  wrap.append(head);
  const main = el('div', { class: 'grid', style: 'grid-template-columns: 1.2fr 1fr; gap:18px; margin-top:14px; align-items:start' });
  wrap.append(main);

  const leftCol = el('div');
  const rightCol = el('div');
  main.append(leftCol, rightCol);

  loadLead();

  async function loadLead() {
    try {
      const l = await api('/leads/' + leadId);
      head.innerHTML = '';
      head.append(
        el('h1', { style: 'margin-top:8px' }, l.name),
        el('p', { class: 'sub' }, `${l.title || '(no title)'} · ${l.account_name || '(no company)'} · ${l.geography || ''}`),
      );

      // Left: details + verification + actions
      leftCol.innerHTML = '';
      const card = el('div', { class: 'card' });
      const row = (k, v) => el('div', { style: 'display:grid; grid-template-columns:150px 1fr; gap:12px; font-size:13.5px; padding:6px 0; border-bottom:1px dashed var(--line)' },
        el('div', { style: 'color:#7b708f' }, k),
        el('div', {}, v ? (typeof v === 'string' ? v : JSON.stringify(v)) : '—'));
      card.append(
        el('h3', {}, 'Identity'),
        row('Persona', (l.persona || '').replace(/_/g, ' ')),
        row('Type', l.type),
        row('Email', l.email),
        row('Phone', l.phone),
        row('LinkedIn', l.linkedin_url ? el('a', { href: l.linkedin_url, target: '_blank' }, l.linkedin_url) : ''),
        row('Website', l.company_website ? el('a', { href: l.company_website, target: '_blank' }, l.company_website) : ''),
        row('Lead type', el('span', { class: 'badge ' + (l.lead_type === 'hot' ? 'warn' : '') }, l.lead_type)),
        row('Confidence', l.confidence_score),
        row('Score', String(l.score)),
        row('Status', el('span', { class: 'badge' }, l.status)),
      );
      const fitCard = el('div', { class: 'card', style: 'margin-top:14px' });
      fitCard.append(
        el('h3', {}, 'Verification + Fit'),
        row('Reason for fit', l.reason_for_fit),
        row('Buying signal', l.buying_signal),
        row('Verification sources',
          (l.verification_sources || []).length
            ? el('div', {}, ...l.verification_sources.map(u => el('div', {}, el('a', { href: u, target: '_blank' }, u))))
            : '—'),
      );
      const actions = el('div', { style: 'display:flex; gap:10px; margin-top:14px' });
      const enrichBtn = el('button', { class: 'btn', onclick: async () => {
        enrichBtn.disabled = true; enrichBtn.textContent = 'Enriching (web search)…';
        try {
          const r = await api('/leads/' + leadId + '/enrich', { method: 'POST' });
          if (!r.ok) return alert('Enrichment failed gate: ' + (r.reasons || []).join(', '));
          alert('Re-enriched. ' + (r.webSearchUses || 0) + ' web searches used.');
          loadLead();
        } catch (e) { alert('Failed: ' + e.message); }
        enrichBtn.disabled = false; enrichBtn.textContent = 'Re-enrich';
      } }, 'Re-enrich');
      const draftBtn = el('button', { class: 'btn primary', onclick: () => draftFor(1) }, 'Draft Day 1 email');
      actions.append(enrichBtn, draftBtn);
      leftCol.append(card, fitCard, actions);

      // Right: drafts + messages thread
      rightCol.innerHTML = '';
      rightCol.append(el('h3', { style: 'margin-top:0' }, 'Drafts + Messages'));
      const thread = el('div', { id: 'thread' });
      rightCol.append(thread);
      await loadThread();
    } catch (e) { head.innerHTML = 'Load failed: ' + e.message; }
  }

  async function loadThread() {
    const thread = document.getElementById('thread');
    thread.innerHTML = 'Loading thread…';
    try {
      const rows = await api('/messages?lead_id=' + leadId);
      thread.innerHTML = '';
      if (!rows.length) return thread.append(el('p', { class: 'sub' }, 'No drafts or messages yet. Click "Draft Day 1 email".'));
      for (const m of rows) {
        const c = el('div', { class: 'card', style: 'margin-bottom:10px' });
        c.append(el('div', { style: 'display:flex; gap:10px; align-items:center; margin-bottom:6px' },
          el('span', { class: 'badge ' + (m.status === 'drafted' ? 'warn' : (m.status === 'sent' ? 'ok' : 'busy')) }, m.status),
          el('span', { class: 'sub', style: 'margin:0' }, `${m.direction} · ${m.channel} · step ${m.step_number}/${m.variant_key}`),
        ));
        if (m.subject) c.append(el('div', { style: 'font-weight:600; font-size:14px; margin-bottom:6px' }, m.subject));
        c.append(el('pre', { style: 'white-space:pre-wrap; font-family:inherit; font-size:13px; margin:0; color:#3b3064' }, m.body));
        if (m.status === 'drafted') {
          const sendBtn = el('button', { class: 'btn primary', style: 'margin-top:10px', onclick: async () => {
            if (!confirm('Send this email via Resend?')) return;
            sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
            try { await api('/messages/' + m.id + '/send', { method: 'POST' }); loadThread(); }
            catch (e) { alert('Send failed: ' + e.message); sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
          } }, 'Send');
          c.append(sendBtn);
        }
        thread.append(c);
      }
    } catch (e) { thread.innerHTML = 'Thread failed: ' + e.message; }
  }

  async function draftFor(step) {
    try {
      const r = await api('/drafts', { method: 'POST', body: JSON.stringify({ lead_id: parseInt(leadId, 10), step_number: step, channel: 'email' }) });
      if (r.needs_review) alert(`Draft generated but flagged for review (confidence=${r.confidence}, citations=${r.citations.length})`);
      await loadThread();
    } catch (e) { alert('Draft failed: ' + e.message); }
  }

  return wrap;
}

function DraftsView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Drafts — awaiting send'));
  wrap.append(el('p', { class: 'sub' }, 'AI-generated messages staged but not yet sent. Review and send individually, or in bulk.'));
  const list = el('div');
  wrap.append(list);
  (async () => {
    try {
      const rows = await api('/drafts');
      if (!rows.length) return list.append(el('p', { class: 'sub' }, 'No drafts queued.'));
      for (const d of rows) {
        const c = el('div', { class: 'card', style: 'margin-bottom:10px' });
        c.append(
          el('h3', {}, `${d.lead_name} — ${d.lead_email || '(no email)'}`),
          el('div', { class: 'sub', style: 'margin:0 0 6px' }, `Step ${d.step_number}/${d.variant_key} · ${d.channel}${d.classification === 'needs_review' ? ' · NEEDS REVIEW' : ''}`),
          d.subject ? el('div', { style: 'font-weight:600; margin-bottom:6px' }, d.subject) : null,
          el('pre', { style: 'white-space:pre-wrap; font-family:inherit; font-size:13px; margin:0 0 10px; color:#3b3064' }, d.body),
          el('div', {},
            el('a', { class: 'btn', href: '#/lead/' + d.lead_id }, 'Open lead'),
            el('button', { class: 'btn primary', style: 'margin-left:8px', onclick: async () => {
              if (!confirm('Send via Resend?')) return;
              try { await api('/messages/' + d.id + '/send', { method: 'POST' }); location.reload(); }
              catch (e) { alert('Send failed: ' + e.message); }
            } }, 'Send'),
          ),
        );
        list.append(c);
      }
    } catch (e) { list.innerHTML = 'Load failed: ' + e.message; }
  })();
  return wrap;
}

// ====================== CAMPAIGNS ======================
/**
 * Ask how many leads, POST to generate-leads, alert the summary, then reload.
 * Shared by the row button in CampaignsView and any other place that needs it.
 */
/**
 * Apollo-backed lead gen (only source now that AI Generate has been retired).
 * Uses structured filters (title + seniority + geography + company size) +
 * server-side hot-lead vetting. 1 Apollo credit per enriched lead.
 */
async function runApolloGenerate(campaignId, campaignName, onDone) {
  const countStr = prompt(`How many Apollo-verified leads for "${campaignName}"? (1–15)`, '5');
  if (!countStr) return;
  const count = Math.min(Math.max(parseInt(countStr, 10) || 5, 1), 15);
  const busy = el('div', {
    style: 'position:fixed; top:20px; right:20px; background:#2a1f5c; color:white; padding:12px 18px; border-radius:10px; font-size:13.5px; z-index:9999; box-shadow:0 8px 24px rgba(0,0,0,.15); max-width:320px; line-height:1.4'
  }, `Apollo: searching ${count} candidates → dedup → enrich → hot-vet… ~3–8 seconds.`);
  document.body.appendChild(busy);
  try {
    const r = await api('/campaigns/' + campaignId + '/apollo-generate', { method: 'POST', body: JSON.stringify({ count }) });
    if (r.generated === 0 && r.message) {
      alert(r.message);
      if (onDone) onDone();
      return;
    }
    if (r.generated === 0) {
      const parts = [];
      if (r.rejected_cold) parts.push(`${r.rejected_cold} vetted cold`);
      if (r.rejected_icp) parts.push(`${r.rejected_icp} wrong-vertical`);
      const whyNot = parts.length ? `Breakdown: ${parts.join(', ')}.` : `All ${r.rejected} failed verification.`;
      alert(`0 leads kept.\n${whyNot}\n\nTry broadening the ICP or running again — Apollo rotates results.`);
      if (onDone) onDone();
      return;
    }
    const fitLine = r.weak_fit ? `\nFit: ${r.strong_fit} strong + ${r.weak_fit} weak.` : '';
    const channelLine = r.linkedin_only ? `\nChannel: ${r.email_ready} email-ready + ${r.linkedin_only} LinkedIn-only.` : '';
    const filtered = [];
    if (r.rejected_cold) filtered.push(`${r.rejected_cold} cold`);
    if (r.rejected_icp) filtered.push(`${r.rejected_icp} wrong-vertical`);
    const filteredLine = filtered.length ? `\nFiltered: ${filtered.join(', ')}.` : '';
    const pagesLine = r.search_pages > 1 ? ` over ${r.search_pages} pages` : '';
    alert(`Apollo searched ${r.total_returned}${pagesLine} · enriched ${r.enrichment_calls}\nPersisted ${r.generated} HOT leads · rejected ${r.rejected} total.${fitLine}${channelLine}${filteredLine}\n\nOpen the Leads tab to see them.`);
    if (onDone) onDone();
  } catch (e) {
    showGenerateLeadsError(e);
  } finally {
    busy.remove();
  }
}

/**
 * Present AI-generate errors with an action. Credit-depleted is the common one
 * on a fresh deploy — route the operator straight to the billing console rather
 * than dumping the raw upstream error.
 */
function showGenerateLeadsError(e) {
  if (e.code === 'anthropic_credits_depleted') {
    const url = e.billingUrl || 'https://console.anthropic.com/settings/billing';
    if (confirm('Anthropic credits are depleted — the AI call could not run. No charge was incurred.\n\nOpen the billing console now to top up?')) {
      window.open(url, '_blank', 'noopener');
    }
    return;
  }
  if (e.code === 'anthropic_auth_failed') {
    alert('The Anthropic API key is invalid or was rotated.\n\nAn admin must update ANTHROPIC_API_KEY on Railway and redeploy.');
    return;
  }
  if (e.code === 'anthropic_rate_limited') {
    alert('Anthropic rate limit hit. Wait ~60 seconds and try again, or reduce the lead count per click.');
    return;
  }
  if (e.code === 'anthropic_overloaded') {
    alert('Anthropic is temporarily overloaded. Wait a minute and try again — no charge on this request.');
    return;
  }
  if (e.code === 'apollo_not_configured') {
    if (confirm('Apollo API key is not set.\n\nGo to Settings → apollo_api_key and paste your key from app.apollo.io → Integrations → API.\n\nOpen Apollo API settings now?')) {
      window.open('https://app.apollo.io/#/settings/integrations/api', '_blank', 'noopener');
    }
    return;
  }
  if (e.code === 'apollo_plan_insufficient') {
    const url = e.billingUrl || 'https://app.apollo.io/#/settings/plans';
    if (confirm('Your Apollo plan does not include API access for lead search. The Basic tier and above unlock the People Search + Enrichment APIs.\n\nOpen Apollo plans page to upgrade?')) {
      window.open(url, '_blank', 'noopener');
    }
    return;
  }
  if (e.code === 'apollo_key_stale') {
    const url = e.billingUrl || 'https://app.apollo.io/#/settings/integrations/api';
    if (confirm('Your Apollo key was generated BEFORE your workspace upgraded to a paid plan. Apollo stamps API entitlement onto keys at creation and does not retro-upgrade old keys.\n\nFIX: revoke the current key, create a new one, and paste the new key into Settings → apollo_api_key.\n\nOpen Apollo API keys page now?')) {
      window.open(url, '_blank', 'noopener');
    }
    return;
  }
  if (e.code === 'apollo_credits_depleted') {
    const url = e.billingUrl || 'https://app.apollo.io/#/settings/plans';
    if (confirm('Apollo credits are depleted or monthly quota hit.\n\nTop up or wait for reset?')) {
      window.open(url, '_blank', 'noopener');
    }
    return;
  }
  if (e.code === 'apollo_auth_failed') {
    alert('Apollo API key is invalid. Generate a fresh one at app.apollo.io → Settings → Integrations → API, then paste into Settings.');
    return;
  }
  if (e.code === 'apollo_rate_limited') {
    alert('Apollo rate limit hit. Wait 60 seconds and try again.');
    return;
  }
  alert('Generate failed: ' + e.message);
}

function CampaignsView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Campaigns'));
  wrap.append(el('p', { class: 'sub' }, 'Each campaign enrolls leads into a sequence (Day 1 / 3 / 6 / 10). Activate a campaign to let the scheduler send.'));

  // Create campaign card
  const create = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const cName = el('input', { type: 'text', placeholder: 'Campaign name (e.g. FMCG baby skincare Q2)' });
  const cObj = el('select');
  ['awareness', 'consideration', 'conversion'].forEach(o => cObj.append(el('option', { value: o }, o)));
  const cInd = el('select');
  cInd.append(el('option', { value: '' }, 'Any industry'));
  ['fmcg', 'healthcare', 'education', 'ecommerce'].forEach(i => cInd.append(el('option', { value: i }, i)));
  const cTier = el('select');
  ['any', 'starter', 'mid', 'enterprise'].forEach(t => cTier.append(el('option', { value: t }, t)));
  const cAngle = el('select');
  cAngle.append(el('option', { value: '' }, 'auto angle'));
  ['community_trust', 'kol_network', 'affiliate_commerce', 'full_funnel'].forEach(a => cAngle.append(el('option', { value: a }, a)));
  const cBudget = el('input', { type: 'number', step: '0.01', placeholder: 'AI budget cap USD (0 = unlimited)' });
  const cBtn = el('button', { class: 'btn primary', onclick: async () => {
    if (!cName.value.trim()) return alert('Name required.');
    try {
      await api('/campaigns', { method: 'POST', body: JSON.stringify({
        name: cName.value, objective: cObj.value, target_industry: cInd.value || null,
        target_budget_tier: cTier.value, pitch_angle: cAngle.value || null,
        budget_limit: parseFloat(cBudget.value) || 0,
      }) });
      cName.value = ''; cBudget.value = '';
      load();
    } catch (e) { alert('Create failed: ' + e.message); }
  } }, 'Create campaign');
  create.append(
    el('h3', {}, 'New campaign'),
    cName,
    el('div', { class: 'row' }, cObj, cInd, cTier, cAngle, cBudget),
    cBtn,
  );
  wrap.append(create);

  const list = el('div');
  wrap.append(list);

  async function load() {
    list.innerHTML = 'Loading…';
    try {
      const rows = await api('/campaigns');
      list.innerHTML = '';
      if (!rows.length) return list.append(el('p', { class: 'sub' }, 'No campaigns yet. Create one above.'));
      const tbl = el('table');
      tbl.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Name'), el('th', {}, 'Objective'), el('th', {}, 'Industry'), el('th', {}, 'Status'),
        el('th', {}, 'Enrolled'), el('th', {}, 'Running'), el('th', {}, 'Replied'), el('th', {}, 'Sent'),
        el('th', {}, 'AI $'), el('th', {}, ''),
      )));
      const tbody = el('tbody');
      for (const c of rows) {
        const apolloBtn = el('button', { class: 'btn primary', style: 'margin-right:6px', title: 'Apollo.io — verified emails, hot leads only', onclick: async (ev) => {
          ev.preventDefault();
          await runApolloGenerate(c.id, c.name, load);
        } }, 'Apollo Generate');
        tbody.append(el('tr', {},
          el('td', {}, el('a', { href: '#/campaign/' + c.id }, c.name)),
          el('td', {}, c.objective),
          el('td', {}, c.target_industry || '—'),
          el('td', {}, el('span', { class: 'badge ' + (c.status === 'active' ? 'ok' : 'warn') }, c.status)),
          el('td', {}, String(c.enrolled_count || 0)),
          el('td', {}, String(c.running_count || 0)),
          el('td', {}, String(c.replied_count || 0)),
          el('td', {}, String(c.sent_count || 0)),
          el('td', {}, '$' + (c.ai_cost || 0).toFixed(4)),
          el('td', {}, apolloBtn, el('a', { href: '#/campaign/' + c.id, class: 'btn' }, 'Open')),
        ));
      }
      tbl.append(tbody);
      list.append(tbl);
    } catch (e) { list.innerHTML = 'Load failed: ' + e.message; }
  }
  load();
  return wrap;
}

function CampaignDetailView(id) {
  const wrap = el('div');
  wrap.append(el('a', { href: '#/campaigns', style: 'font-size:13px; color:#40309c' }, '← All campaigns'));
  const head = el('div'); wrap.append(head);
  const genCard = el('div', { class: 'card', style: 'margin-top:14px' }); wrap.append(genCard);
  const enrollCard = el('div', { class: 'card', style: 'margin-top:14px' }); wrap.append(enrollCard);
  const enrollList = el('div', { style: 'margin-top:14px' }); wrap.append(enrollList);

  load();

  async function load() {
    try {
      const c = await api('/campaigns/' + id);
      head.innerHTML = '';
      const headerRow = el('div', { style: 'display:flex; justify-content:space-between; align-items:flex-start; margin-top:12px' });
      const headerLeft = el('div', {});
      headerLeft.append(el('h1', { style: 'margin:0 0 4px' }, c.name),
        el('p', { class: 'sub', style: 'margin:0' }, `${c.objective} · ${c.target_industry || 'any'} · ${c.target_budget_tier} · ${c.pitch_angle || 'auto'}`));
      const statusBtn = el('button', { class: 'btn ' + (c.status === 'active' ? 'danger' : 'primary'), onclick: async () => {
        const next = c.status === 'active' ? 'paused' : 'active';
        await api('/campaigns/' + id, { method: 'PATCH', body: JSON.stringify({ status: next }) });
        load();
      } }, c.status === 'active' ? 'Pause' : 'Activate');
      headerRow.append(headerLeft, statusBtn);
      head.append(headerRow);

      genCard.innerHTML = '';
      const countInput = el('input', { type: 'number', min: '1', max: '15', value: '5', style: 'width:70px' });
      const genStatus = el('span', { class: 'sub', style: 'margin-left:10px; font-size:13px' });
      const apolloBtn = el('button', { class: 'btn primary', onclick: async () => {
        const n = Math.min(Math.max(parseInt(countInput.value, 10) || 5, 1), 15);
        apolloBtn.disabled = true;
        const method = n === 1 ? 'single-enrich' : 'bulk-enrich';
        genStatus.textContent = `Apollo: searching ${n} candidates → ${method} → hot-lead vetting…`;
        try {
          const r = await api('/campaigns/' + id + '/apollo-generate', { method: 'POST', body: JSON.stringify({ count: n }) });

          // Empty result — every candidate was already known to us
          if (r.generated === 0 && r.message) {
            genStatus.innerHTML = `<span style="color:#b86b0a">${r.message}</span>`;
            load();
            return;
          }
          // Empty result — every candidate failed hot-vetting OR ICP post-vet.
          if (r.generated === 0) {
            const reasons = [];
            if (r.rejected_cold > 0) reasons.push(`${r.rejected_cold} vetted cold (junior role or no buying signal)`);
            if (r.rejected_icp > 0) reasons.push(`${r.rejected_icp} wrong-vertical (not Nuren's buyer profile)`);
            const whyNot = reasons.length ? reasons.join(', ') : `${r.rejected} failed verification (duplicate email or missing LinkedIn)`;
            genStatus.innerHTML = `<span style="color:#b86b0a">0 leads kept. Breakdown: ${whyNot}. Try broadening the ICP or running again — Apollo rotates results.</span>`;
            load();
            return;
          }

          const rejectedCold = r.rejected_cold || 0;
          const rejectedIcp = r.rejected_icp || 0;
          const strongFit = r.strong_fit || 0;
          const weakFit = r.weak_fit || 0;
          const emailReady = r.email_ready || 0;
          const linkedinOnly = r.linkedin_only || 0;

          const fitLine = weakFit > 0
            ? ` · <span style="color:#1a6b4f">${strongFit} strong fit</span> + <span style="color:#8c5b0e">${weakFit} weak fit</span>`
            : '';
          const channelLine = linkedinOnly > 0
            ? ` · ${emailReady} email-ready + ${linkedinOnly} LinkedIn-only`
            : '';
          const vettingParts = [];
          if (rejectedCold > 0) vettingParts.push(`${rejectedCold} cold`);
          if (rejectedIcp > 0) vettingParts.push(`${rejectedIcp} wrong-vertical`);
          const vettingLine = vettingParts.length ? ` · <span style="color:#b86b0a">filtered ${vettingParts.join(', ')}</span>` : '';
          const pagesLine = r.search_pages > 1 ? ` over ${r.search_pages} pages` : '';

          genStatus.innerHTML = `<span style="color:#1b7a3a">✓ searched ${r.total_returned}${pagesLine} · enriched ${r.enrichment_calls} · persisted <b>${r.generated} HOT</b></span>${fitLine}${channelLine}${vettingLine}. <a href="#/leads">View leads →</a>`;
          load();
        } catch (e) {
          if (e.code === 'apollo_not_configured') {
            genStatus.innerHTML = `<span style="color:#a12525">Apollo key not set. <a href="#/settings">Settings → apollo_api_key →</a></span>`;
          } else if (e.code === 'apollo_credits_depleted') {
            genStatus.innerHTML = `<span style="color:#a12525">Apollo quota hit. <a href="${e.billingUrl || 'https://app.apollo.io/#/settings/plans'}" target="_blank" rel="noopener">Top up →</a></span>`;
          } else {
            showGenerateLeadsError(e);
            genStatus.innerHTML = `<span style="color:#a12525">Failed: ${e.message}</span>`;
          }
        } finally {
          apolloBtn.disabled = false;
        }
      } }, 'Apollo Generate');
      genCard.append(
        el('h3', {}, 'Apollo lead generation'),
        el('p', { class: 'sub', style: 'margin:0 0 10px' }, 'Apollo.io database search + enrichment + two-stage vetting. Apollo keyword-filters to mother/baby/family/FMCG companies at search; then classifyHotness filters to decision-makers with buying signals; then a one-shot Haiku pass classifies each candidate as strong fit / weak fit / reject against Nuren\'s real buyer profile. Only fit and weak-fit leads land in the table. Cost: 1 Apollo credit per enriched candidate (~$0.05) + ~$0.003 for the batch ICP classification.'),
        el('div', { style: 'display:flex; align-items:center; gap:10px; flex-wrap:wrap' },
          el('label', { style: 'font-size:13px' }, 'How many candidates (max 15): '),
          countInput,
          apolloBtn,
          genStatus,
        ),
      );

      enrollCard.innerHTML = '';
      enrollCard.append(
        el('h3', {}, 'Enroll leads'),
        el('p', { class: 'sub', style: 'margin:0 0 12px' }, 'Pick leads to enroll into this campaign\'s sequence. Already-enrolled or unsubscribed leads are skipped server-side.'),
      );

      const leads = await api('/leads');
      const selected = new Set();

      // Toolbar: search + select-all + live count + primary CTA
      const searchInput = el('input', { type: 'text', class: 'enroll-search', placeholder: 'Filter by name, company, email, title…' });
      const selectAllCheckbox = el('input', { type: 'checkbox' });
      const countLabel = el('span', { class: 'count-badge' }, '0 selected');
      const enrollBtn = el('button', { class: 'btn primary', disabled: true, onclick: async () => {
        const ids = Array.from(selected);
        if (!ids.length) return;
        enrollBtn.disabled = true;
        try {
          const r = await api('/campaigns/' + id + '/enroll', { method: 'POST', body: JSON.stringify({ lead_ids: ids }) });
          const breakdown = r.reasons ? ' (' + Object.entries(r.reasons).map(([k, v]) => `${v} ${k}`).join(', ') + ')' : '';
          alert(`Enrolled ${r.enrolled}, skipped ${r.skipped}${breakdown}`);
          load();
        } catch (e) { alert('Enroll failed: ' + e.message); enrollBtn.disabled = false; }
      } }, 'Enroll selected');

      const toolbar = el('div', { class: 'enroll-toolbar' },
        searchInput,
        el('div', { style: 'display:flex; align-items:center; gap:14px' },
          countLabel,
          enrollBtn,
        ),
      );

      // Table body
      const tbody = el('tbody');
      const tableWrap = el('div', { class: 'enroll-table-wrap' });
      const emptyState = el('div', { class: 'enroll-empty' }, leads.length === 0
        ? 'No leads yet. Click "Apollo Generate" above to fetch verified HOT leads.'
        : 'No leads match your filter.');

      function updateCount() {
        const n = selected.size;
        countLabel.innerHTML = n
          ? `<b>${n}</b> selected of ${leads.length}`
          : `0 selected of ${leads.length}`;
        enrollBtn.disabled = n === 0;
        // Sync select-all state
        const visibleIds = Array.from(tbody.querySelectorAll('tr[data-lead-id]')).map(tr => parseInt(tr.dataset.leadId, 10));
        const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(lid => selected.has(lid));
        const someVisibleSelected = visibleIds.some(lid => selected.has(lid));
        selectAllCheckbox.checked = allVisibleSelected;
        selectAllCheckbox.indeterminate = someVisibleSelected && !allVisibleSelected;
      }

      function renderRow(l) {
        // Heat badge. For HOT leads, also show outreach mode + ICP fit chip.
        const isHot = (l.lead_type || 'cold').toLowerCase() === 'hot';
        const heatBadge = el('span', {});
        if (isHot) {
          heatBadge.append(el('span', { class: 'badge warn' }, 'HOT'));
          if (!l.email) {
            heatBadge.append(' ', el('span', { class: 'badge', style: 'background:#e5e0f4; color:#40309c' }, 'LinkedIn-only'));
          }
          // ICP fit chip (from Apollo post-vet). Only surface strong fit as
          // green; weak fit stays neutral; reject leads never reach this view.
          try {
            const enr = l.enrichment ? (typeof l.enrichment === 'string' ? JSON.parse(l.enrichment) : l.enrichment) : null;
            if (enr?.icp_fit === 'fit') {
              heatBadge.append(' ', el('span', { class: 'badge ok', title: enr.icp_reason || '' }, 'fit'));
            } else if (enr?.icp_fit === 'weak') {
              heatBadge.append(' ', el('span', { class: 'badge', title: enr.icp_reason || '' }, 'weak fit'));
            }
          } catch {}
        } else {
          heatBadge.append(el('span', { class: 'badge' }, 'cold'));
        }
        const emailCell = l.email
          ? el('td', { class: 'col-email' }, l.email)
          : el('td', { class: 'col-email' }, el('span', { class: 'muted-cell' }, 'no email'));
        const signalCell = l.buying_signal
          ? el('td', {}, el('span', { class: 'signal-pill', title: l.buying_signal }, l.buying_signal.length > 30 ? l.buying_signal.slice(0, 30) + '…' : l.buying_signal))
          : el('td', {}, el('span', { class: 'muted-cell' }, '—'));
        const cb = el('input', { type: 'checkbox' });
        cb.checked = selected.has(l.id);
        const tr = el('tr', { 'data-lead-id': String(l.id) },
          el('td', { class: 'col-check' }, cb),
          el('td', {}, el('a', { href: '#/lead/' + l.id, onclick: (ev) => ev.stopPropagation() }, l.name)),
          el('td', {}, l.account_name || el('span', { class: 'muted-cell' }, '—')),
          el('td', {}, l.title || el('span', { class: 'muted-cell' }, '—')),
          emailCell,
          el('td', {}, heatBadge),
          signalCell,
          el('td', { style: 'font-size:11.5px; color:#7b708f; white-space:nowrap' }, l.source || 'manual'),
        );
        if (cb.checked) tr.classList.add('selected');

        const toggle = () => {
          if (selected.has(l.id)) { selected.delete(l.id); cb.checked = false; tr.classList.remove('selected'); }
          else { selected.add(l.id); cb.checked = true; tr.classList.add('selected'); }
          updateCount();
        };
        // Clicking anywhere on the row toggles; clicks on the <a> and checkbox are handled separately
        tr.addEventListener('click', (ev) => {
          if (ev.target.tagName === 'A' || ev.target.tagName === 'INPUT') return;
          toggle();
        });
        cb.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(); });
        return tr;
      }

      function renderTable() {
        tbody.innerHTML = '';
        const q = searchInput.value.trim().toLowerCase();
        const filtered = q
          ? leads.filter(l => [l.name, l.account_name, l.email, l.title].some(v => (v || '').toLowerCase().includes(q)))
          : leads;
        if (filtered.length === 0) {
          tableWrap.innerHTML = '';
          tableWrap.append(emptyState);
          return;
        }
        for (const l of filtered) tbody.append(renderRow(l));
        // Rebuild table structure if wrap shows empty state
        if (!tableWrap.querySelector('table')) {
          tableWrap.innerHTML = '';
          const tbl = el('table', { class: 'enroll-table' });
          tbl.append(
            el('thead', {}, el('tr', {},
              el('th', { class: 'col-check' }, selectAllCheckbox),
              el('th', {}, 'Name'),
              el('th', {}, 'Company'),
              el('th', {}, 'Title'),
              el('th', { class: 'col-email' }, 'Email'),
              el('th', {}, 'Heat'),
              el('th', {}, 'Signal'),
              el('th', {}, 'Source'),
            )),
            tbody,
          );
          tableWrap.append(tbl);
        }
        updateCount();
      }

      searchInput.addEventListener('input', renderTable);
      selectAllCheckbox.addEventListener('change', () => {
        const visibleIds = Array.from(tbody.querySelectorAll('tr[data-lead-id]')).map(tr => parseInt(tr.dataset.leadId, 10));
        if (selectAllCheckbox.checked) {
          for (const lid of visibleIds) selected.add(lid);
        } else {
          for (const lid of visibleIds) selected.delete(lid);
        }
        // Re-render rows to refresh their checkbox + row-highlight state
        renderTable();
      });

      renderTable();
      enrollCard.append(toolbar, tableWrap);

      enrollList.innerHTML = '';
      enrollList.append(el('h3', {}, `Enrollments (${c.enrollments.length})`));
      if (!c.enrollments.length) {
        enrollList.append(el('p', { class: 'sub' }, 'No enrollments yet.'));
      } else {
        const tbl = el('table');
        tbl.append(el('thead', {}, el('tr', {},
          el('th', {}, 'Lead'), el('th', {}, 'Persona'), el('th', {}, 'Heat'), el('th', {}, 'Variant'),
          el('th', {}, 'Step'), el('th', {}, 'Status'), el('th', {}, 'Last action'), el('th', {}, ''),
        )));
        const tb = el('tbody');
        for (const e of c.enrollments) {
          tb.append(el('tr', {},
            el('td', {}, el('a', { href: '#/lead/' + e.lead_id }, e.lead_name)),
            el('td', {}, (e.persona || '').replace(/_/g, ' ')),
            el('td', {}, e.lead_type || ''),
            el('td', {}, e.variant_key),
            el('td', {}, String(e.current_step)),
            el('td', {}, el('span', { class: 'badge ' + (e.status === 'running' ? 'ok' : (e.status === 'replied' ? 'warn' : '')) }, e.status)),
            el('td', { style: 'font-size:11.5px; color:#7b708f' }, e.last_action_at || '—'),
            el('td', {}, el('a', { href: '#/lead/' + e.lead_id, class: 'btn' }, 'Open')),
          ));
        }
        tbl.append(tb);
        enrollList.append(tbl);
      }
    } catch (e) { head.innerHTML = 'Load failed: ' + e.message; }
  }
  return wrap;
}

// ====================== PIPELINE ======================
function PipelineView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Pipeline'));
  wrap.append(el('p', { class: 'sub' }, '6 stages: Prospect → Contacted → Engaged → Qualified → Proposal Sent → Closed (Won/Lost). Drag a card to advance. AI advances Contacted/Engaged automatically.'));

  const board = el('div', { style: 'display:grid; grid-template-columns:repeat(7,1fr); gap:10px; align-items:start' });
  wrap.append(board);

  load();

  async function load() {
    board.innerHTML = 'Loading…';
    try {
      const data = await api('/pipeline');
      board.innerHTML = '';
      for (const stage of data.stages) {
        const col = el('div', { class: 'card', style: 'min-height:200px; padding:10px' });
        const totalRow = data.totals.find(t => t.stage === stage);
        col.append(el('h3', { style: 'font-size:11px; margin:0 0 8px' },
          stage.replace(/_/g, ' ').toUpperCase(), ' (', String(totalRow?.count || 0), ')'));
        col.setAttribute('data-stage', stage);
        col.addEventListener('dragover', e => { e.preventDefault(); col.style.outline = '2px dashed #f7b5c4'; });
        col.addEventListener('dragleave', () => { col.style.outline = ''; });
        col.addEventListener('drop', async e => {
          e.preventDefault(); col.style.outline = '';
          const id = e.dataTransfer.getData('pipeline_id');
          if (!id) return;
          try { await api('/pipeline/' + id, { method: 'PATCH', body: JSON.stringify({ stage }) }); load(); }
          catch (err) { alert('Move failed: ' + err.message); }
        });
        for (const c of (data.byStage[stage] || [])) {
          const card = el('div', { style: 'background:#fff7ef; padding:8px 10px; border-radius:8px; margin-bottom:6px; cursor:grab; font-size:12.5px; border:1px solid #e7dfd1' });
          card.draggable = true;
          card.addEventListener('dragstart', e => e.dataTransfer.setData('pipeline_id', String(c.id)));
          card.append(
            el('div', { style: 'font-weight:600' }, el('a', { href: '#/lead/' + c.lead_id, style: 'color:#1b1147' }, c.lead_name)),
            el('div', { style: 'color:#7b708f; font-size:11.5px' }, c.account_name || ''),
            c.deal_value_myr ? el('div', { style: 'margin-top:4px; font-weight:600; color:#40309c' }, 'RM ' + c.deal_value_myr.toLocaleString()) : null,
          );
          col.append(card);
        }
        board.append(col);
      }
    } catch (e) { board.innerHTML = 'Load failed: ' + e.message; }
  }
  return wrap;
}

// ====================== APPOINTMENTS ======================
function AppointmentsView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Appointments'));
  wrap.append(el('p', { class: 'sub' }, 'Auto Google Meet link + ICS calendar invite + branded landing page sent on create.'));

  // Create
  const create = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const aLeadSel = el('select');
  const aTitle = el('input', { type: 'text', placeholder: 'Title (e.g. Discovery — Acme Baby × Nuren)' });
  const aWhen = el('input', { type: 'datetime-local' });
  const aDur = el('input', { type: 'number', value: '30', placeholder: 'duration min' });
  const aType = el('select');
  ['discovery', 'pitch', 'proposal_review', 'follow_up'].forEach(t => aType.append(el('option', { value: t }, t)));
  const aNotes = el('textarea', { rows: '2', placeholder: 'Agenda / notes (optional)' });
  const aBtn = el('button', { class: 'btn primary', onclick: async () => {
    if (!aTitle.value || !aWhen.value) return alert('Title + scheduled_at required.');
    try {
      const r = await api('/appointments', { method: 'POST', body: JSON.stringify({
        lead_id: parseInt(aLeadSel.value, 10) || null,
        title: aTitle.value,
        scheduled_at: new Date(aWhen.value).toISOString(),
        duration_minutes: parseInt(aDur.value, 10) || 30,
        type: aType.value,
        notes: aNotes.value,
      }) });
      alert(`Booked. Meet link: ${r.meet_link}\nBranded page: /call/${r.call_token}`);
      aTitle.value = ''; aNotes.value = '';
      load();
    } catch (e) { alert('Failed: ' + e.message); }
  } }, 'Book + send invite');
  create.append(
    el('h3', {}, 'Book a meeting'),
    el('div', { class: 'row' }, aLeadSel, aTitle),
    el('div', { class: 'row' }, aWhen, aDur, aType),
    aNotes,
    aBtn,
  );
  wrap.append(create);

  const list = el('div');
  wrap.append(list);

  (async () => {
    try {
      const leads = await api('/leads');
      aLeadSel.append(el('option', { value: '' }, '(no lead linked)'));
      for (const l of leads) aLeadSel.append(el('option', { value: l.id }, `${l.name} — ${l.account_name || ''}`));
    } catch {}
    load();
  })();

  async function load() {
    list.innerHTML = 'Loading…';
    try {
      const rows = await api('/appointments');
      list.innerHTML = '';
      if (!rows.length) return list.append(el('p', { class: 'sub' }, 'No appointments yet.'));
      const tbl = el('table');
      tbl.append(el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Title'), el('th', {}, 'Lead'),
        el('th', {}, 'Type'), el('th', {}, 'Status'), el('th', {}, 'Meet link'), el('th', {}, 'Branded page'),
      )));
      const tb = el('tbody');
      for (const a of rows) {
        const when = new Date(a.scheduled_at + 'Z').toLocaleString();
        tb.append(el('tr', {},
          el('td', {}, when),
          el('td', {}, a.title),
          el('td', {}, a.lead_name ? el('a', { href: '#/lead/' + a.lead_id }, a.lead_name) : '—'),
          el('td', {}, a.type),
          el('td', {}, el('span', { class: 'badge' }, a.status)),
          el('td', {}, a.meet_link ? el('a', { href: a.meet_link, target: '_blank' }, 'Join') : '—'),
          el('td', {}, a.call_token ? el('a', { href: '/call/' + a.call_token, target: '_blank' }, 'Open') : '—'),
        ));
      }
      tbl.append(tb);
      list.append(tbl);
    } catch (e) { list.innerHTML = 'Load failed: ' + e.message; }
  }
  return wrap;
}

// ====================== ANALYTICS ======================
function AnalyticsView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Analytics'));
  wrap.append(el('p', { class: 'sub' }, 'Funnel, per-segment performance, A/B winners, and top messages. All live from the messages + activities tables.'));

  const funnelCard = el('div', { class: 'card', style: 'margin-bottom:16px' });
  const segCard = el('div', { class: 'card', style: 'margin-bottom:16px' });
  const abCard = el('div', { class: 'card', style: 'margin-bottom:16px' });
  const topCard = el('div', { class: 'card', style: 'margin-bottom:16px' });
  const dailyCard = el('div', { class: 'card' });
  wrap.append(funnelCard, segCard, abCard, topCard, dailyCard);

  (async () => {
    try {
      const f = await api('/analytics/funnel');
      funnelCard.innerHTML = '';
      funnelCard.append(el('h3', {}, 'Funnel (all time)'));
      const rows = [
        ['Leads', f.leads_total, '100%'],
        ['Contacted', f.contacted, f.rates.contact_rate + '%'],
        ['Opened', f.opened, f.rates.open_rate + '% of contacted'],
        ['Clicked', f.clicked, f.rates.click_rate + '%'],
        ['Replied', f.replied, f.rates.reply_rate + '%'],
        ['Positive replies', f.positive_replies, f.rates.positive_reply_rate + '%'],
        ['Meetings booked', f.meetings_booked, f.rates.meeting_booked_rate + '%'],
        ['Meetings held', f.meetings_held, ''],
        ['Closed won', f.closed_won, f.rates.meeting_to_won + '% of meetings'],
        ['Revenue (MYR)', 'RM ' + (f.revenue_myr || 0).toLocaleString(), 'RM ' + f.rates.revenue_per_contacted_myr + '/contacted'],
      ];
      const tbl = el('table');
      tbl.append(el('thead', {}, el('tr', {}, el('th', {}, 'Stage'), el('th', {}, 'Count'), el('th', {}, 'Conversion'))));
      const tb = el('tbody');
      for (const [k, v, r] of rows) tb.append(el('tr', {}, el('td', {}, k), el('td', {}, String(v)), el('td', {}, r)));
      tbl.append(tb);
      funnelCard.append(tbl);
    } catch (e) { funnelCard.innerHTML = '<h3>Funnel failed: ' + e.message + '</h3>'; }

    try {
      const rows = await api('/analytics/by-segment');
      segCard.innerHTML = '';
      segCard.append(el('h3', {}, 'By segment'));
      if (!rows.length) return segCard.append(el('p', { class: 'hint' }, 'No data yet.'));
      const tbl = el('table');
      tbl.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Segment'), el('th', {}, 'Leads'), el('th', {}, 'Contacted'), el('th', {}, 'Opened'),
        el('th', {}, 'Replied'), el('th', {}, 'Positive'), el('th', {}, 'Meetings'),
        el('th', {}, 'Open %'), el('th', {}, 'Reply %'), el('th', {}, 'Positive %'), el('th', {}, 'Meeting %'),
      )));
      const tb = el('tbody');
      for (const r of rows) tb.append(el('tr', {},
        el('td', {}, r.segment), el('td', {}, String(r.leads)), el('td', {}, String(r.contacted)),
        el('td', {}, String(r.opened)), el('td', {}, String(r.replied)), el('td', {}, String(r.positive)),
        el('td', {}, String(r.meetings)),
        el('td', {}, r.open_rate + '%'), el('td', {}, r.reply_rate + '%'),
        el('td', {}, r.positive_rate + '%'), el('td', {}, r.meeting_rate + '%'),
      ));
      tbl.append(tb);
      segCard.append(tbl);
    } catch (e) { segCard.innerHTML = '<h3>Segments failed: ' + e.message + '</h3>'; }

    try {
      const rows = await api('/analytics/ab');
      abCard.innerHTML = '';
      abCard.append(el('h3', {}, 'A/B performance by step + variant'));
      if (!rows.length) return abCard.append(el('p', { class: 'hint' }, 'No sends yet.'));
      const tbl = el('table');
      tbl.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Step'), el('th', {}, 'Variant'), el('th', {}, 'Sent'), el('th', {}, 'Opened'),
        el('th', {}, 'Clicked'), el('th', {}, 'Replied'), el('th', {}, 'Positive'), el('th', {}, 'Bounced'),
        el('th', {}, 'Open %'), el('th', {}, 'Reply %'), el('th', {}, 'Positive %'),
      )));
      const tb = el('tbody');
      // Mark winner per step
      const bySteps = {};
      for (const r of rows) {
        (bySteps[r.step_number] = bySteps[r.step_number] || []).push(r);
      }
      const winners = new Set();
      for (const step of Object.values(bySteps)) {
        if (step.length < 2) continue;
        step.sort((a, b) => b.positive_rate - a.positive_rate || b.reply_rate - a.reply_rate);
        if (step[0].sent >= 10) winners.add(`${step[0].step_number}:${step[0].variant_key}`);  // minimum sample size
      }
      for (const r of rows) {
        const isWinner = winners.has(`${r.step_number}:${r.variant_key}`);
        tb.append(el('tr', { style: isWinner ? 'background:#e6f4ef' : '' },
          el('td', {}, String(r.step_number)),
          el('td', {}, r.variant_key + (isWinner ? ' 🏆' : '')),
          el('td', {}, String(r.sent)), el('td', {}, String(r.opened)), el('td', {}, String(r.clicked)),
          el('td', {}, String(r.replied)), el('td', {}, String(r.positive)), el('td', {}, String(r.bounced)),
          el('td', {}, r.open_rate + '%'), el('td', {}, r.reply_rate + '%'), el('td', {}, r.positive_rate + '%'),
        ));
      }
      tbl.append(tb);
      abCard.append(tbl);
      abCard.append(el('p', { class: 'hint', style: 'margin-top:10px' }, 'Winner shown when one variant beats the other on positive reply rate AND sample ≥ 10. No emojis in prod copy — just a UI hint here.'));
    } catch (e) { abCard.innerHTML = '<h3>A/B failed: ' + e.message + '</h3>'; }

    try {
      const rows = await api('/analytics/top-messages');
      topCard.innerHTML = '';
      topCard.append(el('h3', {}, 'Top messages (by attribution)'));
      if (!rows.length) return topCard.append(el('p', { class: 'hint' }, 'No sends yet.'));
      for (const m of rows.slice(0, 8)) {
        const c = el('div', { style: 'border-bottom:1px dashed var(--line); padding:10px 0' });
        c.append(
          el('div', { style: 'display:flex; gap:10px; font-size:12.5px; color:#7b708f; margin-bottom:4px' },
            el('span', {}, `Step ${m.step_number}/${m.variant_key}`),
            el('span', {}, m.lead_name),
            el('span', {}, m.industry || m.persona || ''),
            m.reply_class ? el('span', { class: 'badge ' + (m.reply_class === 'positive' ? 'ok' : 'warn') }, m.reply_class) : null,
          ),
          m.subject ? el('div', { style: 'font-weight:600; margin-bottom:4px' }, m.subject) : null,
          el('div', { style: 'font-size:12.5px; color:#3b3064' }, (m.body_preview || '').replace(/\s+/g, ' ').slice(0, 240) + '…'),
        );
        topCard.append(c);
      }
    } catch (e) { topCard.innerHTML = '<h3>Top failed: ' + e.message + '</h3>'; }

    try {
      const rows = await api('/analytics/daily?days=14');
      dailyCard.innerHTML = '';
      dailyCard.append(el('h3', {}, 'Last 14 days — sends / opens / replies'));
      if (!rows.length) return dailyCard.append(el('p', { class: 'hint' }, 'No activity yet.'));
      const max = rows.reduce((m, r) => Math.max(m, r.sent || 0, r.opened || 0, r.replied || 0), 1);
      const bars = el('div', { style: 'display:flex; gap:6px; align-items:flex-end; height:120px; margin-top:10px' });
      for (const r of rows) {
        const col = el('div', { style: 'flex:1; display:flex; flex-direction:column; gap:2px; justify-content:flex-end; font-size:10px; color:#7b708f; text-align:center' });
        col.append(
          el('div', { style: `height:${(r.sent || 0) * 100 / max}%; background:#1b1147; border-radius:4px 4px 0 0; min-height:1px` }),
          el('div', { style: `height:${(r.opened || 0) * 80 / max}%; background:#f7b5c4; min-height:1px` }),
          el('div', { style: `height:${(r.replied || 0) * 60 / max}%; background:#6f9d8b; border-radius:0 0 4px 4px; min-height:1px` }),
          el('div', {}, (r.day || '').slice(5)),
        );
        bars.append(col);
      }
      dailyCard.append(bars);
      dailyCard.append(el('div', { style: 'display:flex; gap:16px; font-size:12px; color:#7b708f; margin-top:10px' },
        el('span', {}, '■ sent'), el('span', { style: 'color:#f7b5c4' }, '■ opened'), el('span', { style: 'color:#6f9d8b' }, '■ replied'),
      ));
    } catch (e) { dailyCard.innerHTML = '<h3>Daily failed: ' + e.message + '</h3>'; }
  })();

  return wrap;
}


function PlaceholderView(name) {
  const wrap = el('div');
  wrap.append(el('h1', {}, name[0].toUpperCase() + name.slice(1)));
  wrap.append(el('p', { class: 'sub' }, 'Coming in the next sprint.'));
  return wrap;
}

function KnowledgeView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Knowledge Base'));
  wrap.append(el('p', { class: 'sub' }, 'Upload Nuren media-kit / rate-card / survey PPTX. Vision pass + hybrid retrieval = zero-hallucination answers.'));

  // Uploader
  const up = el('div', { class: 'uploader' });
  const fileInput = el('input', { type: 'file', accept: '.pptx' });
  const forceCheck = el('input', { type: 'checkbox', id: 'force' });
  const forceLabel = el('label', { for: 'force', style: 'display:inline; margin-left:8px' }, 'Force re-ingest');
  const uploadBtn = el('button', { class: 'btn primary', onclick: async () => {
    if (!fileInput.files[0]) return alert('Pick a .pptx first.');
    uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading…';
    try {
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      const r = await apiUpload('/knowledge/upload' + (forceCheck.checked ? '?force=1' : ''), fd);
      alert(`Ingest ok: ${r.skipped ? 'already indexed' : r.chunkCount + ' chunks, $' + (r.visionCost || 0).toFixed(4) + ' vision cost'}`);
      loadAssets();
    } catch (e) { alert('Ingest failed: ' + e.message); }
    uploadBtn.disabled = false; uploadBtn.textContent = 'Upload + Ingest';
  } }, 'Upload + Ingest');
  up.append(fileInput, uploadBtn, forceCheck, forceLabel);
  wrap.append(up);

  // Search
  const searchRow = el('div', { class: 'row', style: 'margin-bottom:20px' });
  const q = el('input', { type: 'text', placeholder: 'Ask the knowledge base — e.g. "MMY KOL rate for FMCG baby skincare mid-budget"' });
  const brandSel = el('select');
  brandSel.append(el('option', { value: '' }, 'Any brand'));
  ['mmy','kmm','msg','nuren21','ibuencer','kelabmama','parentcraft','cross'].forEach(b => brandSel.append(el('option', { value: b }, b.toUpperCase())));
  const searchBtn = el('button', { class: 'btn primary', onclick: runSearch }, 'Search');
  searchRow.append(q, brandSel, searchBtn);
  wrap.append(searchRow);
  const results = el('div');
  wrap.append(results);
  q.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

  async function runSearch() {
    if (!q.value.trim()) return;
    results.innerHTML = 'Searching…';
    try {
      const params = new URLSearchParams({ q: q.value });
      if (brandSel.value) params.set('brand', brandSel.value);
      const r = await api('/knowledge/search?' + params.toString());
      results.innerHTML = '';
      if (!r.hits.length) return results.append(el('p', { class: 'sub' }, 'No matches. Have you ingested any PPTX yet?'));
      for (const h of r.hits) {
        const c = el('div', { class: 'card', style: 'margin-bottom:10px' });
        c.append(
          el('h3', {}, `${h.brand?.toUpperCase() || ''} · ${h.asset_type || ''} · slide ${h.slide_number} — score ${h.score.toFixed(4)}`),
          el('div', { class: 'hint' }, h.filename || ''),
          el('pre', { style: 'margin:10px 0 0; white-space:pre-wrap; font-family:inherit; font-size:12.5px; color:#40309c' }, h.content.slice(0, 800) + (h.content.length > 800 ? '…' : '')),
        );
        results.append(c);
      }
    } catch (e) { results.innerHTML = 'Search failed: ' + e.message; }
  }

  // Assets table
  const tbl = el('table');
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Filename'),
    el('th', {}, 'Brand'),
    el('th', {}, 'Type'),
    el('th', {}, 'Slides'),
    el('th', {}, 'Chunks'),
    el('th', {}, 'Vision $'),
    el('th', {}, 'Status'),
    el('th', {}, ''),
  )));
  const tbody = el('tbody');
  tbl.append(tbody);
  wrap.append(el('h3', { style: 'margin-top:28px' }, 'Ingested assets'), tbl);

  async function loadAssets() {
    tbody.innerHTML = '';
    try {
      const rows = await api('/knowledge/assets');
      for (const r of rows) {
        const badgeClass = ({ completed: 'ok', parsing: 'busy', vision: 'busy', embedding: 'busy', failed: 'fail' })[r.ingest_status] || 'warn';
        tbody.append(el('tr', {},
          el('td', {}, r.filename),
          el('td', {}, (r.brand || '').toUpperCase()),
          el('td', {}, r.asset_type || ''),
          el('td', {}, String(r.slide_count || 0)),
          el('td', {}, String(r.chunk_count || 0)),
          el('td', {}, '$' + (r.vision_cost_usd || 0).toFixed(4)),
          el('td', {}, el('span', { class: 'badge ' + badgeClass }, r.ingest_status)),
          el('td', {}, el('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!confirm('Delete this asset and its chunks? The source .pptx in knowledge-base/ will stay.')) return;
              await api('/knowledge/asset/' + r.id, { method: 'DELETE' });
              loadAssets();
            },
          }, 'Delete')),
        ));
      }
    } catch (e) { tbody.append(el('tr', {}, el('td', { colspan: 8 }, 'Failed: ' + e.message))); }
  }
  loadAssets();

  return wrap;
}

function SettingsView() {
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Settings'));
  wrap.append(el('p', { class: 'sub' }, 'API keys are encrypted at rest. Only superadmins can save.'));
  const form = el('div');
  const keys = ['api_key','voyage_api_key','apollo_api_key','resend_api_key','from_email','ai_model_default','ai_model_objection','ai_model_enrichment','ai_model_vision','embedding_model','embedding_dim','company_name','positioning_moat','tone_policy'];
  const inputs = {};
  for (const k of keys) { inputs[k] = el('input', { type: 'text' }); form.append(el('label', {}, k), inputs[k]); }
  const saveBtn = el('button', { class: 'btn primary', onclick: async () => {
    const body = {};
    for (const k of keys) {
      const v = inputs[k].value;
      if (v && !v.includes('•')) body[k] = v;
    }
    try { await api('/settings', { method: 'PUT', body: JSON.stringify(body) }); alert('Saved.'); load(); }
    catch (e) { alert('Save failed: ' + e.message); }
  } }, 'Save');
  wrap.append(form, saveBtn);
  async function load() {
    try {
      const cur = await api('/settings');
      for (const k of keys) inputs[k].value = cur[k] || '';
    } catch (e) { /* ignore */ }
  }
  load();
  return wrap;
}

async function bootstrap() {
  if (state.token) {
    try { const { user } = await api('/auth/me'); state.user = user; }
    catch { state.token = ''; localStorage.removeItem('token'); }
  }
  render();
}

function logout() {
  api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.token = ''; localStorage.removeItem('token');
  // Tear down the assistant widget so it does not persist past logout.
  const fab = document.getElementById('assistant-fab');
  if (fab) fab.remove();
  closeAssistant();
  assistantState.fab = null;
  assistantState.messages = [];
  render();
}

window.addEventListener('hashchange', () => { state.route = location.hash || '#/dashboard'; render(); });
bootstrap();
