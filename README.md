# Elliot's Domain

> **Public copy.** The six entries in `NODES` in `main.js` are placeholder
> URLs — point them at your own board, dashboard, wiki, spreadsheet and Figma
> drafts before running it. Nothing else needs configuring.

A radial launcher for the six things I open every day. Click a node and it opens
**inside** the window, in the panel on the right; Ctrl+click sends it out to its
own window instead.

## Run it

`npm start` in this folder (or double-click the desktop shortcut, if you made one).
Single instance — launching again focuses the window you already have.

## Nodes

| # | Node | Click (preview in the panel) | Ctrl+click |
|---|---|---|---|
| 1 | My Jira Board | whatever you point it at | Brave |
| 2 | Jira · WD Board | a Jira dashboard | Brave |
| 3 | Confluence · SPEC | a Confluence space overview | Brave |
| 4 | Sprint plan 2026 | a workbook in Excel for the web | **desktop Excel** (`ms-excel:`) |
| 5 | Figma · Drafts | your team drafts | Brave |
| 6 | Agentic Workflow | a real Claude Code conversation, in the panel | the Claude Code desktop app |

## Why this is an Electron app

The obvious build is a web page with an `<iframe>` in the panel. That cannot
work here — every target refuses to be framed:

| Target | Response header |
|---|---|
| claude.ai artifact | `frame-ancestors 'self'` |
| Jira | `frame-ancestors` allowlist, no localhost |
| Confluence | `X-Frame-Options: DENY` |
| SharePoint, incl. `?action=embedview` | `X-Frame-Options: DENY` |
| Figma | `X-Frame-Options: SAMEORIGIN` |

Stripping those headers with an extension is also out: Chromium removed
`--load-extension` at 137 and Brave here is 151.

Electron's `WebContentsView` loads its page as a **top-level** WebContents, and
those headers only apply to frames — so the page really does render inside this
window, clipped and composited with it, with no second OS window anywhere. That
is the whole reason for the runtime choice. `main.js` positions the view at the
rect the renderer measures for `.pbody`.

Consequence worth knowing: a `WebContentsView` composites **above** the page, so
nothing in `index.html` can draw on top of a preview. The panel header is a
separate 42px strip that sits outside the view's bounds — keep it that way.

## Sign-in

The app has its own cookie jar (`persist:domain`), separate from Brave, so the
first time you open each service you sign in here once. It persists across
restarts. The user agent is scrubbed of the `Electron/…` and app-name tokens so
identity providers treat this as ordinary Chrome; without that, Microsoft and
Atlassian sign-in can refuse an "embedded browser".

Ctrl+click deliberately goes to Brave, where you are already signed in and have
your extensions and tabs — at the cost of it being a different session from the
panel.

## The Agentic Workflow node

Clicking it opens a **real Claude Code conversation** in the panel, driven by the
CLI that ships inside the Claude Code desktop app (`%APPDATA%\Claude\claude-code\<ver>\claude.exe`)
through `@anthropic-ai/claude-agent-sdk`. It is the same binary and the same
`~/.claude/projects` session store the desktop app uses, so conversations
started here show up in its history for this project and vice versa.

Ctrl+click still opens the desktop app, and deliberately does **not** close the
panel — an in-panel session and the desktop app can both be open.

### One-time setup

The bundled CLI keeps its own login, separate from the desktop app's. Run once:

```
"%APPDATA%\Claude\claude-code\2.1.260\claude.exe" setup-token
```

Until then the panel shows a "not signed in" state with that command in it.

### Working directories

A slash command is only offered from the workspace it is defined in — one
scoped to a sub-folder is not visible from the parent. So each shortcut in the
menu carries its own cwd, and picking one starts the conversation in the folder
where that command actually resolves.

The menu is `SHORTCUTS` in `chat/session.js`, and the entries there are
placeholders — replace them with your own commands and their directories. The
workspace root is `~/agentic-workflow`.

### Permissions

`permissionMode: 'default'` — nothing auto-approves. Every tool call reaches
`canUseTool` and surfaces as a card in the transcript showing the full command,
path or diff. Nothing runs until you click, and the buttons live in the same
element as the evidence so a prompt cannot be approved unseen. The keys arm
400 ms after the card appears, so an Enter meant for the composer cannot
approve something you never read.

"Allow for this conversation" is **in memory only** and is never written to
disk. The SDK can persist a rule into the workspace's `.claude/settings.local.json`;
that is deliberately not done, because it would quietly recreate `acceptEdits`
for every future session.

### Sessions

The session lives in the main process, so closing the panel does not stop a
run — it keeps going and the transcript replays when you reopen.
Quitting drains every pending prompt first, so no `claude.exe` is left blocked
on an answer that will never come.

## Install

```
npm install --omit=optional
```

`--omit=optional` matters: without it npm also downloads the SDK's own copy of
the CLI (a few hundred MB) and would silently prefer it over the desktop app's.

## Controls

- **Click** a node → preview in the panel; **Ctrl+click** → outside the app
- **1**–**6**, and **Ctrl+1**–**6** for the same split
- **Esc** closes the panel — including when focus is inside the preview, which
  `main.js` handles via `before-input-event` since the page never sees that key
- **/** focuses the search bar, **Enter** launches the best match
- **Reload** / **Pop out** / **Close** in the panel header
- Bottom-right cards are your last three launches (browser `localStorage`)

## Files

| File | Role |
|---|---|
| `main.js` | window, the preview views, sessions, the node table (the only place URLs live) |
| `preload.js` | the entire renderer API — four calls, ids and geometry only |
| `index.html` | the whole UI, no dependencies, no build step |
| `chat/session.js` | the Claude Code session: SDK lifecycle, streaming input, history |
| `chat/permissions.js` | the `canUseTool` bridge - nothing runs until you answer |
| `chat/events.js` | SDK messages to the one shape the transcript renders |
| `chat/ipc.js`, `chat/chat-preload.js` | the chat window's IPC surface |
| `chat/chat.html`, `chat.css`, `chat.js`, `markdown.js` | the conversation UI |
| `make_icon.py` | regenerates `domain.ico` |

Security model: the page can only name one of six node ids and describe a
rectangle — never a URL, path or command. Handlers check the sender is the hub's
own main frame, so a compromised preview cannot reach them. Previews get no
preload, `sandbox: true` and `contextIsolation: true`.

Two previews are kept warm (`WARM_LIMIT` in `main.js`) so switching back is
instant; beyond that the least recently used is dropped to bound memory.

## Not carried over from the old build

The previous version was a Python HTTP server driving a Brave window, and it
could *adopt* a Jira window you already had open by hand. That is gone by
design — the preview is always the app's own view.
