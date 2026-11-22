"""Exercise packaged MCP contracts without a desktop credential store."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time


def main():
    with tempfile.TemporaryDirectory(prefix='neurotrace-mcp-smoke-') as temporary:
        workspace = Path(temporary)
        (workspace / '.neurotrace').mkdir()
        conn = sqlite3.connect(workspace / '.neurotrace' / 'neurotrace.db')
        conn.executescript('CREATE TABLE thoughts(id TEXT PRIMARY KEY,timestamp TEXT,text TEXT,file_path TEXT,line INTEGER,type TEXT,tags TEXT,embedding BLOB,snippet TEXT,priority TEXT,status TEXT); CREATE TABLE relations(id TEXT PRIMARY KEY,src TEXT,dst TEXT,rel TEXT,meta TEXT);')
        conn.close()
        process = subprocess.Popen([os.environ['NEUROTRACE_TEST_EXECUTABLE'], '--mcp', '--workspace', str(workspace)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    text=True, encoding='utf-8')
        sequence = 0

        def call(method, params=None):
            nonlocal sequence
            sequence += 1
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params or {}}) + '\n')
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            assert 'error' not in response, response
            return response['result']

        def tool(name, arguments):
            return json.loads(call('tools/call', {'name': name, 'arguments': arguments})['content'][0]['text'])

        try:
            call('initialize')
            definitions = {item['name'] for item in call('tools/list')['tools']}
            assert {'neurotrace_sync', 'neurotrace_getThought', 'neurotrace_host', 'neurotrace_connect', 'neurotrace_team', 'neurotrace_repository'} <= definitions
            status = tool('neurotrace_sync', {'action': 'status'})
            assert status['state'] == 'unconfigured', status
            created = tool('neurotrace_addThought', {'text': 'Packaged MCP check', 'type': 'note'})
            memory = tool('neurotrace_getThought', {'thought_id': created['id']})
            assert memory['base_text'] == 'Packaged MCP check', memory
            result = tool('neurotrace_sync', {'action': 'wait', 'thought_id': 'absent', 'timeout_ms': 100})
            assert result['success'] is False and result['reason'] == 'unconfigured', result
            print('PASS: packaged MCP lists new tools, reads memory/base_text and reports sync state.')
        finally:
            process.terminate()
            process.wait(timeout=10)
            endpoint = workspace / '.neurotrace' / 'standalone_daemon.json'
            if endpoint.exists():
                os.kill(json.loads(endpoint.read_text())['pid'], 15)
                time.sleep(0.3)


if __name__ == '__main__':
    main()
