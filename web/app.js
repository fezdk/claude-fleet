// Fleet Manager — Web UI client

const API = '';
let ws = null;
let currentSessionId = null;
let autoRefreshTimer = null;
let pendingQuestionsMap = {};  // session_id -> count
let authRequired = false;
let focusSessionId = null;
let focusRefreshTimer = null;

// View mode state
let viewMode = localStorage.getItem('fleet_view_mode') || 'list';
let activeTabSessionId = null;
let viewRefreshTimer = null;

// ── Message History (per-session) ──

const MSG_HISTORY_KEY = 'fleet_msg_history';
const MSG_HISTORY_MAX = 50;
let allHistory = JSON.parse(localStorage.getItem(MSG_HISTORY_KEY) || '{}');
let msgHistoryIndex = -1;
let msgHistoryDraft = '';
const sessionDrafts = {};  // sessionId -> unsent draft text

function _getActiveSessionId() {
  return focusSessionId || activeTabSessionId || currentSessionId;
}

function _getHistory(sessionId) {
  if (!sessionId) return [];
  if (!allHistory[sessionId]) allHistory[sessionId] = [];
  return allHistory[sessionId];
}

function pushHistory(text) {
  const sid = _getActiveSessionId();
  if (!text || !sid) return;
  const hist = _getHistory(sid);
  if (hist.length > 0 && hist[hist.length - 1] === text) return;
  hist.push(text);
  if (hist.length > MSG_HISTORY_MAX) hist.shift();
  allHistory[sid] = hist;
  localStorage.setItem(MSG_HISTORY_KEY, JSON.stringify(allHistory));
  msgHistoryIndex = -1;
  msgHistoryDraft = '';
  delete sessionDrafts[sid];
}

function clearSessionHistory(sessionId) {
  if (!sessionId) return;
  delete allHistory[sessionId];
  delete sessionDrafts[sessionId];
  localStorage.setItem(MSG_HISTORY_KEY, JSON.stringify(allHistory));
}

function saveDraft(inputEl) {
  const sid = _getActiveSessionId();
  if (sid && inputEl) sessionDrafts[sid] = inputEl.value || '';
}

function restoreDraft(inputEl) {
  const sid = _getActiveSessionId();
  if (inputEl) inputEl.value = (sid && sessionDrafts[sid]) || '';
  msgHistoryIndex = -1;
  msgHistoryDraft = '';
}

function historyKeyHandler(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (e.target.tagName === 'TEXTAREA') return;
  const sid = _getActiveSessionId();
  const hist = _getHistory(sid);
  if (hist.length === 0) return;

  e.preventDefault();
  const input = e.target;

  if (e.key === 'ArrowUp') {
    if (msgHistoryIndex === -1) {
      msgHistoryDraft = input.value;
      msgHistoryIndex = hist.length - 1;
    } else if (msgHistoryIndex > 0) {
      msgHistoryIndex--;
    }
    input.value = hist[msgHistoryIndex];
  } else {
    if (msgHistoryIndex === -1) return;
    if (msgHistoryIndex < hist.length - 1) {
      msgHistoryIndex++;
      input.value = hist[msgHistoryIndex];
    } else {
      msgHistoryIndex = -1;
      input.value = msgHistoryDraft;
    }
  }
}

// Attach history navigation to all message inputs
for (const id of ['focus-msg-input', 'tab-msg-input', 'sidetab-msg-input']) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', historyKeyHandler);
}

// ── WebSocket ──

function getAuthToken() {
  return localStorage.getItem('fleet_auth_token');
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getAuthToken();
  const params = token ? `?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${proto}//${location.host}/ws${params}`);

  ws.onopen = () => {
    const el = document.getElementById('ws-status');
    el.innerHTML = '<span class="ws-dot">●</span><span class="btn-label"> live</span>';
    el.className = 'badge badge-connected';
  };

  ws.onclose = () => {
    const el = document.getElementById('ws-status');
    el.innerHTML = '<span class="ws-dot">●</span><span class="btn-label"> disconnected</span>';
    el.className = 'badge badge-disconnected';
    setTimeout(connectWS, 3000);
  };

  ws.onmessage = (evt) => {
    const { event, data } = JSON.parse(evt.data);
    handleEvent(event, data);
  };
}

function handleEvent(event, data) {
  if (event === 'session:update' || event === 'session:stale') {
    refreshDashboard();
    if (currentSessionId && data.session_id === currentSessionId) {
      loadSessionDetail(currentSessionId);
    }
    if (focusSessionId && data.session_id === focusSessionId) {
      updateFocusHeader(data);
    }
    // Update active tab/sidetab terminal on session update
    if (activeTabSessionId && data.session_id === activeTabSessionId) {
      if (viewMode === 'tab') loadTerminalInto(activeTabSessionId, 'tab-terminal');
      else if (viewMode === 'sidetab') loadTerminalInto(activeTabSessionId, 'sidetab-terminal');
    }
  } else if (event === 'question:new') {
    refreshDashboard();
    if (currentSessionId && data.session_id === currentSessionId) {
      loadQuestions(currentSessionId);
    }
    if (focusSessionId && data.session_id === focusSessionId) {
      showQuestionModal(data.session_id);
    }
    notify('Question', data.context || 'A session needs input', data.session_id);
  } else if (event === 'question:answered') {
    refreshDashboard();
    if (currentSessionId) loadQuestions(currentSessionId);
  } else if (event === 'session:message') {
    if (currentSessionId && data.session_id === currentSessionId) {
      showMessageStatus(
        data.delivered ? `Delivered (${data.delivery_method})` : 'Queued for delivery',
        data.delivered ? 'success' : 'info'
      );
    }
  }
}

// ── Notifications ──

function notify(title, body, sessionId) {
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`Fleet: ${title}`, { body, tag: sessionId });
    n.onclick = () => {
      window.focus();
      if (sessionId) showSession(sessionId);
      n.close();
    };
  }
}

// ── API helpers ──

