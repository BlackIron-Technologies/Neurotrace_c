const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const Y = require('yjs');
const python = process.env.NEUROTRACE_TEST_PYTHON || 'python';
function run(code, input) {
  const result = spawnSync(python, ['-c', code], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'bin' } });
  if (result.status !== 0) { throw Error(result.stderr); }
  return JSON.parse(result.stdout);
}
const base = run("import json; from neurotrace_sync.text import replace_text; print(json.dumps(replace_text(None,'Inicio 😀 café final')[0]))", null);
const doc = new Y.Doc();
Y.applyUpdate(doc, Buffer.from(base, 'base64'));
const text = doc.getText('text');
text.insert(text.length, ' navegador');
const browser = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
const merged = run("import sys,json; from neurotrace_sync.text import replace_text,merge_text; base,browser=json.load(sys.stdin); _,update,_=replace_text(base,'Python Inicio 😀 café final'); state,text=merge_text(browser,update); print(json.dumps([state,text]))", [base, browser]);
Y.applyUpdate(doc, Buffer.from(merged[0], 'base64'));
assert.equal(text.toString(), 'Python Inicio 😀 café final navegador');
assert.equal(text.toString(), merged[1]);
console.log('PASS: browser Yjs and Python Yrs converge with Unicode edits.');
