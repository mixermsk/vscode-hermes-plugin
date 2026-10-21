const vscode = acquireVsCodeApi();
const session = document.getElementById('session');
const activity = document.getElementById('activity');
const messages = document.getElementById('messages');
const form = document.getElementById('form');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
let activeAgentMessage;
let activeAgentText = '';
const toolElements = new Map();

function append(role, text) {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  renderMessage(message, role, text);
  messages.appendChild(message);
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

function renderTool(card, tool) {
  card.replaceChildren();
  const summary = document.createElement('summary');
  summary.className = `tool-summary ${tool.status ?? 'pending'}`;
  summary.textContent = `${tool.status ?? 'pending'} · ${tool.title}`;
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

function setActivity(text) {
  activity.hidden = !text;
  activity.textContent = text ?? '';
}

function restore(message) {
  messages.replaceChildren();
  activeAgentMessage = undefined;
  activeAgentText = '';
  toolElements.clear();
  setActivity();
  session.textContent = `Session: ${message.title ?? 'Untitled session'} (${message.sessionId})`;
  for (const entry of message.entries) {
    if (entry.toolCallId) {
      appendTool(entry);
    } else {
      appendMessage(entry.role, entry.text);
    }
  }
  prompt.disabled = false;
  send.disabled = false;
  prompt.focus();
}

function sendPrompt() {
  const text = prompt.value.trim();
  if (!text || send.disabled) {
    return;
  }

  prompt.value = '';
  send.disabled = true;
  vscode.postMessage({ type: 'prompt', text });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendPrompt();
});

prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  event.preventDefault();
  sendPrompt();
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
  if (message.type === 'activity') {
    setActivity(message.text);
  }
  if (message.type === 'ready') {
    send.disabled = false;
    prompt.focus();
  }
  if (message.type === 'error') {
    activeAgentMessage = undefined;
    append('error', `Hermes request failed: ${message.text}`);
    send.disabled = false;
    prompt.focus();
  }
  if (message.type === 'disconnected') {
    activeAgentMessage = undefined;
    setActivity();
    session.textContent = `Disconnected: ${message.text}`;
    prompt.disabled = true;
    send.disabled = true;
  }
});
