const vscode = acquireVsCodeApi();
const session = document.getElementById('session');
const activity = document.getElementById('activity');
const subagentTracking = document.getElementById('subagent-tracking');
const autoApproveEdits = document.getElementById('auto-approve-edits');
const messages = document.getElementById('messages');
const form = document.getElementById('form');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
let activeAgentMessage;
let activeAgentText = '';
let promptRunning = false;
const toolElements = new Map();
const subagentElements = new Map();

function append(role, text) {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  renderMessage(message, role, text);
  messages.appendChild(message);
  moveActivityToEnd();
  messages.scrollTop = messages.scrollHeight;
  return message;
}

function renderMessage(message, role, text) {
  if (role !== 'agent') {
    message.textContent = text;
    return;
  }
  message.innerHTML = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } });
}

function appendAgentText(text) {
  if (!activeAgentMessage) {
    activeAgentMessage = append('agent', '');
    activeAgentText = '';
  }
  activeAgentText += text;
  renderMessage(activeAgentMessage, 'agent', activeAgentText);
  messages.scrollTop = messages.scrollHeight;
}

function appendMessage(role, text) {
  if (role === 'agent') {
    activeAgentMessage = append('agent', text);
    activeAgentText = text;
    return;
  }
  activeAgentMessage = undefined;
  activeAgentText = '';
  append(role, text);
}

function appendTool(tool) {
  activeAgentMessage = undefined;
  activeAgentText = '';
  const card = document.createElement('details');
  card.className = 'tool';
  toolElements.set(tool.toolCallId, card);
  renderTool(card, tool);
  messages.appendChild(card);
  moveActivityToEnd();
  messages.scrollTop = messages.scrollHeight;
}

function updateTool(tool) {
  const card = toolElements.get(tool.toolCallId);
  if (!card) {
    appendTool(tool);
    return;
  }
  renderTool(card, tool);
}

function appendSubagent(subagent) {
  activeAgentMessage = undefined;
  activeAgentText = '';
  const row = document.createElement('div');
  subagentElements.set(subagent.subagentId, row);
  renderSubagent(row, subagent);
  messages.appendChild(row);
  moveActivityToEnd();
  messages.scrollTop = messages.scrollHeight;
}

function updateSubagent(subagent) {
  const row = subagentElements.get(subagent.subagentId);
  if (!row) {
    appendSubagent(subagent);
    return;
  }
  renderSubagent(row, subagent);
}

function renderSubagent(row, subagent) {
  row.replaceChildren();
  row.className = `subagent ${subagent.status}`;
  const label = document.createElement('span');
  label.className = 'subagent-label';
  label.textContent = subagent.title;
  const state = document.createElement('span');
  state.className = 'subagent-state';
  state.textContent = subagent.summary ?? subagent.activity ?? subagent.status;
  row.appendChild(label);
  row.appendChild(state);
}

function renderTool(card, tool) {
  card.replaceChildren();
  const summary = document.createElement('summary');
  summary.className = `tool-summary ${tool.status ?? 'pending'}`;
  summary.textContent = `${toolStatusLabel(tool.status)} · ${tool.title}`;
  card.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'tool-body';
  if (tool.name || tool.kind) {
    const metadata = document.createElement('div');
    metadata.className = 'tool-metadata';
    metadata.textContent = [tool.kind, tool.name].filter(Boolean).join(' · ');
    body.appendChild(metadata);
  }
  for (const content of tool.content ?? []) {
    const output = document.createElement('pre');
    output.className = `tool-content ${content.type}`;
    if (content.type === 'diff') {
      output.textContent = `--- ${content.path}\n+++ ${content.path}\n-${content.oldText ?? ''}\n+${content.newText ?? ''}`;
    } else if (content.type === 'terminal') {
      output.textContent = `Terminal: ${content.terminalId}`;
    } else {
      output.textContent = content.text ?? '';
    }
    body.appendChild(output);
  }
  for (const location of tool.locations ?? []) {
    const button = document.createElement('button');
    button.className = 'tool-location';
    button.type = 'button';
    button.textContent = `${location.path}${location.line ? `:${location.line}` : ''}`;
    button.addEventListener('click', () => vscode.postMessage({ type: 'open-location', path: location.path, line: location.line }));
    body.appendChild(button);
  }
  card.appendChild(body);
}

