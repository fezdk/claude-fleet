// Fleet Manager — Web UI client

const API = '';
let ws = null;
let currentSessionId = null;
let autoRefreshTimer = null;
let pendingQuestionsMap = {};  // session_id -> count
let authRequired = false;
let focusSessionId = null;
let focusRefreshTimer = null;

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
    document.getElementById('ws-status').textContent = 'live';
    document.getElementById('ws-status').className = 'badge badge-connected';
  };

  ws.onclose = () => {
    document.getElementById('ws-status').textContent = 'disconnected';
    document.getElementById('ws-status').className = 'badge badge-disconnected';
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

// ── Dashboard ──

async function refreshDashboard() {
  try {
    const [sessions, questions] = await Promise.all([
      api('/api/sessions'),
      api('/api/questions?pending=true'),
    ]);

    // Update session count
    document.getElementById('session-count').textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

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

    // Render sessions
    const container = document.getElementById('sessions-list');
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
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('Dashboard refresh error:', e);
  }
}

function showDashboard() {
  currentSessionId = null;
  stopAutoRefresh();
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('session-detail').classList.add('hidden');
  refreshDashboard();
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
  const pre = document.getElementById('terminal-output');
  try {
    const data = await api(`/api/sessions/${sessionId}/output`);
    pre.textContent = data.output || '(empty)';
    pre.scrollTop = pre.scrollHeight;
  } catch {
    pre.textContent = '(could not capture terminal output)';
  }
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

    // Build panes (preserve scroll positions)
    const existingPanes = {};
    grid.querySelectorAll('.multi-pane-terminal').forEach(el => {
      existingPanes[el.dataset.sid] = el.scrollTop;
    });

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

    // Load outputs in parallel
    await Promise.all(sessions.map(async s => {
      const pre = grid.querySelector(`[data-sid="${s.session_id}"]`);
      if (!pre) return;
      try {
        const data = await api(`/api/sessions/${s.session_id}/output`);
        pre.textContent = data.output || '(empty)';
        // Restore scroll or scroll to bottom
        if (existingPanes[s.session_id] !== undefined) {
          pre.scrollTop = existingPanes[s.session_id];
        } else {
          pre.scrollTop = pre.scrollHeight;
        }
      } catch {
        pre.textContent = '(no output)';
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
  document.getElementById('focus-msg-input').value = '';
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
  const pre = document.getElementById('focus-terminal');
  try {
    const data = await api(`/api/sessions/${focusSessionId}/output`);
    const wasAtBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 50;
    pre.textContent = data.output || '(empty)';
    if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
  } catch {
    pre.textContent = '(could not capture terminal output)';
  }
}

function closeFocus() {
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

async function deleteFocusSession() {
  if (!focusSessionId) return;
  if (!confirm(`Stop and remove session "${focusSessionId}"? This will kill the tmux session.`)) return;
  try {
    await api(`/api/sessions/${focusSessionId}`, { method: 'DELETE' });
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
  document.getElementById('ns-project').focus();
}

function hideNewSessionModal() {
  document.getElementById('new-session-overlay').classList.add('hidden');
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
  if (authRequired) {
    document.getElementById('logout-btn').classList.remove('hidden');
  }
  connectWS();
  refreshDashboard();
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
