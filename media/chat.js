const vscode = acquireVsCodeApi();
const session = document.getElementById('session');
const activity = document.getElementById('activity');
const subagentTracking = document.getElementById('subagent-tracking');
const messages = document.getElementById('messages');
const form = document.getElementById('form');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const model = document.getElementById('model');
const reasoning = document.getElementById('reasoning');
let activeAgentMessage;
let activeAgentText = '';
let promptRunning = false;
let modelChoices = [];
const toolElements = new Map();
const subagentElements = new Map();

const REASONING_LEVELS = [
  { value: 'none', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' }
];

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
  const row = document.createElement('details');
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
  const summary = document.createElement('summary');
  summary.className = 'subagent-summary';
  const label = document.createElement('span');
  label.className = 'subagent-label';
  label.textContent = subagent.title;
  const state = document.createElement('span');
  state.className = 'subagent-state';
  state.textContent = subagent.summary ?? subagent.activity ?? subagent.status;
  summary.appendChild(label);
  summary.appendChild(state);
  row.appendChild(summary);
  if (subagent.details) {
    const body = document.createElement('div');
    body.className = 'subagent-body';
    body.textContent = subagent.details;
    row.appendChild(body);
  }
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

function renderModelOptions(options) {
  modelChoices = [];
  model.replaceChildren();
  for (const provider of options.providers ?? []) {
    for (const name of provider.models ?? []) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = `${provider.name || provider.slug} / ${name}`;
      modelChoices.push({ model: name, provider: provider.slug, isCurrent: Boolean(provider.isCurrent) });
      model.appendChild(option);
    }
  }
  if (options.model) {
    let index = modelChoices.findIndex((choice) => choice.isCurrent && choice.model === options.model);
    if (index === -1) {
      index = modelChoices.findIndex((choice) => choice.model === options.model);
    }
    model.selectedIndex = index;
  }
  model.disabled = false;
}

function clearModelOptions() {
  modelChoices = [];
  model.replaceChildren();
  model.selectedIndex = -1;
  model.disabled = true;
}

function setReasoning(effort) {
  reasoning.replaceChildren();
  const levels = REASONING_LEVELS.some((level) => level.value === effort)
    ? REASONING_LEVELS
    : [...REASONING_LEVELS, { value: effort, label: effort }];
  for (const level of levels) {
    const option = document.createElement('option');
    option.value = level.value;
    option.textContent = level.label;
    reasoning.appendChild(option);
  }
  reasoning.value = effort || 'medium';
  reasoning.disabled = false;
}

function clearReasoning() {
  reasoning.replaceChildren();
  reasoning.value = '';
  reasoning.disabled = true;
}

function restore(message) {
  messages.replaceChildren();
  activeAgentMessage = undefined;
  activeAgentText = '';
  toolElements.clear();
  subagentElements.clear();
  setActivity();
  setSubagentTracking(message.subagentTracking);
  if (message.modelOptions) {
    renderModelOptions(message.modelOptions);
  }
  if (message.reasoning !== undefined) {
    setReasoning(message.reasoning);
  }
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
model.addEventListener('change', () => {
  const choice = modelChoices[model.selectedIndex];
  if (!choice) {
    return;
  }
  vscode.postMessage({ type: 'select-model', model: choice.model, provider: choice.provider });
});

reasoning.addEventListener('change', () => {
  vscode.postMessage({ type: 'select-reasoning', effort: reasoning.value });
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
  if (message.type === 'model-options') {
    renderModelOptions(message);
  }
  if (message.type === 'reasoning') {
    setReasoning(message.effort);
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
    clearModelOptions();
    clearReasoning();
  }
});
