import * as Y from 'yjs';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): { document?: string; queue?: string[]; inFlight?: string } | undefined;
};

const bridge = acquireVsCodeApi();
const editor = document.getElementById('text') as HTMLTextAreaElement;
const stateLabel = document.getElementById('state')!;
const errorLabel = document.getElementById('error')!;
const doc = new Y.Doc();
const text = doc.getText('text');
let saving = false;
let initialized = false;
let queue: Uint8Array[] = [];
let inFlight: Uint8Array | undefined;
const encode = (value: Uint8Array) => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''));
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

function persist() { bridge.setState({ document: encode(Y.encodeStateAsUpdate(doc)), queue: queue.map(encode), inFlight: inFlight ? encode(inFlight) : undefined }); }
function flush() {
  if (saving || !queue.length || !initialized) { return; }
  saving = true;
  inFlight = Y.mergeUpdates(queue);
  bridge.postMessage({ type: 'update', update: encode(inFlight) });
  queue = [];
  stateLabel.textContent = 'Saving on this device…';
  persist();
}
doc.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin === 'remote') { return; }
  queue.push(update);
  persist();
  flush();
});
const restored = bridge.getState();
if (restored?.document) { Y.applyUpdate(doc, decode(restored.document), 'remote'); }
if (restored?.queue) { queue = restored.queue.map(decode); }
if (restored?.inFlight) { queue.unshift(decode(restored.inFlight)); }

editor.addEventListener('input', () => {
  const before = text.toString(), after = editor.value;
  let start = 0, suffix = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) { start++; }
  // Keep surrogate pairs whole at the edit boundary.
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start - 1])) { start--; }
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - suffix - 1] === after[after.length - suffix - 1]) { suffix++; }
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(before[before.length - suffix])) { suffix--; }
  doc.transact(() => {
    const remove = before.length - start - suffix;
    if (remove > 0) { text.delete(start, remove); }
    const insert = after.slice(start, after.length - suffix);
    if (insert) { text.insert(start, insert); }
  }, 'local');
});

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'context' || message.type === 'saved') {
    const context = message.context;
    if (context.document) {
      const selectionStart = Y.createRelativePositionFromTypeIndex(text, Math.min(editor.selectionStart, text.length));
      const selectionEnd = Y.createRelativePositionFromTypeIndex(text, Math.min(editor.selectionEnd, text.length));
      Y.applyUpdate(doc, decode(context.document), 'remote');
      editor.value = text.toString();
      const a = Y.createAbsolutePositionFromRelativePosition(selectionStart, doc);
      const b = Y.createAbsolutePositionFromRelativePosition(selectionEnd, doc);
      if (a && b) { editor.setSelectionRange(a.index, b.index); }
    }
    initialized = true;
    editor.readOnly = context.deleted || context.sync.role === 'viewer' || context.sync.state === 'access_denied';
    if (context.deleted) { errorLabel.textContent = 'This memory was deleted. Copy your text to preserve it as a new memory.'; errorLabel.hidden = false; }
    const sync = context.sync;
    const delivery = sync.delivery;
    stateLabel.textContent = sync.pending_operations ? 'Saved locally · Waiting for server confirmation' :
      delivery?.received_by_devices ? 'Confirmed by server · Received by ' + delivery.received_by_devices + ' other device(s)' :
      delivery?.state === 'server_confirmed' ? 'Confirmed by server · No other device has acknowledged yet' :
      'Saved locally · Changes sync when connected';
    if (message.type === 'saved') { saving = false; inFlight = undefined; }
    persist();
    flush();
  }
  if (message.type === 'error') { errorLabel.hidden = false; errorLabel.textContent = message.message + ' Your text is still here; use Copy my text to save a draft.'; editor.readOnly = true; }
});
document.getElementById('copy')!.onclick = () => bridge.postMessage({ type: 'copy', text: editor.value });
bridge.postMessage({ type: 'ready' });