async function api(path, opts = {}) {
  const token = getAuthToken();
  const authHeaders = token ? { 'Authorization': `Bearer ${token}` } : {};
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// ── ANSI to HTML ──

const ANSI_COLORS = [
  '#1e1e2e','#cf222e','#1a7f37','#9a6700','#0969da','#8250df','#1b7c83','#cdd6f4',
  '#6e7681','#ff8182','#4ac26b','#d4a72c','#58a6ff','#bc8cff','#56d4dd','#ffffff',
];

function ansiToHtml(text) {
  // HTML-escape first to prevent XSS
  const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let result = '';
  let open = false;
  let i = 0;

  // Stateful style tracking — persists across escape sequences so that
  // e.g. a foreground change doesn't discard the current background.
  let st = {};

  function applyState() {
    if (open) { result += '</span>'; open = false; }
    const styles = [];
    if (st.bold) styles.push('font-weight:bold');
    if (st.dim) styles.push('opacity:0.7');
    if (st.italic) styles.push('font-style:italic');
    if (st.underline) styles.push('text-decoration:underline');
    if (st.color) styles.push(`color:${st.color}`);
    if (st.bg) styles.push(`background:${st.bg}`);
    if (styles.length) {
      result += `<span style="${styles.join(';')}">`;
      open = true;
    }
  }

  while (i < escaped.length) {
    // Match ESC[ ... m sequences (SGR)
    if (escaped[i] === '\x1b' && escaped[i+1] === '[') {
      const end = escaped.indexOf('m', i+2);
      if (end === -1) { i++; continue; }
      const codes = escaped.slice(i+2, end).split(';').map(Number);
      i = end + 1;

      let changed = false;
      for (let c = 0; c < codes.length; c++) {
        const code = codes[c];
        if (code === 0) { st = {}; changed = true; }
        else if (code === 1) { st.bold = true; changed = true; }
        else if (code === 2) { st.dim = true; changed = true; }
        else if (code === 3) { st.italic = true; changed = true; }
        else if (code === 4) { st.underline = true; changed = true; }
        else if (code === 22) { st.bold = false; st.dim = false; changed = true; }
        else if (code === 23) { st.italic = false; changed = true; }
        else if (code === 24) { st.underline = false; changed = true; }
        else if (code === 39) { delete st.color; changed = true; }
        else if (code === 49) { delete st.bg; changed = true; }
        else if (code >= 30 && code <= 37) { st.color = ANSI_COLORS[code-30]; changed = true; }
        else if (code >= 40 && code <= 47) { st.bg = ANSI_COLORS[code-40]; changed = true; }
        else if (code >= 90 && code <= 97) { st.color = ANSI_COLORS[code-82]; changed = true; }
        else if (code >= 100 && code <= 107) { st.bg = ANSI_COLORS[code-92]; changed = true; }
        else if (code === 38 && codes[c+1] === 5) { st.color = ansi256(codes[c+2]||0); c+=2; changed = true; }
        else if (code === 48 && codes[c+1] === 5) { st.bg = ansi256(codes[c+2]||0); c+=2; changed = true; }
        else if (code === 38 && codes[c+1] === 2) { st.color = `rgb(${codes[c+2]||0},${codes[c+3]||0},${codes[c+4]||0})`; c+=4; changed = true; }
        else if (code === 48 && codes[c+1] === 2) { st.bg = `rgb(${codes[c+2]||0},${codes[c+3]||0},${codes[c+4]||0})`; c+=4; changed = true; }
      }
      if (changed) applyState();
      continue;
    }
    // Strip other escape sequences (OSC, charset, etc)
    if (escaped[i] === '\x1b') {
      if (escaped[i+1] === ']') { const st2 = escaped.indexOf('\x07', i); i = st2 === -1 ? i+1 : st2+1; continue; }
      i += 2; continue;
    }
    result += escaped[i++];
  }
  if (open) result += '</span>';
  return result;
}

function ansi256(n) {
  if (n < 16) return ANSI_COLORS[n] || '#cdd6f4';
  if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
  n -= 16;
  const r = Math.floor(n/36) * 51, g = Math.floor((n%36)/6) * 51, b = (n%6) * 51;
  return `rgb(${r},${g},${b})`;
}

// ── Dashboard ──

async function refreshDashboard() {
  try {
    const [sessions, questions] = await Promise.all([
      api('/api/sessions'),
      api('/api/questions?pending=true'),
    ]);

    // Update session count
    document.getElementById('session-count').innerHTML = `<span class="count-num">${sessions.length}</span><span class="btn-label"> session${sessions.length !== 1 ? 's' : ''}</span>`;

    // Build pending questions map
    pendingQuestionsMap = {};
    for (const q of questions) {
      pendingQuestionsMap[q.session_id] = (pendingQuestionsMap[q.session_id] || 0) + 1;
    }

    // Show/hide pending banner
    const banner = document.getElementById('pending-questions-banner');
    if (questions.length > 0) {
      banner.classList.remove('hidden');
      document.getElementById('pending-count').textContent = questions.length;
    } else {
      banner.classList.add('hidden');
    }

    // Dispatch to active renderer
    switch (viewMode) {
      case 'list':    renderListView(sessions); break;
      case 'tab':     renderTabView(sessions); break;
      case 'sidetab': renderSideTabView(sessions); break;
    }
  } catch (e) {
    console.error('Dashboard refresh error:', e);
  }
}

function renderListView(sessions) {
  const container = document.getElementById('view-list');
  if (sessions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No sessions yet</h2>
        <p>Start a fleet session with:</p>
        <p><code>fleet start --name my-session --project /path/to/project</code></p>
      </div>
    `;
    return;
  }

  container.innerHTML = sessions.map(s => {
    const qCount = pendingQuestionsMap[s.session_id] || 0;
    const hasQ = qCount > 0;
    return `
      <div class="session-card${hasQ ? ' has-question' : ''}">
        ${hasQ ? `<span class="question-badge">${qCount} ?</span>` : ''}
        <div class="row">
          <span class="name" onclick="showSession('${s.session_id}')" style="cursor:pointer">${esc(s.session_id)}</span>
          <div style="display:flex;gap:0.4rem;align-items:center">
            <span class="state state-${s.state}">${s.state}</span>
            <button class="btn-sm btn-focus" onclick="event.stopPropagation();openFocus('${s.session_id}')">Open</button>
          </div>
        </div>
        <div class="summary" onclick="showSession('${s.session_id}')" style="cursor:pointer">${esc(s.summary || 'No status reported')}</div>
        <div class="meta">
          ${s.project_root ? esc(s.project_root) + ' &middot; ' : ''}${timeAgo(s.last_seen)}
          ${s.queued_messages ? ` &middot; <span class="queued-badge">${s.queued_messages} queued</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderTabView(sessions) {
  // Auto-select active tab
  if (!activeTabSessionId || !sessions.find(s => s.session_id === activeTabSessionId)) {
    activeTabSessionId = sessions.length > 0 ? sessions[0].session_id : null;
  }

  // Render tab bar
  const tabBar = document.getElementById('tab-bar');
  tabBar.innerHTML = sessions.map(s => {
    const qCount = pendingQuestionsMap[s.session_id] || 0;
    const isActive = s.session_id === activeTabSessionId;
    const stateColor = { IDLE: 'var(--blue)', WORKING: 'var(--green)', AWAITING_INPUT: 'var(--yellow)', ERROR: 'var(--red)' }[s.state] || 'var(--text-muted)';
    return `
      <button class="tab-btn${isActive ? ' active' : ''}" onclick="selectTab('${s.session_id}')" title="${esc(s.summary || s.state)}">
        <span class="tab-dot" style="background:${stateColor}"></span>
        ${esc(s.session_id)}
        ${qCount > 0 ? `<span class="tab-question-badge">${qCount}</span>` : ''}
        ${s.queued_messages ? `<span class="tab-queued-badge">${s.queued_messages}</span>` : ''}
      </button>
    `;
  }).join('');

  // Populate keys bar
  document.getElementById('tab-keys-bar').innerHTML = generateKeysBarHtml('tab');

  // Load terminal for active tab
  if (activeTabSessionId) {
    loadTerminalInto(activeTabSessionId, 'tab-terminal');
  } else {
    document.getElementById('tab-terminal').innerHTML = '<span style="color:var(--text-muted);padding:1rem;display:block">No sessions — start one with + New Session</span>';
  }
}

function selectTab(sessionId) {
  saveDraft(document.getElementById('tab-msg-input'));
  activeTabSessionId = sessionId;
  refreshDashboard();
  restoreDraft(document.getElementById('tab-msg-input'));
}

function renderSideTabView(sessions) {
  // Auto-select active tab
  if (!activeTabSessionId || !sessions.find(s => s.session_id === activeTabSessionId)) {
    activeTabSessionId = sessions.length > 0 ? sessions[0].session_id : null;
  }

  // Render side panel
  const panel = document.getElementById('sidetab-panel');
  panel.innerHTML = sessions.map(s => {
    const isActive = s.session_id === activeTabSessionId;
    const qCount = pendingQuestionsMap[s.session_id] || 0;
    return `
      <div class="sidetab-item${isActive ? ' active' : ''}" onclick="selectSideTab('${s.session_id}')">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.4rem">
          <span class="sidetab-name">${esc(s.session_id)}</span>
          <span class="state state-${s.state}" style="font-size:0.65rem;padding:1px 6px">${s.state}</span>
        </div>
        <div class="sidetab-summary">${esc(s.summary || '')}</div>
        <div class="sidetab-meta">
          ${timeAgo(s.last_seen)}
          ${s.queued_messages ? ` · <span class="queued-badge">${s.queued_messages} queued</span>` : ''}
        </div>
        ${qCount > 0 ? `<span class="tab-question-badge" style="margin-top:4px;display:inline-block">${qCount} ?</span>` : ''}
      </div>
    `;
  }).join('');

  // Populate keys bar
  document.getElementById('sidetab-keys-bar').innerHTML = generateKeysBarHtml('sidetab');

  // Load terminal for active session
  if (activeTabSessionId) {
    loadTerminalInto(activeTabSessionId, 'sidetab-terminal');
  } else {
    document.getElementById('sidetab-terminal').innerHTML = '<span style="color:var(--text-muted);padding:1rem;display:block">No sessions — start one with + New Session</span>';
  }
}

function selectSideTab(sessionId) {
  saveDraft(document.getElementById('sidetab-msg-input'));
  activeTabSessionId = sessionId;
  refreshDashboard();
  restoreDraft(document.getElementById('sidetab-msg-input'));
}

function showDashboard() {
  currentSessionId = null;
  stopAutoRefresh();
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('session-detail').classList.add('hidden');
  // Restore correct view container
  document.querySelectorAll('.view-container').forEach(el => el.classList.add('hidden'));
  const container = document.getElementById(`view-${viewMode}`);
  if (container) container.classList.remove('hidden');
  refreshDashboard();
}

// ── Shared View Functions ──

function generateKeysBarHtml(prefix) {
  return `
    <div class="keys-group">
      <button class="key-btn" onclick="sendKeyTo(activeTabSessionId,'Up','${prefix}-terminal')" title="Up arrow">&#9650;</button>
      <button class="key-btn" onclick="sendKeyTo(activeTabSessionId,'Down','${prefix}-terminal')" title="Down arrow">&#9660;</button>
    </div>
    <div class="keys-group">
      <div class="cmd-dropdown-wrapper">
        <button class="key-btn key-cmd" onclick="toggleViewCommandDropdown('${prefix}')" title="Send command">/ Cmd</button>
        <div id="${prefix}-cmd-dropdown" class="cmd-dropdown hidden">
          <div class="cmd-dropdown-item" onclick="sendCommandTo(activeTabSessionId,'/help','${prefix}-msg-status');closeViewDropdown('${prefix}')">
            <span class="cmd-name">/help</span><span class="cmd-desc">Show help</span>
          </div>
          <div class="cmd-dropdown-item" onclick="sendCommandTo(activeTabSessionId,'/status','${prefix}-msg-status');closeViewDropdown('${prefix}')">
            <span class="cmd-name">/status</span><span class="cmd-desc">Check status</span>
          </div>
          <div class="cmd-dropdown-item" onclick="sendCommandTo(activeTabSessionId,'/review','${prefix}-msg-status');closeViewDropdown('${prefix}')">
            <span class="cmd-name">/review</span><span class="cmd-desc">Review changes</span>
          </div>
          <div class="cmd-dropdown-item" onclick="sendCommandTo(activeTabSessionId,'/commit','${prefix}-msg-status');closeViewDropdown('${prefix}')">
            <span class="cmd-name">/commit</span><span class="cmd-desc">Commit staged</span>
          </div>
          <div class="cmd-dropdown-item" onclick="sendCommandTo(activeTabSessionId,'/clear','${prefix}-msg-status');closeViewDropdown('${prefix}')">
            <span class="cmd-name">/clear</span><span class="cmd-desc">Clear context</span>
          </div>
          <div class="cmd-dropdown-item" onclick="sendCommandTo(activeTabSessionId,'/resume','${prefix}-msg-status');closeViewDropdown('${prefix}')">
            <span class="cmd-name">/resume</span><span class="cmd-desc">Resume previous session</span>
          </div>
          <div class="cmd-dropdown-divider"></div>
          <div class="cmd-dropdown-item cmd-dropdown-unstick" onclick="unstickSession(activeTabSessionId);closeViewDropdown('${prefix}')">
            <span class="cmd-name">🚨 Unstick</span><span class="cmd-desc">Send "wait" + Enter</span>
          </div>
          <div class="cmd-dropdown-divider"></div>
          <div class="cmd-dropdown-custom">
            <input type="text" id="${prefix}-cmd-custom-input" placeholder="Custom message..." autocomplete="off"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();sendViewCustomCommand('${prefix}')}">
            <button onclick="sendViewCustomCommand('${prefix}')" class="btn-sm btn-accent">Send</button>
          </div>
        </div>
      </div>
    </div>
    <div class="keys-group">
      <button class="key-btn key-esc" onclick="sendKeyTo(activeTabSessionId,'Escape','${prefix}-terminal')" title="Escape">Esc</button>
      <button class="key-btn key-wide" onclick="sendKeyTo(activeTabSessionId,'Enter','${prefix}-terminal')" title="Enter">Enter &#9166;</button>
    </div>
    <div class="keys-group keys-right">
      <button class="key-btn" onclick="openEditor(activeTabSessionId)" title="Edit files">Edit</button>
    </div>
  `;
}

async function sendKeyTo(sessionId, key, terminalElId) {
  if (!sessionId) return;
  try {
    await api(`/api/sessions/${sessionId}/keys`, {
      method: 'POST',
      body: JSON.stringify({ keys: [key] }),
    });
    const terminal = document.getElementById(terminalElId);
    if (terminal) {
      terminal.style.outline = '1px solid var(--accent)';
      setTimeout(() => { terminal.style.outline = ''; }, 150);
    }
  } catch (e) {
    console.error('Key send error:', e);
  }
}

async function sendCommandTo(sessionId, cmd, statusElId) {
  if (!sessionId || !cmd) return;
  try {
    const result = await api(`/api/sessions/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content: cmd, urgent: false, raw: true, from_client: 'web' }),
    });
    const method = result.delivery_method || (result.delivered ? 'delivered' : 'queued');
    showStatusMsg(statusElId, `Sent "${cmd}" (${method})`, 'success');
  } catch (e) {
    showStatusMsg(statusElId, `Failed: ${e.message}`, 'error');
  }
}

