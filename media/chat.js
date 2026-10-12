const vscode = acquireVsCodeApi();
const session = document.getElementById('session');
const messages = document.getElementById('messages');
const form = document.getElementById('form');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
let activeAgentMessage;

function append(role, text) {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  message.textContent = text;
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
  return message;
}

function appendAgentText(text) {
  if (!activeAgentMessage) {
    activeAgentMessage = append('agent', '');
  }
  activeAgentMessage.textContent += text;
  messages.scrollTop = messages.scrollHeight;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || send.disabled) {
    return;
  }

  activeAgentMessage = undefined;
  append('user', text);
  prompt.value = '';
  send.disabled = true;
  vscode.postMessage({ type: 'prompt', text });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'session') {
    session.textContent = `Session: ${message.sessionId}`;
    prompt.focus();
  }
  if (message.type === 'text') {
    appendAgentText(message.text);
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
});
