"""Per-user scheduler definitions and server launchers."""
import json
from datetime import datetime, timedelta
import plistlib
import shlex
import subprocess
from xml.sax.saxutils import escape


def windows_launcher(command, database, port, home, log):
    quote = lambda s: "'" + str(s).replace("'", "''") + "'"
    fallback = ','.join(quote(s) for s in command)
    return f'''[System.IO.File]::WriteAllText({quote(log.parent / 'runner.pid')}, [string]$PID)
$fallback = @({fallback})
while ($true) {{
  $candidates = @({quote(home / 'AppData/Local/Programs/NeuroTrace/neurotrace.exe')}, {quote(home / 'AppData/Local/Programs/NeuroTrace/neurotrace-windows/neurotrace.exe')})
  foreach ($editor in @('.vscode', '.cursor')) {{
    Get-ChildItem -Path (Join-Path $env:USERPROFILE "$editor/extensions") -Directory -Filter 'blackirontechnologies.neurotrace-*' -ErrorAction SilentlyContinue | ForEach-Object {{ $candidates += Join-Path $_.FullName 'bin/dist/neurotrace-windows/neurotrace.exe' }}
  }}
  $baseProgram = $fallback[0]; $baseArgs = @($fallback | Select-Object -Skip 1)
  $selected = $null; $version = [version]'0.0.0'
  try {{ $version = [version](& $baseProgram @baseArgs --version) }} catch {{ Add-Content -LiteralPath {quote(log)} -Value $_ }}
  foreach ($candidate in $candidates) {{
    if (Test-Path -LiteralPath $candidate) {{
      try {{ $candidateVersion = [version](& $candidate --version); if ($candidateVersion -gt $version) {{ $selected = $candidate; $version = $candidateVersion }} }} catch {{ Add-Content -LiteralPath {quote(log)} -Value $_ }}
    }}
  }}
  $entry = @(if ($selected) {{ $selected }} else {{ $fallback }})
  Add-Content -LiteralPath {quote(log)} -Value "$(Get-Date -Format o) starting background server"
  $program = $entry[0]; $arguments = @($entry | Select-Object -Skip 1)
  & $program @arguments --sync-server --database {quote(database)} --port {port} >> {quote(log)} 2>&1
  Add-Content -LiteralPath {quote(log)} -Value "$(Get-Date -Format o) exited $LASTEXITCODE; retrying in 10 seconds"
  Start-Sleep -Seconds 10
}}
'''


def posix_launcher(command, database, port, home, log):
    q = shlex.quote
    candidates = [home / '.local/share/neurotrace/neurotrace', home / '.local/share/neurotrace/neurotrace-linux/neurotrace',
                  home / 'Library/Application Support/NeuroTrace/neurotrace',
                  home / 'Library/Application Support/NeuroTrace/neurotrace-macos/neurotrace']
    patterns = ' '.join(q(str(home / editor / 'extensions')) + '/blackirontechnologies.neurotrace-*/bin/dist/neurotrace-*/neurotrace' for editor in ('.vscode', '.cursor'))
    return f'''#!/bin/sh
printf '%s' "$$" > {q(str(log.parent / 'runner.pid'))}
child=''
trap 'if [ -n "$child" ]; then kill "$child" 2>/dev/null; wait "$child"; fi; exit 0' TERM INT HUP
while :; do
  selected=$({{
    if version=$({' '.join(q(str(p)) for p in command)} --version); then
      printf '%s\\t__fallback__\\n' "$version"
    fi
    for candidate in {' '.join(q(str(p)) for p in candidates)} {patterns}; do
    if [ -x "$candidate" ]; then
      version=$("$candidate" --version) || continue
      printf '%s\\t%s\\n' "$version" "$candidate"
    fi
  done
  }} | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | cut -f2-)
  if [ -n "$selected" ] && [ "$selected" != '__fallback__' ]; then set -- "$selected"; else set -- {' '.join(q(str(p)) for p in command)}; fi
  "$@" --sync-server --database {q(str(database))} --port {port} >> {q(str(log))} 2>&1 &
  child=$!
  wait "$child"
  result=$?
  child=''
  printf 'Server exited %s; retrying in 10 seconds\\n' "$result" >> {q(str(log))}
  sleep 10 &
  child=$!
  wait "$child"
  child=''
done
'''


def windows_task(launcher, user):
    arguments = subprocess.list2cmdline(['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', str(launcher)])
    start = (datetime.now().astimezone() + timedelta(minutes=1)).isoformat(timespec='seconds')
    return f'''<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>{start}</StartBoundary><Enabled>true</Enabled></TimeTrigger><LogonTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled><UserId>{escape(user)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>{escape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>{escape(arguments)}</Arguments></Exec></Actions></Task>'''


def launch_agent(launcher, log, label):
    return plistlib.dumps({'Label': label, 'ProgramArguments': ['/bin/sh', str(launcher)],
                          'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
                          'StandardOutPath': str(log), 'StandardErrorPath': str(log)})


def systemd_unit(launcher):
    path = json.dumps(str(launcher)).replace('%', '%%')
    return f'''[Unit]
Description=NeuroTrace background synchronization server
StartLimitIntervalSec=0
[Service]
Type=simple
ExecStart=/bin/sh {path}
Restart=on-failure
RestartSec=10
KillMode=control-group
[Install]
WantedBy=default.target
'''
