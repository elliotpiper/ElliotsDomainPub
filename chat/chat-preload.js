/* Everything the chat page can reach. Fifteen calls, all enumerated.
 * None of them can name a file, a host, or an executable - the working
 * directory and the CLI path are decided in main.js. */

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg || {});

contextBridge.exposeInMainWorld('chat', {
  attach:     () => ipcRenderer.invoke('chat:attach', {}),
  newChat:    call('chat:new'),
  send:       call('chat:send'),
  interrupt:  call('chat:interrupt'),
  stop:       call('chat:stop'),
  decide:     call('chat:permission-decide'),
  sessions:   () => ipcRenderer.invoke('chat:sessions', {}),
  history:    call('chat:history'),
  resume:     call('chat:resume'),
  switchTo:   call('chat:switch'),
  rename:     call('chat:rename'),
  slash:      call('chat:slash'),
  openLink:   call('chat:open-link'),

  onEvent: (fn) => ipcRenderer.on('chat:event', (_e, payload) => fn(payload)),
  onSessionsChanged: (fn) => ipcRenderer.on('chat:sessions-changed', () => fn()),
});
