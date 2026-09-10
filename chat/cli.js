/* Locating the Claude Code CLI that the desktop app ships.
 *
 * The version is part of the path (…\claude-code\2.1.260\claude.exe), so it
 * moves whenever the desktop app updates - including while this app is open.
 * Resolve fresh at every session start rather than caching. */

const fs = require('fs');
const path = require('path');

class ChatError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ChatError';
    this.code = code;          // CLI_NOT_FOUND | AUTH_FAILED | CWD_MISSING | SDK_CRASH
    this.detail = detail || '';
  }
}

function compareVersionDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] | 0) !== (pb[i] | 0)) return (pb[i] | 0) - (pa[i] | 0);
  }
  return 0;
}

function claudeCodeRoot() {
  const appData = process.env.APPDATA;
  if (!appData) throw new ChatError('CLI_NOT_FOUND', 'APPDATA is not set.');
  return path.join(appData, 'Claude', 'claude-code');
}

function resolveClaudeExecutable() {
  const root = claudeCodeRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new ChatError(
      'CLI_NOT_FOUND',
      'The Claude Code desktop app does not appear to be installed.',
      `Looked in ${root} — ${err.code}`
    );
  }

  const exe = entries
    .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+/.test(d.name))
    .map((d) => d.name)
    .sort(compareVersionDesc)
    .map((name) => path.join(root, name, 'claude.exe'))
    .find((p) => fs.existsSync(p));

  if (!exe) {
    throw new ChatError(
      'CLI_NOT_FOUND',
      'Could not find claude.exe inside the Claude Code desktop app.',
      `Looked for */claude.exe under ${root}. Open the desktop app once, then try again.`
    );
  }
  return exe;
}

// "…\claude-code\2.1.260\claude.exe" -> "2.1.260", for the init-message version check
function versionOf(exePath) {
  return path.basename(path.dirname(exePath));
}

module.exports = { ChatError, resolveClaudeExecutable, versionOf };
