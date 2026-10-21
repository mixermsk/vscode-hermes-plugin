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
    assert.ok(html.indexOf('id="messages"') < html.indexOf('id="accept-edits"'));
    assert.ok(html.indexOf('id="accept-edits"') < html.indexOf('id="form"'));
    assert.match(html, /id="prompt"/);
    assert.match(html, /<button id="send" type="submit" disabled>Send<\/button>/);
    assert.match(html, /<link rel="stylesheet" href="vscode-webview:\/\/chat\.css">/);
    assert.match(html, /<script src="vscode-webview:\/\/marked\.js"><\/script>/);
    assert.match(html, /<script src="vscode-webview:\/\/purify\.js"><\/script>/);
    assert.match(html, /<script src="vscode-webview:\/\/chat\.js"><\/script>/);
    assert.match(html, /default-src 'none'; style-src vscode-webview:\/\/chat; script-src vscode-webview:\/\/chat/);
    assert.doesNotMatch(html, /<style>/);
    assert.doesNotMatch(html, /<script>\s/);
    assert.match(styles, /\.messages\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(styles, /\.composer\s*\{[^}]*flex-shrink:\s*0/);
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
      acceptEdits: false,
      entries: [
        { role: 'user', text: 'Hello' },
        { role: 'agent', text: 'Hi there' }
      ]
    });

    assert.equal(harness.session.textContent, 'Session: Refactor chat transport (session-1)');
    assert.equal(harness.acceptEdits.checked, false);
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
  });

  test('restores and changes the Accept Edits toggle', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({ type: 'restore', sessionId: 'session-1', acceptEdits: true, entries: [] });
    assert.equal(harness.acceptEdits.checked, true);
    assert.equal(harness.acceptEdits.disabled, false);

    harness.acceptEdits.checked = false;
    harness.acceptEdits.dispatch('change', {});

    assert.equal(harness.acceptEdits.disabled, true);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.posted)), [{ type: 'set-accept-edits', enabled: false }]);

    harness.receive({ type: 'accept-edits', enabled: false });
    assert.equal(harness.acceptEdits.checked, false);
    assert.equal(harness.acceptEdits.disabled, false);
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
    assert.match(harness.messages.children[0].textContent, /completed/);
    assert.match(harness.messages.children[0].textContent, /--- \/work\/src\/ui\/ChatViewProvider\.ts/);
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

  test('contributes the chat as a Secondary Side Bar view', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { viewsContainers?: Record<string, unknown>; views?: Record<string, unknown> };
    };

    assert.deepEqual(manifest.contributes.viewsContainers?.secondarySidebar, [{
      id: 'hermes-acp',
      title: 'Hermes',
      icon: 'resources/hermes.svg'
    }]);
    assert.deepEqual(manifest.contributes.views?.['hermes-acp'], [{
      id: 'hermesAcp.chat',
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
      acceptEdits: false,
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

  test('forwards a webview prompt to the connected ACP session', async () => {
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
      { type: 'restore', sessionId: 'session-1', title: undefined, acceptEdits: false, entries: [] },
      { type: 'activity', text: 'Working…' },
      { type: 'message', role: 'user', text: 'Inspect the session' },
      { type: 'activity', text: undefined },
      { type: 'ready' }
    ]);
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
  acceptEdits: FakeElement;
  activity: FakeElement;
  messages: FakeElement;
  prompt: FakeElement;
  send: FakeElement;
  posted: unknown[];
  keydown(key: string, modifiers?: { metaKey?: boolean; shiftKey?: boolean }): { defaultPrevented: boolean };
  submit(): { defaultPrevented: boolean };
  receive(message: unknown): void;
} {
  const elements = new Map<string, FakeElement>([
    ['session', new FakeElement()],
    ['accept-edits', new FakeElement()],
    ['activity', new FakeElement()],
    ['messages', new FakeElement()],
    ['form', new FakeElement()],
    ['prompt', new FakeElement()],
    ['send', new FakeElement()]
  ]);
  elements.get('prompt')!.disabled = true;
  elements.get('send')!.disabled = true;
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
    acceptEdits: elements.get('accept-edits')!,
    activity: elements.get('activity')!,
    messages: elements.get('messages')!,
    prompt: elements.get('prompt')!,
    send: elements.get('send')!,
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
  public scrollTop = 0;
  public scrollHeight = 0;
  private readonly listeners = new Map<string, (event: unknown) => void>();

  public appendChild(child: FakeElement): void {
    this.children.push(child);
    this.textContent += child.textContent;
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
