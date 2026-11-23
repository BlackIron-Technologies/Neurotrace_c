/* Render the real settings view with an isolated backend fixture. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright');
fs.mkdirSync(output, {recursive: true});
esbuild.buildSync({entryPoints: [path.join(root, 'src/settings/view.ts')], bundle: true, platform: 'node',
  external: ['vscode'], outfile: path.join(output, 'view.cjs')});
const load = Module._load;
Module._load = function(name, ...args) {
  return name === 'vscode' ? {Uri: {joinPath: (base, ...parts) => ({path: base.path + '/' + parts.join('/')})}} : load.call(this, name, ...args);
};
const {settingsHtml} = require(path.join(output, 'view.cjs'));
let html = settingsHtml({cspSource: "'self'", asWebviewUri: uri => uri.path}, {path: '/media/settings'});
const nonce = html.match(/nonce-([^']+)/)[1];
const fixture = `
window.fixtureMessages = [];
const emit = message => window.dispatchEvent(new MessageEvent('message', {data: message}));
const workspace = {name: 'Acceptance project', path: '/project', local: {ready: true, count: 2, repository: {origin: 'https://github.com/tests/project', scope: ''}}};
const validation = valid => ({valid, transformations: valid ? [{id:'old',field:'type'},{id:'old',field:'file_path'}] : [], issues: valid ? [] : [{id:'old',field:'type',value:'finding',error:'Invalid memory type'},{id:'old',field:'file_path',error:'Code reference is outside this workspace',suggested_path:'src/file.ts'}]});
const hosting = installed => ({running:true,url:'http://127.0.0.1:9473',service:{installed,log:'/service/server.log'}});
window.acquireVsCodeApi = () => ({postMessage(message) {
  window.fixtureMessages.push(message);
  setTimeout(() => {
    if (message.type === 'ready') { emit({type:'status',status:{state:'unconfigured'}}); emit({type:'workspace',workspace}); emit({type:'hosting',hosting:hosting(false)}); }
    if (message.type === 'workspace-info') { emit({type:'workspace',workspace}); }
    if (message.type === 'preview-connection') { emit({type:'invitation-preview',requestId:message.requestId,result:{project_name:'Test project',network_name:'Test network',actor_name:'Owner',kind:'device',role:'owner',import_validation:validation(false)}}); }
    if (message.type === 'import-preview') { emit({type:'import-preview',result:validation(message.pathPolicy === 'remap' && message.typeMap.finding === 'insight')}); }
    if (message.type === 'service-install' || message.type === 'service-uninstall') { emit({type:'hosting',hosting:hosting(message.type === 'service-install')}); }
    if (message.type === 'connect') { emit({type:'connected'}); emit({type:'status',status:{state:'live',project_id:'test',project_name:'Test project',actor_name:'Owner',role:'owner',server_url:'https://memory.example.test',synced:true,enabled:true}}); }
  }, 0);
}});
`;
html = html.replace(/<script nonce=/, '<script nonce="' + nonce + '">' + fixture + '</script><script nonce=');
fs.writeFileSync(path.join(output, 'settings.html'), html);
console.log('Settings fixture: output/playwright/settings.html');
