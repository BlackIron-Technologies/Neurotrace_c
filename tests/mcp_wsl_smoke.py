"""Exercise one WSL launcher against two native Windows workspace daemons."""
import json
import os
import ctypes
from pathlib import Path
import sqlite3
import socket
import subprocess
import tempfile
import time

from sync_fixtures import git_workspace


def main():
    config=json.loads(subprocess.check_output(['node','tests/check_mcp_launchers.cjs','--json'],text=True))
    with tempfile.TemporaryDirectory(prefix='neurotrace-interop-') as temporary:
        directories=[]
        try:
            for number in [101,202]:
                directory=git_workspace(Path(temporary)/str(number));(directory/'.neurotrace').mkdir();directories.append(directory)
                with sqlite3.connect(directory/'.neurotrace/neurotrace.db') as conn:
                    conn.executescript('CREATE TABLE thoughts(id TEXT PRIMARY KEY,timestamp TEXT,text TEXT,file_path TEXT,line INTEGER,type TEXT,tags TEXT,embedding BLOB,snippet TEXT,priority TEXT,status TEXT); CREATE TABLE relations(id TEXT PRIMARY KEY,src TEXT,dst TEXT,rel TEXT,meta TEXT);')
                    conn.executemany('INSERT INTO thoughts(id,text,type,timestamp) VALUES(?,?,?,?)', [(str(i),'Workspace '+str(number),'note','2026-01-01') for i in range(number)])
                conn.close()
                request={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'neurotrace_getDatabaseStatus','arguments':{}}}
                result=subprocess.run([config['command'],*config['args']],cwd=directory,input=json.dumps(request)+'\n',stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',timeout=25)
                assert result.returncode==0,result.stderr
                response=json.loads(result.stdout.strip())
                assert 'error' not in response,response
                value=json.loads(response['result']['content'][0]['text'])
                assert value['total_thoughts']==number,value
                endpoint=json.loads((directory/'.neurotrace/standalone_daemon.json').read_text())
                assert endpoint['protocol']==2 and endpoint['workspace']==str(directory.resolve()),endpoint
                print('WSL -> native Windows daemon selected caller workspace',number,flush=True)
            print('PASS: one global launcher serves two caller directories without a pinned workspace or Linux SQLite access.')
        finally:
            for directory in directories:
                endpoint=directory/'.neurotrace/standalone_daemon.json'
                if endpoint.exists():
                    info=json.loads(endpoint.read_text())
                    assert info['workspace']==str(directory.resolve())
                    with socket.create_connection((info['host'],info['port']),timeout=10) as connection:
                        connection.sendall((json.dumps({'id':1,'token':info['token'],'workspace':str(directory.resolve()),'command':'exit','payload':{}})+'\n').encode())
                        assert json.loads(connection.makefile('rb').readline())['success']
                    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
                    kernel.OpenProcess.restype=ctypes.c_void_p
                    kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
                    kernel.CloseHandle.argtypes=[ctypes.c_void_p]
                    handle=kernel.OpenProcess(0x100000,False,info['pid'])
                    assert handle
                    try:
                        os.kill(info['pid'],15)
                        assert kernel.WaitForSingleObject(handle,10000)==0
                    finally:
                        kernel.CloseHandle(handle)
            time.sleep(.5)


if __name__=='__main__':main()
