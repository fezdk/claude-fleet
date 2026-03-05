// Fleet Manager — Web UI client

const API = '';
let ws = null;
let currentSessionId = null;
let autoRefreshTimer = null;
let pendingQuestionsMap = {};  // session_id -> count

// ── WebSocket ──

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

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
  } else if (event === 'question:new') {
    refreshDashboard();
    if (currentSessionId && data.session_id === currentSessionId) {
      loadQuestions(currentSessionId);
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
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
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
        <div class="session-card${hasQ ? ' has-question' : ''}" onclick="showSession('${s.session_id}')">
          ${hasQ ? `<span class="question-badge">${qCount} ?</span>` : ''}
          <div class="row">
            <span class="name">${esc(s.session_id)}</span>
            <span class="state state-${s.state}">${s.state}</span>
          </div>
          <div class="summary">${esc(s.summary || 'No status reported')}</div>
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
  if (!confirm(`Remove session "${currentSessionId}" from fleet manager?`)) return;
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

// ── Init ──

connectWS();
refreshDashboard();

// Auto-refresh dashboard every 30s as fallback
setInterval(refreshDashboard, 30000);

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}
