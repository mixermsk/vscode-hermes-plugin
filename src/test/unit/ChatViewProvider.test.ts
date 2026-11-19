import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { ChatViewProvider, renderChatHtml } from '../../ui/ChatViewProvider';

suite('ChatViewProvider', () => {
  test('keeps the transcript scrollable and composer pinned after messages arrive', () => {
    const html = renderChatHtml(chatTemplate(), webviewResources());
    const styles = chatStyles();

    assert.match(html, /class="chat-layout"/);
    assert.match(html, /id="messages"/);
    assert.ok(html.indexOf('id="messages"') < html.indexOf('id="activity"'));
    assert.doesNotMatch(html, /id="subagents"/);
    assert.ok(html.indexOf('id="messages"') < html.indexOf('id="form"'));
    assert.match(html, /id="auto-approve-edits"/);
    assert.match(html, /id="model"/);
    assert.match(html, /id="prompt"/);
    assert.ok(html.indexOf('id="auto-approve-edits"') < html.indexOf('id="model"'));
    assert.ok(html.indexOf('id="model"') < html.indexOf('id="prompt"'));
    assert.match(html, /<button id="send" type="submit" disabled>Send<\/button>/);
    assert.match(html, /<link rel="stylesheet" href="vscode-webview:\/\/chat\.css">/);
    assert.match(html, /<script src="vscode-webview:\/\/marked\.js"><\/script>/);
    assert.match(html, /<script src="vscode-webview:\/\/purify\.js"><\/script>/);
    assert.match(html, /<script src="vscode-webview:\/\/chat\.js"><\/script>/);
    assert.match(html, /default-src 'none'; style-src vscode-webview:\/\/chat; script-src vscode-webview:\/\/chat/);
    assert.doesNotMatch(html, /<style>/);
    assert.doesNotMatch(html, /<script>\s/);
    assert.match(styles, /\.messages\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(styles, /\.activity\s*\{[^}]*flex-shrink:\s*0/);
    assert.match(styles, /\.composer\s*\{[^}]*flex-shrink:\s*0/);
    assert.match(styles, /\.composer-controls\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(styles, /\.selectors\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(styles, /#send\.stop\s*\{[^}]*background:\s*var\(--vscode-inputValidation-errorBackground\)/);
  });

  test('appends streamed agent chunks to one message', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({ type: 'text', text: 'Hello' });
    harness.receive({ type: 'text', text: ', world!' });

    assert.equal(harness.messages.children.length, 1);
    assert.equal(harness.messages.children[0].textContent, 'Hello, world!');
  });

  test('renders streamed agent text as sanitized Markdown', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({ type: 'text', text: '## Result\n\n**Done** [docs](https://example.test) <script>alert(1)</script>' });

    assert.match(harness.messages.children[0].innerHTML, /<h2>Result<\/h2>/);
    assert.match(harness.messages.children[0].innerHTML, /<strong>Done<\/strong>/);
    assert.match(harness.messages.children[0].innerHTML, /href="https:\/\/example\.test"/);
    assert.doesNotMatch(harness.messages.children[0].innerHTML, /script/);
  });

  test('starts disconnected, then restores the connected session and transcript', () => {
    const harness = createChatHarness(chatScript());

    assert.equal(harness.prompt.disabled, true);
    assert.equal(harness.send.disabled, true);

    harness.receive({
      type: 'restore',
      sessionId: 'session-1',
      title: 'Refactor chat transport',
      subagents: [],
      entries: [
        { role: 'user', text: 'Hello' },
        { role: 'agent', text: 'Hi there' }
      ]
    });

    assert.equal(harness.session.textContent, 'Session: Refactor chat transport (session-1)');
    assert.equal(harness.prompt.disabled, false);
    assert.equal(harness.send.disabled, false);
    assert.deepEqual(
      harness.messages.children.map((message) => ({ className: message.className, text: message.textContent })),
      [
        { className: 'message user', text: 'Hello' },
        { className: 'message agent', text: 'Hi there' }
      ]
    );
  });

  test('renders the agent activity while a prompt is running', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({ type: 'activity', text: 'Running: Read ChatViewProvider.ts' });

    assert.equal(harness.activity.hidden, false);
    assert.equal(harness.activity.textContent, 'Running: Read ChatViewProvider.ts');
    assert.equal(harness.messages.children.at(-1), harness.activity);
    assert.equal(harness.messages.scrollTop, harness.messages.scrollHeight);

    harness.receive({ type: 'text', text: 'Done' });
    assert.equal(harness.messages.children.at(-1), harness.activity);
  });

  test('renders a non-blocking Gateway tracking availability status', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({ type: 'subagent-tracking', status: { kind: 'incompatible', message: 'Subagent tracking: incompatible' } });

    assert.equal(harness.subagentTracking.hidden, false);
    assert.equal(harness.subagentTracking.textContent, 'Subagent tracking: incompatible');
  });

  test('embeds a delegated task in the transcript and updates it in place', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({ type: 'message', role: 'user', text: 'Investigate the failure' });
    harness.receive({ type: 'subagent', subagent: { subagentId: 'child-1', title: 'Delegated task', status: 'running', activity: 'Working' } });
    harness.receive({ type: 'message', role: 'agent', text: 'I delegated the investigation.' });

    assert.deepEqual(harness.messages.children.map((entry) => ({ className: entry.className, text: entry.textContent })), [
      { className: 'message user', text: 'Investigate the failure' },
      { className: 'subagent running', text: 'Delegated taskWorking' },
      { className: 'message agent', text: 'I delegated the investigation.' }
    ]);

    harness.receive({ type: 'subagent-update', subagent: { subagentId: 'child-1', title: 'Delegated task', status: 'completed', summary: 'Completed' } });

    assert.equal(harness.messages.children.length, 3);
    assert.deepEqual(
      { className: harness.messages.children[1].className, text: harness.messages.children[1].textContent },
      { className: 'subagent completed', text: 'Delegated taskCompleted' }
    );
  });

  test('renders delegated task details in a collapsible body', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({
      type: 'subagent',
      subagent: {
        subagentId: 'delegation:deleg_abc',
        title: 'Delegated task',
        status: 'completed',
        summary: 'Completed',
        details: '• Return exactly the phrase\n\nSubagent Task Completed: Return exactly the phrase'
      }
    });

    const row = harness.messages.children[0];
    assert.equal(row.className, 'subagent completed');
    assert.match(row.textContent, /Delegated task/);
    assert.match(row.textContent, /Completed/);
    assert.match(row.textContent, /Subagent Task Completed: Return exactly the phrase/);
  });

  test('renders a collapsible tool card and updates its status', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({
      type: 'tool',
      tool: {
        toolCallId: 'tool-1',
        title: 'Read src/ui/ChatViewProvider.ts',
        kind: 'read',
        status: 'in_progress',
        content: [{ type: 'text', text: 'src/ui/ChatViewProvider.ts' }],
        locations: [{ path: '/work/src/ui/ChatViewProvider.ts', line: 100 }]
      }
    });
    assert.match(harness.messages.children[0].textContent, /⚙️/);
    harness.receive({
      type: 'tool-update',
      tool: {
        toolCallId: 'tool-1',
        title: 'Read src/ui/ChatViewProvider.ts',
        kind: 'read',
        status: 'completed',
        content: [{ type: 'diff', path: '/work/src/ui/ChatViewProvider.ts', oldText: 'old', newText: 'new' }],
        locations: [{ path: '/work/src/ui/ChatViewProvider.ts', line: 100 }]
      }
    });

    assert.equal(harness.messages.children.length, 1);
    assert.equal(harness.messages.children[0].className, 'tool');
    assert.match(harness.messages.children[0].textContent, /✅/);
    assert.match(harness.messages.children[0].textContent, /--- \/work\/src\/ui\/ChatViewProvider\.ts/);

    harness.receive({ type: 'tool', tool: { toolCallId: 'tool-2', title: 'Write README.md', status: 'failed' } });
    assert.match(harness.messages.children[1].textContent, /❌/);

    harness.receive({ type: 'tool', tool: { toolCallId: 'tool-3', title: 'Approve edit', status: 'pending' } });
    assert.match(harness.messages.children[2].textContent, /⏳/);
  });

  test('sends the prompt with Enter but leaves Shift+Enter and Command+Enter to the textarea', () => {
    const harness = createChatHarness(chatScript());
    harness.prompt.disabled = false;
    harness.send.disabled = false;
    harness.prompt.value = 'Ship this change';

    const enter = harness.keydown('Enter');

    assert.equal(enter.defaultPrevented, true);
    assert.equal(harness.prompt.value, '');
    assert.equal(harness.send.disabled, false);
    assert.equal(harness.send.textContent, 'Stop');
    assert.deepEqual(JSON.parse(JSON.stringify(harness.posted)), [{ type: 'prompt', text: 'Ship this change' }]);

    harness.prompt.disabled = false;
    harness.send.disabled = false;
    harness.prompt.value = 'Continue editing';

    const shiftEnter = harness.keydown('Enter', { shiftKey: true });
    const commandEnter = harness.keydown('Enter', { metaKey: true });

    assert.equal(shiftEnter.defaultPrevented, false);
    assert.equal(commandEnter.defaultPrevented, false);
    assert.equal(harness.prompt.value, 'Continue editing');
    assert.deepEqual(JSON.parse(JSON.stringify(harness.posted)), [{ type: 'prompt', text: 'Ship this change' }]);
  });

  test('turns Send into Stop and sends one cancellation request while a prompt is pending', () => {
    const harness = createChatHarness(chatScript());
    harness.prompt.disabled = false;
    harness.send.disabled = false;
    harness.prompt.value = 'Stop me';

    harness.keydown('Enter');
    assert.equal(harness.send.textContent, 'Stop');
    assert.equal(harness.send.className, 'stop');
    assert.equal(harness.send.disabled, false);
    harness.submit();
    harness.submit();

    assert.equal(harness.send.disabled, true);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.posted)), [
      { type: 'prompt', text: 'Stop me' },
      { type: 'cancel' }
    ]);
  });

  test('sends the session-scoped file edit auto-approval preference', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({ type: 'restore', sessionId: 'session-1', title: 'Gateway chat', autoApproveEdits: false, subagents: [], entries: [] });
    assert.equal(harness.autoApproveEdits.checked, false);

    harness.toggleAutoApproveEdits(true);

    assert.deepEqual(JSON.parse(JSON.stringify(harness.posted)), [{ type: 'auto-approve-edits', enabled: true }]);

    harness.receive({ type: 'auto-approve-edits', enabled: false });
    assert.equal(harness.autoApproveEdits.checked, false);
  });

  test('renders each model with its provider and posts the chosen route', () => {
    const harness = createChatHarness(chatScript());

    assert.equal(harness.model.disabled, true);

    harness.receive({
      type: 'model-options',
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      providers: [
        { slug: 'deepseek', name: 'DeepSeek', isCurrent: true, models: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
        { slug: 'anthropic', name: 'Anthropic', models: ['deepseek-v4-pro', 'claude-4.5'] }
      ]
    });

    assert.equal(harness.model.disabled, false);
    assert.equal(harness.model.selectedIndex, 0);
    assert.deepEqual(harness.model.children.map((option) => option.textContent), [
      'DeepSeek / deepseek-v4-pro',
      'DeepSeek / deepseek-v4-flash',
      'Anthropic / deepseek-v4-pro',
      'Anthropic / claude-4.5'
    ]);

    harness.model.selectedIndex = 3;
    harness.selectModel();

    assert.deepEqual(JSON.parse(JSON.stringify(harness.posted)), [
      { type: 'select-model', model: 'claude-4.5', provider: 'anthropic' }
    ]);
  });

  test('renders the reasoning level and posts a new effort selection', () => {
    const harness = createChatHarness(chatScript());

    assert.equal(harness.reasoning.disabled, true);

    harness.receive({ type: 'reasoning', effort: 'medium' });

    assert.equal(harness.reasoning.disabled, false);
    assert.equal(harness.reasoning.value, 'medium');

    harness.selectReasoning('high');

    assert.deepEqual(JSON.parse(JSON.stringify(harness.posted)), [
      { type: 'select-reasoning', effort: 'high' }
    ]);
  });

  test('contributes the chat as a Secondary Side Bar view', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { viewsContainers?: Record<string, unknown>; views?: Record<string, unknown> };
    };

    assert.deepEqual(manifest.contributes.viewsContainers?.secondarySidebar, [{
      id: 'hermes-gateway',
      title: 'Hermes',
      icon: 'resources/hermes.svg'
    }]);
    assert.deepEqual(manifest.contributes.views?.['hermes-gateway'], [{
      id: 'hermesGateway.chat',
      name: 'Chat',
      type: 'webview'
    }]);
  });


  test('delivers a session set before the side bar view resolves', async () => {
    const provider = new ChatViewProvider({
      mediaUri: {} as never,
      templateUri: { fsPath: join(process.cwd(), 'media', 'chat.html') } as never,
      stylesheetUri: {} as never,
      markedUri: {} as never,
      domPurifyUri: {} as never,
      scriptUri: {} as never
    });
    const posted: unknown[] = [];
    provider.setSession('session-1', async () => {});
    provider.appendUserText('Earlier prompt');
    provider.startTool({
      toolCallId: 'tool-1',
      title: 'Read README.md',
      status: 'completed',
      content: [{ type: 'text', text: 'README.md' }]
    });

    const view = {
      webview: {
        cspSource: 'vscode-webview://chat',
        asWebviewUri() { return { toString: () => 'vscode-webview://asset' }; },
        async postMessage(message: unknown) { posted.push(message); return true; },
        onDidReceiveMessage() { return { dispose() {} }; }
      }
    } as never;
    provider.resolveWebviewView(view);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(posted, [{
      type: 'restore',
      sessionId: 'session-1',
      title: undefined,
      autoApproveEdits: false,
      entries: [
        { role: 'user', text: 'Earlier prompt' },
        {
          toolCallId: 'tool-1',
          title: 'Read README.md',
          status: 'completed',
          content: [{ type: 'text', text: 'README.md' }]
        }
      ]
    }]);
  });

  test('forwards the session-scoped file edit auto-approval preference to its handler', async () => {
    const provider = new ChatViewProvider({
      mediaUri: {} as never,
      templateUri: { fsPath: join(process.cwd(), 'media', 'chat.html') } as never,
      stylesheetUri: {} as never,
      markedUri: {} as never,
      domPurifyUri: {} as never,
      scriptUri: {} as never
    });
    const posted: unknown[] = [];
    const preferences: boolean[] = [];
    let receive: ((message: unknown) => Promise<void>) | undefined;
    provider.setSession('session-1', async () => {});
    provider.setAutoApproveEditsHandler(async (enabled) => { preferences.push(enabled); });

    provider.resolveWebviewView({
      webview: {
        cspSource: 'vscode-webview://chat',
        asWebviewUri() { return { toString: () => 'vscode-webview://asset' }; },
        async postMessage(message: unknown) { posted.push(message); return true; },
        onDidReceiveMessage(handler: (message: unknown) => Promise<void>) {
          receive = handler;
          return { dispose() {} };
        }
      }
    } as never);

    assert.ok(receive, 'expected the webview to register an auto-approval handler');
    await receive({ type: 'auto-approve-edits', enabled: true });

    assert.deepEqual(preferences, [true]);
    assert.deepEqual(posted, [
      { type: 'restore', sessionId: 'session-1', title: undefined, autoApproveEdits: false, entries: [] },
      { type: 'auto-approve-edits', enabled: true }
    ]);
  });

  test('ignores a late thinking update after the prompt has completed', async () => {
    const provider = new ChatViewProvider({
      mediaUri: {} as never,
      templateUri: { fsPath: join(process.cwd(), 'media', 'chat.html') } as never,
      stylesheetUri: {} as never,
      markedUri: {} as never,
      domPurifyUri: {} as never,
      scriptUri: {} as never
    });
    const posted: unknown[] = [];
    let receive: ((message: unknown) => Promise<void>) | undefined;
    provider.setSession('session-1', async () => {});

    provider.resolveWebviewView({
      webview: {
        cspSource: 'vscode-webview://chat',
        asWebviewUri() { return { toString: () => 'vscode-webview://asset' }; },
        async postMessage(message: unknown) { posted.push(message); return true; },
        onDidReceiveMessage(handler: (message: unknown) => Promise<void>) {
          receive = handler;
          return { dispose() {} };
        }
      }
    } as never);

    assert.ok(receive, 'expected the webview to register a prompt handler');
    await receive({ type: 'prompt', text: 'Finish this task' });
    assert.deepEqual(posted.at(-1), { type: 'ready' });

    provider.setThinking();

    assert.deepEqual(posted.at(-1), { type: 'ready' });
  });

  test('forwards a webview prompt to the connected Gateway session', async () => {
    const provider = new ChatViewProvider({
      mediaUri: {} as never,
      templateUri: { fsPath: join(process.cwd(), 'media', 'chat.html') } as never,
      stylesheetUri: {} as never,
      markedUri: {} as never,
      domPurifyUri: {} as never,
      scriptUri: {} as never
    });
    const posted: unknown[] = [];
    let receive: ((message: unknown) => Promise<void>) | undefined;
    const prompts: string[] = [];
    provider.setSession('session-1', async (text) => { prompts.push(text); });

    provider.resolveWebviewView({
      webview: {
        cspSource: 'vscode-webview://chat',
        asWebviewUri() { return { toString: () => 'vscode-webview://asset' }; },
        async postMessage(message: unknown) { posted.push(message); return true; },
        onDidReceiveMessage(handler: (message: unknown) => Promise<void>) {
          receive = handler;
          return { dispose() {} };
        }
      }
    } as never);

    assert.ok(receive, 'expected the webview to register a prompt handler');
    await receive({ type: 'prompt', text: 'Inspect the session' });

    assert.deepEqual(prompts, ['Inspect the session']);
    assert.deepEqual(posted, [
      { type: 'restore', sessionId: 'session-1', title: undefined, autoApproveEdits: false, entries: [] },
      { type: 'activity', text: 'Working…' },
      { type: 'message', role: 'user', text: 'Inspect the session' },
      { type: 'activity', text: undefined },
      { type: 'ready' }
    ]);
  });

  test('posts a replayed user message to the resolved webview', async () => {
    const provider = new ChatViewProvider({
      mediaUri: {} as never,
      templateUri: { fsPath: join(process.cwd(), 'media', 'chat.html') } as never,
      stylesheetUri: {} as never,
      markedUri: {} as never,
      domPurifyUri: {} as never,
      scriptUri: {} as never
    });
    const posted: unknown[] = [];
    provider.setSession('session-1', async () => {});

    provider.resolveWebviewView({
      webview: {
        cspSource: 'vscode-webview://chat',
        asWebviewUri() { return { toString: () => 'vscode-webview://asset' }; },
        async postMessage(message: unknown) { posted.push(message); return true; },
        onDidReceiveMessage() { return { dispose() {} }; }
      }
    } as never);
    await new Promise((resolve) => setImmediate(resolve));

    provider.appendUserText('Sent from hermes-agent');

    assert.deepEqual(posted.at(-1), { type: 'message', role: 'user', text: 'Sent from hermes-agent' });
  });

});

