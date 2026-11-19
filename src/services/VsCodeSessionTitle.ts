const VSCODE_SESSION_TITLE_PREFIX = '[VS Code]';

export function withVsCodeSessionTitlePrefix(title: string | undefined): string {
  const normalized = title?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return VSCODE_SESSION_TITLE_PREFIX;
  }
  return normalized.startsWith(VSCODE_SESSION_TITLE_PREFIX)
    ? normalized
    : `${VSCODE_SESSION_TITLE_PREFIX} ${normalized}`;
}