async function sendMessageTo(sessionId, content, statusElId) {
  if (!sessionId || !content) return false;
  try {
    const result = await api(`/api/sessions/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content, urgent: false, from_client: 'web' }),
    });
    const method = result.delivery_method || (result.delivered ? 'delivered' : 'queued');
    showStatusMsg(statusElId, `Sent (${method})`, 'success');
    return true;
  } catch (e) {
    showStatusMsg(statusElId, `Failed: ${e.message}`, 'error');
    return false;
  }
}

function showStatusMsg(elId, text, type) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = `msg-status ${type}`;
  el.classList.remove('hidden');
  if (type !== 'error') setTimeout(() => el.classList.add('hidden'), 3000);
}

// Track loaded line counts per terminal element for lazy loading
const terminalLines = {};
const terminalLoading = {};
const INITIAL_LINES = 200;
const LOAD_MORE_STEP = 500;
const MAX_LINES = 5000;

async function loadTerminalInto(sessionId, preElId, lines) {
  const pre = document.getElementById(preElId);
  if (!pre) return;
  const requestLines = lines || terminalLines[preElId] || INITIAL_LINES;
  try {
    const data = await api(`/api/sessions/${sessionId}/output?lines=${requestLines}`);
    const wasAtBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 50;
    pre.innerHTML = ansiToHtml(data.output || '(empty)');
    terminalLines[preElId] = requestLines;
    if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
    // Attach scroll-to-top loader if not already attached
    if (!pre.dataset.scrollWatch) {
      pre.dataset.scrollWatch = '1';
      pre.addEventListener('scroll', () => onTerminalScroll(pre, preElId, sessionId));
    }
    // Update session ID for scroll handler
    pre.dataset.sessionId = sessionId;
  } catch {
    pre.innerHTML = '(could not capture terminal output)';
  }
}

async function onTerminalScroll(pre, preElId, fallbackSessionId) {
  // Load more when scrolled near the top
  if (pre.scrollTop > 50) return;
  const currentLines = terminalLines[preElId] || INITIAL_LINES;
  if (currentLines >= MAX_LINES) return;
  if (terminalLoading[preElId]) return;

  const sessionId = pre.dataset.sessionId || fallbackSessionId;
  if (!sessionId) return;

  terminalLoading[preElId] = true;
  const newLines = Math.min(currentLines + LOAD_MORE_STEP, MAX_LINES);
  try {
    const data = await api(`/api/sessions/${sessionId}/output?lines=${newLines}`);
    const oldHeight = pre.scrollHeight;
    pre.innerHTML = ansiToHtml(data.output || '(empty)');
    terminalLines[preElId] = newLines;
    // Preserve scroll position: offset by the height difference
    pre.scrollTop = pre.scrollHeight - oldHeight + pre.scrollTop;
  } catch { /* ignore */ }
  terminalLoading[preElId] = false;
}

function toggleViewCommandDropdown(prefix) {
  const dd = document.getElementById(`${prefix}-cmd-dropdown`);
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) {
    const input = document.getElementById(`${prefix}-cmd-custom-input`);
    if (input) input.focus();
  }
}

function closeViewDropdown(prefix) {
  const dd = document.getElementById(`${prefix}-cmd-dropdown`);
  if (dd) dd.classList.add('hidden');
}

function sendViewCustomCommand(prefix) {
  const input = document.getElementById(`${prefix}-cmd-custom-input`);
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  sendCommandTo(activeTabSessionId, cmd, `${prefix}-msg-status`);
  closeViewDropdown(prefix);
}

// ── View Mode ──

function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('fleet_view_mode', mode);

  // Update active button
  document.querySelectorAll('.view-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Show/hide view containers
  document.querySelectorAll('.view-container').forEach(el => el.classList.add('hidden'));
  const container = document.getElementById(`view-${mode}`);
  if (container) container.classList.remove('hidden');

  // Manage view refresh timer
  if (viewRefreshTimer) {
    clearInterval(viewRefreshTimer);
    viewRefreshTimer = null;
  }
  if (mode === 'tab' || mode === 'sidetab') {
    const termId = mode === 'tab' ? 'tab-terminal' : 'sidetab-terminal';
    viewRefreshTimer = setInterval(() => {
      if (activeTabSessionId) loadTerminalInto(activeTabSessionId, termId);
    }, 3000);
  }

  // If in detail view, switch back to dashboard with the current session pre-selected
  if (currentSessionId && (mode === 'tab' || mode === 'sidetab')) {
    activeTabSessionId = currentSessionId;
  }
  if (!document.getElementById('dashboard').classList.contains('hidden')) {
    refreshDashboard();
  } else {
    // Detail view is open — return to dashboard
    showDashboard();
  }
}

// ── Theme ──

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('fleet_theme');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('fleet_theme', 'dark');
  }
  updateThemeToggleIcon();
}

function updateThemeToggleIcon() {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
}

// ── Session Detail ──

async function showSession(sessionId) {
  currentSessionId = sessionId;
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('session-detail').classList.remove('hidden');
  await Promise.all([
    loadSessionDetail(sessionId),
    loadQuestions(sessionId),
    loadOutput(sessionId),
  ]);
}

async function loadSessionDetail(sessionId) {
  try {
    const s = await api(`/api/sessions/${sessionId}`);
    document.getElementById('detail-header').innerHTML = `
      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap">
        <h2 style="font-size:1.2rem;font-weight:600">${esc(s.session_id)}</h2>
        <span class="state state-${s.state}">${s.state}</span>
        <span style="color:var(--text-muted);font-size:0.85rem">${timeAgo(s.last_seen)}</span>
      </div>
      ${s.project_root ? `<p style="color:var(--text-muted);margin-top:4px;font-size:0.9rem">${esc(s.project_root)}</p>` : ''}
      ${s.summary ? `<p style="margin-top:6px">${esc(s.summary)}</p>` : ''}
      ${s.detail ? `<p style="color:var(--text-muted);font-size:0.88rem;margin-top:4px">${esc(s.detail)}</p>` : ''}
    `;

    // Status log
    const logContainer = document.getElementById('status-log');
    const log = s.status_log || [];
    if (log.length === 0) {
      logContainer.innerHTML = '<p style="color:var(--text-muted)">No history yet.</p>';
    } else {
      logContainer.innerHTML = log.map(e => `
        <div class="log-entry">
          <span class="time">${fmtTime(e.timestamp)}</span>
          <span class="state state-${e.state}" style="font-size:0.65rem;padding:1px 6px">${e.state}</span>
          <span class="msg">${esc(e.summary || '')}</span>
        </div>
      `).join('');
    }
  } catch (e) {
    console.error('Session detail error:', e);
  }
}

async function loadQuestions(sessionId) {
  try {
    const questions = await api(`/api/questions/${sessionId}`);
    const container = document.getElementById('questions-container');
    if (questions.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted)">No pending questions.</p>';
      return;
    }
    container.innerHTML = questions.map(q => {
      const items = JSON.parse(q.items);
      return `
        <div class="question-item" data-qid="${q.question_id}">
          ${q.context ? `<div class="q-context">${esc(q.context)}</div>` : ''}
          ${items.map(renderQuestionInput).join('')}
          <button onclick="submitAnswer('${q.question_id}')">Submit Answer</button>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('Questions error:', e);
  }
}

function renderQuestionInput(item) {
  const id = `q-${item.id}`;
  if (item.type === 'confirm') {
    return `<div class="q-text">${esc(item.text)}</div>
            <select id="${id}"><option value="y">Yes</option><option value="n">No</option></select>`;
  } else if (item.type === 'choice' && item.options) {
    const opts = item.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    return `<div class="q-text">${esc(item.text)}</div><select id="${id}">${opts}</select>`;
  } else if (item.type === 'multi_select' && item.options) {
    const opts = item.options.map(o =>
      `<label><input type="checkbox" value="${esc(o)}" class="ms-${item.id}"> ${esc(o)}</label>`
    ).join('');
    return `<div class="q-text">${esc(item.text)}</div><div id="${id}" class="ms-options">${opts}</div>`;
  } else {
    return `<div class="q-text">${esc(item.text)}</div>
            <input id="${id}" type="text" value="${esc(item.default || '')}" placeholder="Type answer...">`;
  }
}

async function submitAnswer(questionId) {
  const container = document.querySelector(`[data-qid="${questionId}"]`);
  const answer = {};

  // Collect all inputs
  container.querySelectorAll('input[type="text"], select').forEach(el => {
    const itemId = el.id.replace('q-', '');
    answer[itemId] = el.value;
  });

  // Collect multi-select checkboxes
  container.querySelectorAll('input[type="checkbox"]:checked').forEach(el => {
    const cls = [...el.classList].find(c => c.startsWith('ms-'));
    if (cls) {
      const itemId = cls.replace('ms-', '');
      if (!answer[itemId]) answer[itemId] = [];
      answer[itemId].push(el.value);
    }
  });

  try {
    await api(`/api/questions/${questionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
    loadQuestions(currentSessionId);
  } catch (e) {
    console.error('Answer error:', e);
  }
}

async function loadOutput(sessionId) {
  // Use shared loader with lazy scroll support
  await loadTerminalInto(sessionId, 'terminal-output');
  // Initial load scrolls to bottom
  const pre = document.getElementById('terminal-output');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

// ── Auto-refresh terminal output ──

function toggleAutoRefresh() {
  if (document.getElementById('auto-refresh-toggle').checked) {
    autoRefreshTimer = setInterval(() => {
      if (currentSessionId) loadOutput(currentSessionId);
    }, 3000);
  } else {
    stopAutoRefresh();
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const toggle = document.getElementById('auto-refresh-toggle');
  if (toggle) toggle.checked = false;
}

// ── Message form ──

document.getElementById('message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const urgent = document.getElementById('msg-urgent').checked;
  const content = input.value.trim();
  if (!content || !currentSessionId) return;

  try {
    const result = await api(`/api/sessions/${currentSessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content, urgent, from_client: 'web' }),
    });
    pushHistory(content);
    input.value = '';
    const method = result.delivery_method || (result.delivered ? 'delivered' : 'queued');
    showMessageStatus(`Sent (${method})`, 'success');
  } catch (e) {
    showMessageStatus(`Failed: ${e.message}`, 'error');
  }
});

