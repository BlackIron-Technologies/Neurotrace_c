"""Verify repository guards through the packaged stdio MCP transport."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time

from sync_fixtures import REPOSITORY, git_workspace


def main():
    with tempfile.TemporaryDirectory(prefix='neurotrace-repository-mcp-') as temporary:
        root=git_workspace(Path(temporary)/'checkout')
        (root/'.neurotrace').mkdir()
        conn=sqlite3.connect(root/'.neurotrace/neurotrace.db')
        conn.executescript('CREATE TABLE thoughts(id TEXT PRIMARY KEY,timestamp TEXT,text TEXT,file_path TEXT,line INTEGER,type TEXT,tags TEXT,embedding BLOB,snippet TEXT,priority TEXT,status TEXT); CREATE TABLE relations(id TEXT PRIMARY KEY,src TEXT,dst TEXT,rel TEXT,meta TEXT); CREATE TABLE sync_repository(key TEXT PRIMARY KEY,value TEXT NOT NULL);')
        conn.execute('INSERT INTO sync_repository VALUES(?,?)',('identity',json.dumps(REPOSITORY)))
        conn.execute('INSERT INTO thoughts(id,text,type,timestamp) VALUES(?,?,?,?)',('protected','Protected memory','note','2026-01-01'));conn.commit();conn.close()
        p=subprocess.Popen([os.environ['NEUROTRACE_TEST_EXECUTABLE'],'--mcp','--workspace',str(root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
        sequence=0
        def call(name,args):
            nonlocal sequence
            sequence+=1;p.stdin.write(json.dumps({'jsonrpc':'2.0','id':sequence,'method':'tools/call','params':{'name':name,'arguments':args}})+'\n');p.stdin.flush()
            return json.loads(p.stdout.readline())
        def rejected(response):
            if 'error' in response:return True
            value=json.loads(response['result']['content'][0]['text'])
            return bool(value.get('error') or value.get('success') is False)
        try:
            assert not rejected(call('neurotrace_listThoughts',{}))
            subprocess.run(['git','-C',str(root),'checkout','-b','feature/other'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            assert not rejected(call('neurotrace_listThoughts',{}))
            subprocess.run(['git','-C',str(root),'remote','set-url','origin','https://github.com/wrong/project'],check=True)
            assert rejected(call('neurotrace_listThoughts',{})),'MCP exposed a copied database in another repository'
            assert rejected(call('neurotrace_addThought',{'text':'Forbidden','type':'note'})),'MCP bypassed repository guard'
            print('PASS: packaged MCP permits another branch and blocks wrong-repository reads/writes.')
        finally:
            p.terminate();p.wait(timeout=10)
            endpoint=root/'.neurotrace/standalone_daemon.json'
            if endpoint.exists():os.kill(json.loads(endpoint.read_text())['pid'],15);time.sleep(.3)


if __name__=='__main__':main()