function toolStatusLabel(status) {
  if (status === 'pending') {
    return '⏳';
  }
  if (status === 'in_progress') {
    return '⚙️';
  }
  if (status === 'completed') {
    return '✅';
  }
  if (status === 'failed') {
    return '❌';
  }
  return status ?? 'pending';
}

function setActivity(text) {
  activity.hidden = !text;
  activity.textContent = text ?? '';
  moveActivityToEnd();
  messages.scrollTop = messages.scrollHeight;
}

function setSubagentTracking(status) {
  subagentTracking.hidden = !status;
  subagentTracking.className = `subagent-tracking${status ? ` ${status.kind}` : ''}`;
  subagentTracking.textContent = status?.message ?? '';
}

function moveActivityToEnd() {
  if (!activity.hidden) {
    messages.appendChild(activity);
  }
}

function setPromptRunning(running) {
  promptRunning = running;
  send.textContent = running ? 'Stop' : 'Send';
  send.className = running ? 'stop' : '';
}

function restore(message) {
  messages.replaceChildren();
  activeAgentMessage = undefined;
  activeAgentText = '';
  toolElements.clear();
  subagentElements.clear();
  setActivity();
  setSubagentTracking(message.subagentTracking);
  autoApproveEdits.checked = Boolean(message.autoApproveEdits);
  autoApproveEdits.disabled = false;
  session.textContent = `Session: ${message.title ?? 'Untitled session'} (${message.sessionId})`;
  for (const entry of message.entries) {
    if (entry.toolCallId) {
      appendTool(entry);
    } else if (entry.subagentId) {
      appendSubagent(entry);
    } else {
      appendMessage(entry.role, entry.text);
    }
  }
  prompt.disabled = false;
  setPromptRunning(false);
  send.disabled = false;
  prompt.focus();
}

function sendPrompt() {
  const text = prompt.value.trim();
  if (!text || promptRunning || send.disabled) {
    return;
  }

  prompt.value = '';
  setPromptRunning(true);
  send.disabled = false;
  vscode.postMessage({ type: 'prompt', text });
}

function cancelPrompt() {
  if (!promptRunning || send.disabled) {
    return;
  }
  send.disabled = true;
  vscode.postMessage({ type: 'cancel' });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (promptRunning) {
    cancelPrompt();
  } else {
    sendPrompt();
  }
});

prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  event.preventDefault();
  sendPrompt();
});

autoApproveEdits.addEventListener('change', () => {
  vscode.postMessage({ type: 'auto-approve-edits', enabled: autoApproveEdits.checked });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'restore') {
    restore(message);
  }
  if (message.type === 'message') {
    appendMessage(message.role, message.text);
  }
  if (message.type === 'text') {
    appendAgentText(message.text);
  }
  if (message.type === 'tool') {
    appendTool(message.tool);
  }
  if (message.type === 'tool-update') {
    updateTool(message.tool);
  }
  if (message.type === 'subagent') {
    appendSubagent(message.subagent);
  }
  if (message.type === 'subagent-update') {
    updateSubagent(message.subagent);
  }
  if (message.type === 'activity') {
    setActivity(message.text);
  }
  if (message.type === 'subagent-tracking') {
    setSubagentTracking(message.status);
  }
  if (message.type === 'auto-approve-edits') {
    autoApproveEdits.checked = Boolean(message.enabled);
  }

  if (message.type === 'ready') {
    setPromptRunning(false);
    send.disabled = false;
    prompt.focus();
  }
  if (message.type === 'error') {
    activeAgentMessage = undefined;
    append('error', `Hermes request failed: ${message.text}`);
    setPromptRunning(false);
    send.disabled = false;
    prompt.focus();
  }
  if (message.type === 'disconnected') {
    activeAgentMessage = undefined;
    setActivity();
    setSubagentTracking();
    subagentElements.clear();
    session.textContent = `Disconnected: ${message.text}`;
    prompt.disabled = true;
    setPromptRunning(false);
    send.disabled = true;
    autoApproveEdits.checked = false;
    autoApproveEdits.disabled = true;
  }
});