function showMessageStatus(text, type) {
  const el = document.getElementById('message-status');
  el.textContent = text;
  el.className = `msg-status ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── Delete session ──

async function deleteCurrentSession() {
  if (!currentSessionId) return;
  if (!confirm(`Stop and remove session "${currentSessionId}"? This will kill the tmux session.`)) return;
  try {
    await api(`/api/sessions/${currentSessionId}`, { method: 'DELETE' });
    clearSessionHistory(currentSessionId);
    showDashboard();
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

// ── Utilities ──

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = (Date.now() - new Date(ts + 'Z').getTime()) / 1000;
  if (diff < 0) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

// ── Multi View ──

let multiRefreshTimer = null;

async function openMultiView() {
  document.getElementById('multi-overlay').classList.remove('hidden');
  await refreshMultiView();
  multiRefreshTimer = setInterval(refreshMultiView, 3000);
}

function closeMultiView() {
  document.getElementById('multi-overlay').classList.add('hidden');
  if (multiRefreshTimer) {
    clearInterval(multiRefreshTimer);
    multiRefreshTimer = null;
  }
}

async function refreshMultiView() {
  try {
    const sessions = await api('/api/sessions');
    const grid = document.getElementById('multi-grid');

    // Calculate grid layout
    const count = sessions.length || 1;
    const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

    // Check if session list changed — only rebuild DOM if needed
    const existingIds = [...grid.querySelectorAll('.multi-pane-terminal')].map(el => el.dataset.sid);
    const newIds = sessions.map(s => s.session_id);
    const needsRebuild = existingIds.length !== newIds.length || existingIds.some((id, i) => id !== newIds[i]);

    if (needsRebuild) {
      grid.innerHTML = sessions.map(s => `
        <div class="multi-pane">
          <div class="multi-pane-header">
            <span class="pane-title">${esc(s.session_id)}</span>
            <span class="state state-${s.state}">${s.state}</span>
          </div>
          <pre class="multi-pane-terminal" data-sid="${s.session_id}" onclick="closeMultiView();openFocus('${s.session_id}')"
               style="cursor:pointer" title="Click to open focused view"></pre>
        </div>
      `).join('');
    } else {
      // Update state badges in-place
      sessions.forEach(s => {
        const pane = grid.querySelector(`[data-sid="${s.session_id}"]`)?.closest('.multi-pane');
        if (!pane) return;
        const badge = pane.querySelector('.state');
        if (badge) {
          badge.textContent = s.state;
          badge.className = `state state-${s.state}`;
        }
      });
    }

    // Load outputs in parallel — update content while preserving scroll
    await Promise.all(sessions.map(async s => {
      const pre = grid.querySelector(`[data-sid="${s.session_id}"]`);
      if (!pre) return;
      try {
        const data = await api(`/api/sessions/${s.session_id}/output`);
        const wasAtBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 50;
        pre.innerHTML = ansiToHtml(data.output || '(empty)');
        if (wasAtBottom || !pre.dataset.loaded) {
          pre.scrollTop = pre.scrollHeight;
          pre.dataset.loaded = '1';
        }
      } catch {
        pre.innerHTML = '(no output)';
      }
    }));
  } catch (e) {
    console.error('Multi view refresh error:', e);
  }
}

// ── Session Focus Modal ──

async function openFocus(sessionId) {
  focusSessionId = sessionId;
  document.getElementById('focus-overlay').classList.remove('hidden');
  const focusInput = document.getElementById('focus-msg-input');
  restoreDraft(focusInput);
  document.getElementById('focus-msg-status').classList.add('hidden');
  document.getElementById('focus-fork-btn').classList.add('hidden');

  // Load session info + output
  try {
    const s = await api(`/api/sessions/${sessionId}`);
    updateFocusHeader(s);
    if (s.claude_session_id) {
      document.getElementById('focus-fork-btn').classList.remove('hidden');
    }
  } catch {}
  await loadFocusOutput();

  // Auto-refresh output every 3s
  focusRefreshTimer = setInterval(loadFocusOutput, 3000);

  // Check for pending questions
  showQuestionModal(sessionId);
}

function updateFocusHeader(s) {
  document.getElementById('focus-name').textContent = s.session_id || focusSessionId;
  const stateEl = document.getElementById('focus-state');
  stateEl.textContent = s.state || '';
  stateEl.className = `state state-${s.state || 'IDLE'}`;
  document.getElementById('focus-summary').textContent = s.summary || '';
}

async function loadFocusOutput() {
  if (!focusSessionId) return;
  await loadTerminalInto(focusSessionId, 'focus-terminal');
}

function closeFocus() {
  saveDraft(document.getElementById('focus-msg-input'));
  focusSessionId = null;
  document.getElementById('focus-overlay').classList.add('hidden');
  if (focusRefreshTimer) {
    clearInterval(focusRefreshTimer);
    focusRefreshTimer = null;
  }
  // Turn off keyboard capture
  keyboardCaptureEnabled = false;
  const toggle = document.getElementById('keyboard-capture-toggle');
  if (toggle) toggle.checked = false;
  const terminal = document.getElementById('focus-terminal');
  terminal.classList.remove('keyboard-active');
}

async function forkFocusSession() {
  if (!focusSessionId) return;
  const newName = prompt(`Fork "${focusSessionId}" — enter a name for the new session:`);
  if (!newName || !newName.trim()) return;

  try {
    await api(`/api/sessions/${focusSessionId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ new_name: newName.trim() }),
    });
    closeFocus();
    refreshDashboard();
    // Open the new forked session after a brief delay for it to register
    setTimeout(() => openFocus(newName.trim()), 1500);
  } catch (e) {
    alert(`Fork failed: ${e.message.replace(/^400:\s*/, '').replace(/^"/, '').replace(/"$/, '')}`);
  }
}

