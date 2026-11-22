const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');

function load(entry) {
    const moduleValue = { exports: {} };
    const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
    vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports });
    return moduleValue.exports;
}

const { selectCodexBackendCommand } = load('src/mcp/config/codexCommand.ts');
const { buildCodexWslToml } = load('src/mcp/config/templates.ts');
const parse = text => ({
    command: JSON.parse(text.match(/^command = (.+)$/m)[1]),
    args: JSON.parse(text.match(/^args = (.+)$/m)[1]),
});

const compiled = {
    darwin: '/Users/dev/Library/Application Support/NeuroTrace/neurotrace',
    linux: '/home/dev/.local/share/neurotrace/neurotrace',
};
for (const [platform, executable] of Object.entries(compiled)) {
    const toml = parse(buildCodexWslToml(selectCodexBackendCommand(platform, executable), '/work/DO-NOT-PIN', true));
    assert.equal(toml.command, executable, `${platform} launches the compiled backend`);
    assert.deepEqual(toml.args, ['--mcp', '--workspace', '.'], `${platform} follows the active workspace`);
    assert.ok(!JSON.stringify(toml).includes('python3'), `${platform} never launches the Python script`);
    assert.throws(() => selectCodexBackendCommand(platform, null), /Install the NeuroTrace backend/);
}

assert.equal(selectCodexBackendCommand('win32', 'C:/NeuroTrace/neurotrace.exe'), 'C:/NeuroTrace/neurotrace.exe');
assert.throws(() => selectCodexBackendCommand('win32', 'C:/NeuroTrace/neurotrace.py'), /Windows NeuroTrace backend/);
assert.throws(() => selectCodexBackendCommand('win32', null), /Windows NeuroTrace backend/);

console.log('PASS: Codex MCP launches the compiled backend on macOS, Linux and Windows.');
