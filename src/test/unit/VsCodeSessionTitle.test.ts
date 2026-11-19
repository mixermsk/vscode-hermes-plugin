import * as assert from 'node:assert/strict';
import { withVsCodeSessionTitlePrefix } from '../../services/VsCodeSessionTitle';

suite('VsCodeSessionTitle', () => {
  test('prefixes a named session title once', () => {
    assert.equal(withVsCodeSessionTitlePrefix('Refactor chat transport'), '[VS Code] Refactor chat transport');
    assert.equal(withVsCodeSessionTitlePrefix('[VS Code] Refactor chat transport'), '[VS Code] Refactor chat transport');
  });

  test('uses the prefix as the title when Gateway has no title', () => {
    assert.equal(withVsCodeSessionTitlePrefix(undefined), '[VS Code]');
  });
});