function openDetailFromFocus() {
  if (!focusSessionId) return;
  const sid = focusSessionId;
  closeFocus();
  showSession(sid);
}

async function deleteFocusSession() {
  if (!focusSessionId) return;
  if (!confirm(`Stop and remove session "${focusSessionId}"? This will kill the tmux session.`)) return;
  try {
    await api(`/api/sessions/${focusSessionId}`, { method: 'DELETE' });
    clearSessionHistory(focusSessionId);
    closeFocus();
    refreshDashboard();
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

// ── Raw Key Sending ──

let keyboardCaptureEnabled = false;

async function sendKey(key) {
  if (!focusSessionId) return;
  try {
    await api(`/api/sessions/${focusSessionId}/keys`, {
      method: 'POST',
      body: JSON.stringify({ keys: [key] }),
    });
    // Briefly flash the terminal to show key was sent
    const terminal = document.getElementById('focus-terminal');
    terminal.style.outline = '1px solid var(--accent)';
    setTimeout(() => { terminal.style.outline = ''; }, 150);
  } catch (e) {
    console.error('Key send error:', e);
  }
}

function toggleKeyboardCapture() {
  keyboardCaptureEnabled = document.getElementById('keyboard-capture-toggle').checked;
  const terminal = document.getElementById('focus-terminal');
  if (keyboardCaptureEnabled) {
    terminal.classList.add('keyboard-active');
    terminal.setAttribute('tabindex', '0');
    terminal.focus();
  } else {
    terminal.classList.remove('keyboard-active');
    terminal.removeAttribute('tabindex');
  }
}

// Capture keyboard events when keyboard mode is on and focus modal is open
document.addEventListener('keydown', (e) => {
  if (!keyboardCaptureEnabled || !focusSessionId) return;
  // Don't capture if typing in an input/textarea
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const keyMap = {
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'Enter': 'Enter',
    'Escape': 'Escape',
    'Tab': 'Tab',
    ' ': 'Space',
    'Backspace': 'BSpace',
    'Delete': 'DC',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown',
  };

  // Single character keys: y, n
  const singleKeys = { 'y': 'y', 'n': 'n' };

  const mapped = keyMap[e.key] || singleKeys[e.key];
  if (mapped) {
    e.preventDefault();
    sendKey(mapped);
  }
});

// ── Detail View Keys + Commands ──

async function sendDetailKey(key) {
  if (!currentSessionId) return;
  try {
    await api(`/api/sessions/${currentSessionId}/keys`, {
      method: 'POST',
      body: JSON.stringify({ keys: [key] }),
    });
    const terminal = document.getElementById('terminal-output');
    terminal.style.outline = '1px solid var(--accent)';
    setTimeout(() => { terminal.style.outline = ''; }, 150);
  } catch (e) {
    console.error('Key send error:', e);
  }
}

function toggleDetailCommandDropdown() {
  const dd = document.getElementById('detail-cmd-dropdown');
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) {
    document.getElementById('detail-cmd-custom-input').focus();
  }
}

function closeDetailCommandDropdown() {
  document.getElementById('detail-cmd-dropdown').classList.add('hidden');
}

async function sendDetailCommand(cmd) {
  closeDetailCommandDropdown();
  if (!currentSessionId || !cmd) return;
  try {
    const result = await api(`/api/sessions/${currentSessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content: cmd, urgent: false, raw: true, from_client: 'web' }),
    });
    const method = result.delivery_method || (result.delivered ? 'delivered' : 'queued');
    showMessageStatus(`Sent "${cmd}" (${method})`, 'success');
  } catch (e) {
    showMessageStatus(`Failed: ${e.message}`, 'error');
  }
}

function sendDetailCustomCommand() {
  const input = document.getElementById('detail-cmd-custom-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  sendDetailCommand(cmd);
}

// ── Command Dropdown (raw / no-prefix messages) ──

function toggleCommandDropdown() {
  const dd = document.getElementById('cmd-dropdown');
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) {
    document.getElementById('cmd-custom-input').focus();
  }
}

function closeCommandDropdown() {
  document.getElementById('cmd-dropdown').classList.add('hidden');
}

async function sendCommand(cmd) {
  closeCommandDropdown();
  if (!focusSessionId || !cmd) return;
  try {
    const result = await api(`/api/sessions/${focusSessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content: cmd, urgent: false, raw: true, from_client: 'web' }),
    });
    const method = result.delivery_method || (result.delivered ? 'delivered' : 'queued');
    const el = document.getElementById('focus-msg-status');
    el.textContent = `Sent "${cmd}" (${method})`;
    el.className = 'msg-status success';
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
  } catch (e) {
    const el = document.getElementById('focus-msg-status');
    el.textContent = `Failed: ${e.message}`;
    el.className = 'msg-status error';
    el.classList.remove('hidden');
  }
}