function chatTemplate(): string {
  return readFileSync(join(process.cwd(), 'media', 'chat.html'), 'utf8');
}

function chatScript(): string {
  return readFileSync(join(process.cwd(), 'media', 'chat.js'), 'utf8');
}

function chatStyles(): string {
  return readFileSync(join(process.cwd(), 'media', 'chat.css'), 'utf8');
}

function webviewResources(): {
  cspSource: string;
  stylesheetUri: string;
  markedUri: string;
  domPurifyUri: string;
  scriptUri: string;
} {
  return {
    cspSource: 'vscode-webview://chat',
    stylesheetUri: 'vscode-webview://chat.css',
    markedUri: 'vscode-webview://marked.js',
    domPurifyUri: 'vscode-webview://purify.js',
    scriptUri: 'vscode-webview://chat.js'
  };
}

function createChatHarness(script: string): {
  session: FakeElement;
  activity: FakeElement;
  subagentTracking: FakeElement;
  subagents: FakeElement;
  autoApproveEdits: FakeElement;
  messages: FakeElement;
  prompt: FakeElement;
  send: FakeElement;
  model: FakeElement;
  reasoning: FakeElement;
  posted: unknown[];
  keydown(key: string, modifiers?: { metaKey?: boolean; shiftKey?: boolean }): { defaultPrevented: boolean };
  submit(): { defaultPrevented: boolean };
  toggleAutoApproveEdits(enabled: boolean): void;
  selectModel(): void;
  selectReasoning(effort: string): void;
  receive(message: unknown): void;
} {
  const elements = new Map<string, FakeElement>([
    ['session', new FakeElement()],
    ['activity', new FakeElement()],
    ['subagent-tracking', new FakeElement()],
    ['subagents', new FakeElement()],
    ['auto-approve-edits', new FakeElement()],
    ['messages', new FakeElement()],
    ['form', new FakeElement()],
    ['prompt', new FakeElement()],
    ['send', new FakeElement()],
    ['model', new FakeElement()],
    ['reasoning', new FakeElement()]
  ]);
  elements.get('activity')!.hidden = true;
  elements.get('subagent-tracking')!.hidden = true;
  elements.get('subagents')!.hidden = true;
  elements.get('auto-approve-edits')!.disabled = true;
  elements.get('prompt')!.disabled = true;
  elements.get('send')!.disabled = true;
  elements.get('model')!.disabled = true;
  elements.get('reasoning')!.disabled = true;
  const posted: unknown[] = [];
  let messageListener: ((event: { data: unknown }) => void) | undefined;
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage(message: unknown) { posted.push(message); } }),
    document: {
      getElementById(id: string) {
        return elements.get(id);
      },
      createElement() {
        return new FakeElement();
      }
    },
    window: {
      addEventListener(type: string, listener: (event: { data: unknown }) => void) {
        if (type === 'message') {
          messageListener = listener;
        }
      }
    },
    marked: {
      parse(text: string) {
        return text
          .replace(/^## (.+)$/m, '<h2>$1</h2>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\[(.+?)\]\((https:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
      }
    },
    DOMPurify: { sanitize(html: string) { return html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''); } }
  });

  return {
    session: elements.get('session')!,
    activity: elements.get('activity')!,
    subagentTracking: elements.get('subagent-tracking')!,
    subagents: elements.get('subagents')!,
    autoApproveEdits: elements.get('auto-approve-edits')!,
    messages: elements.get('messages')!,
    prompt: elements.get('prompt')!,
    send: elements.get('send')!,
    model: elements.get('model')!,
    reasoning: elements.get('reasoning')!,
    posted,
    keydown(key: string, modifiers = {}) {
      const event = {
        key,
        metaKey: modifiers.metaKey ?? false,
        shiftKey: modifiers.shiftKey ?? false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }
      };
      elements.get('prompt')!.dispatch('keydown', event);
      return event;
    },
    submit() {
      const event = {
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }
      };
      elements.get('form')!.dispatch('submit', event);
      return event;
    },
    toggleAutoApproveEdits(enabled: boolean) {
      const checkbox = elements.get('auto-approve-edits')!;
      checkbox.checked = enabled;
      checkbox.dispatch('change', {});
    },
    selectModel() {
      elements.get('model')!.dispatch('change', {});
    },
    selectReasoning(effort: string) {
      const select = elements.get('reasoning')!;
      select.value = effort;
      select.dispatch('change', {});
    },
    receive(message: unknown) {
      assert.ok(messageListener, 'expected the webview to register a message listener');
      messageListener({ data: message });
    }
  };
}

class FakeElement {
  public readonly children: FakeElement[] = [];
  public className = '';
  public textContent = '';
  private html = '';
  public value = '';
  public checked = false;
  public disabled = false;
  public hidden = false;
  public selectedIndex = -1;
  public scrollTop = 0;
  public scrollHeight = 0;
  private readonly listeners = new Map<string, (event: unknown) => void>();

  public appendChild(child: FakeElement): void {
    const existingIndex = this.children.indexOf(child);
    if (existingIndex !== -1) {
      this.children.splice(existingIndex, 1);
    }
    this.children.push(child);
    this.textContent = this.children.map((element) => element.textContent).join('');
    this.scrollHeight = this.children.length;
  }

  public replaceChildren(): void {
    this.children.length = 0;
    this.textContent = '';
    this.scrollHeight = 0;
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  public dispatch(type: string, event: unknown): void {
    this.listeners.get(type)?.(event);
  }

  public focus(): void {}

  public get innerHTML(): string {
    return this.html;
  }

  public set innerHTML(value: string) {
    this.html = value;
    this.textContent = value.replace(/<[^>]+>/g, '');
  }
}
