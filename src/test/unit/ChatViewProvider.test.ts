import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { renderChatHtml } from '../../ui/ChatViewProvider';

suite('ChatViewProvider', () => {
  test('keeps the transcript scrollable and composer pinned after messages arrive', () => {
    const html = renderChatHtml(chatTemplate(), webviewResources());
    const styles = chatStyles();

    assert.match(html, /class="chat-layout"/);
    assert.match(html, /id="messages"/);
    assert.match(html, /id="prompt"/);
    assert.match(html, /<link rel="stylesheet" href="vscode-webview:\/\/chat\.css">/);
    assert.match(html, /<script src="vscode-webview:\/\/chat\.js"><\/script>/);
    assert.match(html, /default-src 'none'; style-src vscode-webview:\/\/chat; script-src vscode-webview:\/\/chat/);
    assert.doesNotMatch(html, /<style>/);
    assert.doesNotMatch(html, /<script>\s/);
    assert.match(styles, /\.messages\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(styles, /\.composer\s*\{[^}]*flex-shrink:\s*0/);
  });

  test('appends streamed agent chunks to one message', () => {
    const harness = createChatHarness(chatScript());

    harness.receive({ type: 'text', text: 'Hello' });
    harness.receive({ type: 'text', text: ', world!' });

    assert.equal(harness.messages.children.length, 1);
    assert.equal(harness.messages.children[0].textContent, 'Hello, world!');
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

function webviewResources(): { cspSource: string; stylesheetUri: string; scriptUri: string } {
  return {
    cspSource: 'vscode-webview://chat',
    stylesheetUri: 'vscode-webview://chat.css',
    scriptUri: 'vscode-webview://chat.js'
  };
}

function createChatHarness(script: string): { messages: FakeElement; receive(message: unknown): void } {
  const elements = new Map<string, FakeElement>([
    ['session', new FakeElement()],
    ['messages', new FakeElement()],
    ['form', new FakeElement()],
    ['prompt', new FakeElement()],
    ['send', new FakeElement()]
  ]);
  let messageListener: ((event: { data: unknown }) => void) | undefined;
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage() {} }),
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
    }
  });

  return {
    messages: elements.get('messages')!,
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
  public value = '';
  public disabled = false;
  public scrollTop = 0;
  public scrollHeight = 0;

  public appendChild(child: FakeElement): void {
    this.children.push(child);
    this.scrollHeight = this.children.length;
  }

  public addEventListener(): void {}

  public focus(): void {}
}