function sendCustomCommand() {
  const input = document.getElementById('cmd-custom-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  sendCommand(cmd);
}

// Close all command dropdowns when clicking outside
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.cmd-dropdown-wrapper')) {
    document.querySelectorAll('.cmd-dropdown:not(.hidden)').forEach(dd => dd.classList.add('hidden'));
  }
});

document.getElementById('focus-message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('focus-msg-input');
  const content = input.value.trim();
  if (!content || !focusSessionId) return;

  try {
    const result = await api(`/api/sessions/${focusSessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content, urgent: false, from_client: 'web' }),
    });
    pushHistory(content);
    input.value = '';
    const method = result.delivery_method || (result.delivered ? 'delivered' : 'queued');
    const el = document.getElementById('focus-msg-status');
    el.textContent = `Sent (${method})`;
    el.className = 'msg-status success';
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
  } catch (e) {
    const el = document.getElementById('focus-msg-status');
    el.textContent = `Failed: ${e.message}`;
    el.className = 'msg-status error';
    el.classList.remove('hidden');
  }
});

// ── Question Modal ──

async function showQuestionModal(sessionId) {
  try {
    const questions = await api(`/api/questions/${sessionId}`);
    if (questions.length === 0) return;

    document.getElementById('qm-session').textContent = sessionId;
    const container = document.getElementById('qm-questions');
    container.innerHTML = questions.map(q => {
      const items = JSON.parse(q.items);
      return `
        <div class="question-item" data-qid="${q.question_id}">
          ${q.context ? `<div class="q-context">${esc(q.context)}</div>` : ''}
          ${items.map(renderQuestionInput).join('')}
          <button onclick="submitFocusAnswer('${q.question_id}')">Submit Answer</button>
        </div>
      `;
    }).join('');
    document.getElementById('question-overlay').classList.remove('hidden');
  } catch {}
}

function closeQuestionModal() {
  document.getElementById('question-overlay').classList.add('hidden');
}

async function submitFocusAnswer(questionId) {
  const container = document.querySelector(`#qm-questions [data-qid="${questionId}"]`);
  const answer = {};

  container.querySelectorAll('input[type="text"], select').forEach(el => {
    const itemId = el.id.replace('q-', '');
    answer[itemId] = el.value;
  });
  container.querySelectorAll('input[type="checkbox"]:checked').forEach(el => {
    const cls = [...el.classList].find(c => c.startsWith('ms-'));
    if (cls) {
      const itemId = cls.replace('ms-', '');
      if (!answer[itemId]) answer[itemId] = [];
      answer[itemId].push(el.value);
    }
  });

  try {
    await api(`/api/questions/${questionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
    // Refresh — if no more questions, close modal
    const remaining = await api(`/api/questions/${focusSessionId}`);
    if (remaining.length === 0) {
      closeQuestionModal();
    } else {
      showQuestionModal(focusSessionId);
    }
  } catch (e) {
    console.error('Answer error:', e);
  }
}

// ── New Session ──

function showNewSessionModal() {
  document.getElementById('new-session-overlay').classList.remove('hidden');
  document.getElementById('ns-project').value = '';
  document.getElementById('ns-name').value = '';
  document.getElementById('ns-error').classList.add('hidden');
  hidePathAutocomplete();
  document.getElementById('ns-project').focus();
}

function hideNewSessionModal() {
  document.getElementById('new-session-overlay').classList.add('hidden');
  hidePathAutocomplete();
}

function autoFillSessionName() {
  const nameInput = document.getElementById('ns-name');
  // Only auto-fill if user hasn't manually typed a name
  if (nameInput.dataset.manual) return;
  const project = document.getElementById('ns-project').value.trim().replace(/\/+$/, '');
  const parts = project.split('/');
  nameInput.placeholder = parts[parts.length - 1] || '(auto from path)';
}

// Track if user manually edited the name field
document.getElementById('ns-name').addEventListener('input', function() {
  this.dataset.manual = this.value.trim() ? '1' : '';
});

// ── Path Autocomplete ──

let pathCompleteTimer = null;
let pathActiveIndex = -1;

function onPathInput() {
  clearTimeout(pathCompleteTimer);
  pathCompleteTimer = setTimeout(fetchPathCompletions, 200);
}

async function fetchPathCompletions() {
  const input = document.getElementById('ns-project');
  const path = input.value;
  if (!path || !path.startsWith('/')) {
    hidePathAutocomplete();
    return;
  }

  try {
    const data = await api(`/api/filesystem/complete?path=${encodeURIComponent(path)}`);
    const entries = data.entries || [];
    if (entries.length === 0) {
      hidePathAutocomplete();
      return;
    }
    showPathAutocomplete(entries);
  } catch {
    hidePathAutocomplete();
  }
}

function showPathAutocomplete(entries) {
  const dropdown = document.getElementById('path-autocomplete');
  pathActiveIndex = -1;
  dropdown.innerHTML = entries.map((e, i) => `
    <div class="path-autocomplete-item" data-path="${esc(e.path)}" data-index="${i}"
         onmousedown="selectPathEntry('${esc(e.path).replace(/'/g, "\\'")}')">
      <span class="dir-icon">/</span>${esc(e.name)}
    </div>
  `).join('');
  dropdown.classList.remove('hidden');
}

function hidePathAutocomplete() {
  const dropdown = document.getElementById('path-autocomplete');
  dropdown.classList.add('hidden');
  dropdown.innerHTML = '';
  pathActiveIndex = -1;
}

function selectPathEntry(path) {
  const input = document.getElementById('ns-project');
  input.value = path + '/';
  hidePathAutocomplete();
  autoFillSessionName();
  input.focus();
  // Trigger another completion for the next level
  clearTimeout(pathCompleteTimer);
  pathCompleteTimer = setTimeout(fetchPathCompletions, 100);
}

// Keyboard navigation for autocomplete
document.getElementById('ns-project').addEventListener('keydown', (e) => {
  const dropdown = document.getElementById('path-autocomplete');
  if (dropdown.classList.contains('hidden')) {
    // Tab triggers completion when dropdown is closed
    if (e.key === 'Tab') {
      e.preventDefault();
      fetchPathCompletions();
    }
    return;
  }

  const items = dropdown.querySelectorAll('.path-autocomplete-item');
  if (items.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    pathActiveIndex = Math.min(pathActiveIndex + 1, items.length - 1);
    updateActiveItem(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    pathActiveIndex = Math.max(pathActiveIndex - 1, 0);
    updateActiveItem(items);
  } else if (e.key === 'Enter' && pathActiveIndex >= 0) {
    e.preventDefault();
    selectPathEntry(items[pathActiveIndex].dataset.path);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    // Tab selects the first (or currently highlighted) entry
    const idx = pathActiveIndex >= 0 ? pathActiveIndex : 0;
    selectPathEntry(items[idx].dataset.path);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hidePathAutocomplete();
  }
});

function updateActiveItem(items) {
  items.forEach((el, i) => {
    el.classList.toggle('active', i === pathActiveIndex);
    if (i === pathActiveIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

// Hide autocomplete when clicking outside
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.path-autocomplete-wrapper')) {
    hidePathAutocomplete();
  }
});

document.getElementById('new-session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('ns-error');
  const submitBtn = document.getElementById('ns-submit');
  errorEl.classList.add('hidden');

  const project = document.getElementById('ns-project').value.trim();
  const name = document.getElementById('ns-name').value.trim();

  if (!project) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Starting...';

  try {
    await api('/api/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ project, name }),
    });
    hideNewSessionModal();
    refreshDashboard();
  } catch (e) {
    errorEl.textContent = e.message.replace(/^400:\s*/, '').replace(/^"/, '').replace(/"$/, '');
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Start';
  }
});

// ── Auth / Login ──

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('login-token').focus();
}

function hideLogin() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('login-error').classList.add('hidden');
  document.getElementById('login-token').value = '';
}

function logout() {
  localStorage.removeItem('fleet_auth_token');
  if (ws) ws.close();
  document.getElementById('logout-btn').classList.add('hidden');
  document.getElementById('app-header').classList.add('hidden');
  document.getElementById('app-main').classList.add('hidden');
  showLogin();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('login-token').value.trim();
  if (!token) return;

  const res = await fetch('/api/auth/check', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.valid) {
    localStorage.setItem('fleet_auth_token', token);
    hideLogin();
    startApp();
  } else {
    document.getElementById('login-error').classList.remove('hidden');
  }
});

async function checkAuth() {
  const res = await fetch('/api/auth/check');
  const data = await res.json();
  authRequired = data.auth_required;

  if (!authRequired) {
    startApp();
    return;
  }

  document.getElementById('logout-btn').classList.remove('hidden');

  const token = getAuthToken();
  if (!token) {
    showLogin();
    return;
  }

  // Validate stored token
  const vRes = await fetch('/api/auth/check', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const vData = await vRes.json();
  if (vData.valid) {
    startApp();
  } else {
    localStorage.removeItem('fleet_auth_token');
    showLogin();
  }
}

function startApp() {
  document.getElementById('app-header').classList.remove('hidden');
  document.getElementById('app-main').classList.remove('hidden');
  if (authRequired) {
    document.getElementById('logout-btn').classList.remove('hidden');
  }
  // Initialize view mode from localStorage (calls refreshDashboard internally)
  setViewMode(viewMode);
  updateThemeToggleIcon();
  connectWS();
}

// ── Init ──

checkAuth();

// Auto-refresh dashboard every 30s as fallback
setInterval(() => {
  if (!document.getElementById('login-overlay').classList.contains('hidden')) return;
  refreshDashboard();
}, 30000);

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// ── Tab/Sidetab form listeners ──

document.getElementById('tab-message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('tab-msg-input');
  const content = input.value.trim();
  if (!content || !activeTabSessionId) return;
  if (await sendMessageTo(activeTabSessionId, content, 'tab-msg-status')) {
    pushHistory(content);
    input.value = '';
  }
});

document.getElementById('sidetab-message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('sidetab-msg-input');
  const content = input.value.trim();
  if (!content || !activeTabSessionId) return;
  if (await sendMessageTo(activeTabSessionId, content, 'sidetab-msg-status')) {
    pushHistory(content);
    input.value = '';
  }
});

// ── Unstick Session ──

async function unstickSession(sessionId) {
  if (!sessionId) return;
  if (!confirm(`Send "wait" + Enter to "${sessionId}" to unstick it?\n\nUse this when a session finished or was canceled but didn't report status, leaving messages queued.`)) return;
  try {
    await api(`/api/sessions/${sessionId}/unstick`, { method: 'POST' });
    showStatusMsg('focus-msg-status', `Unstick sent to ${sessionId}`, 'success');
  } catch (e) {
    alert(`Unstick failed: ${e.message}`);
  }
}

// ── File Editor ──

let editorSessionId = null;
let editorProjectRoot = null;
let editorRelPath = '';
let editorFilePath = null;
let editorOrigContent = null;
let editorWritable = false;

function openEditor(sessionId) {
  if (!sessionId) return;
  editorSessionId = sessionId;
  editorFilePath = null;
  editorOrigContent = null;
  document.getElementById('editor-overlay').classList.remove('hidden');
  document.getElementById('editor-session-name').textContent = sessionId;
  document.getElementById('editor-permission').className = 'editor-perm';
  document.getElementById('editor-permission').textContent = '';
  document.getElementById('editor-picker').classList.remove('hidden');
  document.getElementById('editor-content').classList.add('hidden');
  document.getElementById('editor-save-btn').disabled = true;
  document.getElementById('editor-status').classList.add('hidden');
  editorBrowse('');
}

function closeEditor() {
  if (editorFilePath && editorIsDirty()) {
    if (!confirm('You have unsaved changes. Close anyway?')) return;
  }
  editorSessionId = null;
  editorFilePath = null;
  editorOrigContent = null;
  document.getElementById('editor-overlay').classList.add('hidden');
}

async function editorBrowse(relPath) {
  editorRelPath = relPath;
  const showHidden = document.getElementById('editor-show-hidden').checked;
  try {
    const data = await api(`/api/filesystem/list?session_id=${encodeURIComponent(editorSessionId)}&path=${encodeURIComponent(relPath)}&show_hidden=${showHidden}`);
    editorProjectRoot = data.project_root;
    document.getElementById('editor-up-btn').disabled = data.parent_path === null;
    document.getElementById('editor-cwd').textContent = data.current_path || '/';
    editorRenderBreadcrumb(data.current_path || '');
    editorRenderFileList(data.entries);
  } catch (e) {
    editorShowStatus(`Error: ${e.message}`, 'error');
  }
}

function editorRenderBreadcrumb(currentPath) {
  const parts = currentPath ? currentPath.split('/') : [];
  const projectName = editorProjectRoot ? editorProjectRoot.split('/').pop() : '';
  let html = `<span onclick="editorBrowse('')">${esc(projectName)}</span>`;
  let accumulated = '';
  for (const part of parts) {
    accumulated += (accumulated ? '/' : '') + part;
    const p = accumulated;
    html += ` / <span onclick="editorBrowse('${esc(p)}')">${esc(part)}</span>`;
  }
  document.getElementById('editor-breadcrumb').innerHTML = html;
}

function editorRenderFileList(entries) {
  const list = document.getElementById('editor-file-list');
  if (entries.length === 0) {
    list.innerHTML = '<div style="padding:1rem;color:var(--text-muted);text-align:center">(empty directory)</div>';
    return;
  }
  list.innerHTML = entries.map(e => {
    const isDir = e.type === 'dir';
    const icon = isDir ? '/' : '~';
    const size = !isDir && e.size != null ? fmtFileSize(e.size) : '';
    const lock = !isDir && e.writable === false ? '<span class="file-lock">ro</span>' : '';
    const nameClass = isDir ? 'file-name is-dir' : 'file-name';
    const path = editorRelPath ? editorRelPath + '/' + e.name : e.name;
    const onclick = isDir
      ? `editorBrowse('${esc(path)}')`
      : `editorOpenFile('${esc(path)}')`;
    return `<div class="editor-file-item" onclick="${onclick}">
      <span class="file-icon">${icon}</span>
      <span class="${nameClass}">${esc(e.name)}</span>
      ${lock}
      <span class="file-size">${size}</span>
    </div>`;
  }).join('');
}

function fmtFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function editorNavigateUp() {
  if (!editorRelPath) return;
  const parts = editorRelPath.split('/');
  parts.pop();
  editorBrowse(parts.join('/'));
}

function editorRefreshDir() {
  editorBrowse(editorRelPath);
}

async function editorOpenFile(relPath) {
  try {
    const data = await api(`/api/filesystem/read?session_id=${encodeURIComponent(editorSessionId)}&path=${encodeURIComponent(relPath)}`);
    editorFilePath = data.path;
    editorOrigContent = data.content;
    editorWritable = data.writable;

    document.getElementById('editor-picker').classList.add('hidden');
    document.getElementById('editor-content').classList.remove('hidden');
    document.getElementById('editor-textarea').value = data.content;
    document.getElementById('editor-filename').textContent = data.path.split('/').pop();
    document.getElementById('editor-size').textContent = fmtFileSize(data.size);
    document.getElementById('editor-dirty').classList.add('hidden');

    const permEl = document.getElementById('editor-permission');
    if (data.writable) {
      permEl.textContent = 'rw';
      permEl.className = 'editor-perm rw';
    } else {
      permEl.textContent = 'read-only';
      permEl.className = 'editor-perm ro';
    }
    document.getElementById('editor-save-btn').disabled = !data.writable;
    document.getElementById('editor-status').classList.add('hidden');
  } catch (e) {
    editorShowStatus(`Cannot open: ${e.message.replace(/^\d+:\s*/, '')}`, 'error');
  }
}

function editorBackToPicker() {
  if (editorFilePath && editorIsDirty()) {
    if (!confirm('You have unsaved changes. Go back anyway?')) return;
  }
  editorFilePath = null;
  editorOrigContent = null;
  document.getElementById('editor-content').classList.add('hidden');
  document.getElementById('editor-picker').classList.remove('hidden');
  document.getElementById('editor-permission').className = 'editor-perm';
  document.getElementById('editor-permission').textContent = '';
  editorRefreshDir();
}

async function editorSave() {
  if (!editorFilePath || !editorWritable) return;
  const content = document.getElementById('editor-textarea').value;
  try {
    const data = await api('/api/filesystem/write', {
      method: 'POST',
      body: JSON.stringify({
        session_id: editorSessionId,
        path: editorFilePath,
        content,
      }),
    });
    editorOrigContent = content;
    document.getElementById('editor-dirty').classList.add('hidden');
    document.getElementById('editor-size').textContent = fmtFileSize(data.size);
    editorShowStatus(`Saved (${fmtFileSize(data.size)})`, 'success');
  } catch (e) {
    editorShowStatus(`Save failed: ${e.message.replace(/^\d+:\s*/, '')}`, 'error');
  }
}

function editorIsDirty() {
  if (!editorFilePath || editorOrigContent === null) return false;
  return document.getElementById('editor-textarea').value !== editorOrigContent;
}

function editorCheckDirty() {
  const dirty = editorIsDirty();
  const badge = document.getElementById('editor-dirty');
  if (dirty) badge.classList.remove('hidden');
  else badge.classList.add('hidden');
}

function editorShowStatus(text, type) {
  const el = document.getElementById('editor-status');
  el.textContent = text;
  el.className = `msg-status ${type}`;
  el.classList.remove('hidden');
  if (type !== 'error') setTimeout(() => el.classList.add('hidden'), 3000);
}

// Dirty detection on textarea input
document.getElementById('editor-textarea').addEventListener('input', editorCheckDirty);

// Ctrl+S / Cmd+S to save
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    if (!document.getElementById('editor-overlay').classList.contains('hidden')) {
      e.preventDefault();
      editorSave();
    }
  }
});
