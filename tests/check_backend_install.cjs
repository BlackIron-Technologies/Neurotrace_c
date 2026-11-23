const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const AdmZip = require('adm-zip');

function load(entry, overrides = {}, globals = {}) {
  const code = esbuild.buildSync({entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false}).outputFiles[0].text;
  const module = {exports: {}};
  vm.runInNewContext(code, {module, exports: module.exports, require: name => overrides[name] || require(name), Buffer, console, process, Atomics, Int32Array, SharedArrayBuffer, ...globals});
  return module.exports;
}
const {activateBackendArchive} = load('src/backendInstall/transaction.ts');

async function fixture(test) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neurotrace-install-'));
  const installRoot = path.join(root, 'installed');
  fs.mkdirSync(installRoot);
  fs.writeFileSync(path.join(installRoot, 'old-version'), '1.1.6');
  const archive = path.join(root, 'download.zip');
  const checksums = path.join(root, 'SHA256SUMS.txt');
  const zip = new AdmZip();
  zip.addFile('neurotrace.exe', Buffer.from('new executable fixture'));
  zip.addFile('_internal/dependency', Buffer.from('dependency fixture'));
  zip.addFile('backend-binary-version.txt', Buffer.from('1.3.4\n'));
  zip.addFile('build-info.json', Buffer.from(JSON.stringify({version: '1.3.4', platform: 'windows'})));
  const save = () => { zip.writeZip(archive); fs.writeFileSync(checksums, crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') + '  neurotrace-windows.zip\n'); };
  save();
  const options = {archive, checksums, installRoot, platform: 'windows', version: '1.3.4', readVersion: () => '1.3.4', beforeActivate: () => {}};
  try { await test({root, zip, save, options, previous: () => fs.readFileSync(path.join(installRoot, 'old-version'), 'utf8')}); }
  finally { fs.rmSync(root, {recursive: true, force: true}); }
}

async function main() {
  await fixture(async ({options, previous, root}) => {
    let stopped = false;
    options.readVersion = executable => { assert.equal(previous(), '1.1.6'); assert.equal(stopped, false); assert.ok(fs.existsSync(executable)); return '1.3.4'; };
    options.beforeActivate = async () => { assert.equal(previous(), '1.1.6'); stopped = true; };
    const executable = await activateBackendArchive(options);
    assert.equal(stopped, true);
    assert.equal(fs.readFileSync(executable, 'utf8'), 'new executable fixture');
    assert.equal(fs.existsSync(path.join(options.installRoot, 'old-version')), false);
    assert.equal(fs.readdirSync(root).some(name => name.startsWith('.neurotrace-')), false);
  });
  await fixture(async ({options, previous}) => {
    fs.writeFileSync(options.checksums, '0'.repeat(64) + '  neurotrace-windows.zip\n');
    options.beforeActivate = () => assert.fail('Must not stop the old backend for an invalid download');
    await assert.rejects(activateBackendArchive(options), /checksum/);
    assert.equal(previous(), '1.1.6');
  });
  await fixture(async ({options, previous}) => {
    options.readVersion = () => '1.1.6';
    options.beforeActivate = () => assert.fail('Must not activate an incompatible executable');
    await assert.rejects(activateBackendArchive(options), /required backend version/);
    assert.equal(previous(), '1.1.6');
  });
  await fixture(async ({options, previous}) => {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (path.basename(from).startsWith('.neurotrace-stage-') && to === options.installRoot) { throw new Error('Simulated locked target'); }
      return rename(from, to);
    };
    try { await assert.rejects(activateBackendArchive(options), /locked target/); }
    finally { fs.renameSync = rename; }
    assert.equal(previous(), '1.1.6');
  });
  await fixture(async ({zip, save, options, previous}) => {
    zip.addFile('C:/escape.exe', Buffer.from('unsafe path'));
    save();
    await assert.rejects(activateBackendArchive(options), /unsafe entry/);
    assert.equal(previous(), '1.1.6');
  });
  const killed = [];
  const {stopInstalledBackends} = load('src/backendInstall/processes.ts', {
    os: {platform: () => 'linux'}, path: path.posix,
    child_process: {spawnSync: () => ({status: 0, stdout: '101 /home/test/backend/neurotrace --daemon\n102 /home/test/backend-other/neurotrace\n103 /usr/bin/python /home/test/backend/script.py\n'})}
  }, {process: {kill: (pid, signal) => { if (signal === 0) { throw Object.assign(new Error('gone'), {code: 'ESRCH'}); } killed.push(pid); }}});
  stopInstalledBackends('/home/test/backend');
  assert.deepEqual(killed, [101]);
  let windowsScript = '';
  const windows = load('src/backendInstall/processes.ts', {
    os: {platform: () => 'win32'}, path: path.win32,
    child_process: {spawnSync: (_command, args) => { windowsScript = Buffer.from(args.at(-1), 'base64').toString('utf16le'); return {status: 0}; }}
  });
  windows.stopInstalledBackends("C:\\Users\\O'Brien\\NeuroTrace");
  assert.ok(windowsScript.includes("C:\\Users\\O''Brien\\NeuroTrace\\"));
  assert.ok(windowsScript.includes('WaitForExit'));
  const config = require('../src/config.json');
  const {BackendDownloader} = load('src/BackendDownloader.ts', {
    vscode: {ExtensionMode: {Production: 1}},
    https: {get: (_url, options, callback) => { assert.equal(options.method, 'HEAD'); callback({statusCode: 302}); return {on() {}}; }}
  });
  const downloader = new BackendDownloader({extensionMode: 1});
  for (const [osName, asset] of [['win32', 'windows'], ['darwin', 'macos'], ['linux', 'linux']]) {
    assert.equal(downloader.getPlatformName(osName), asset);
    assert.equal(await downloader.getDownloadUrl('99.0.0', asset), `https://github.com/${config.githubRepo}/releases/download/${config.minimumBackendVersion}/neurotrace-${asset}.zip`);
  }
  console.log('PASS: verified upgrades, failure preservation, rollback, unsafe archive rejection and scoped process shutdown.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
