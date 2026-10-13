#!/usr/bin/env python3
"""Fail if a workflow uses an action not pinned to a full commit SHA, or has
no top-level `permissions:` block (least privilege)."""
import pathlib, re, sys
bad = []
for f in sorted(pathlib.Path('.github/workflows').glob('*.y*ml')):
    s = f.read_text()
    if not re.search(r'^permissions:\s*$', s, re.M):
        bad.append(f'{f}: no top-level permissions block')
    for n, line in enumerate(s.splitlines(), 1):
        m = re.match(r'\s*-?\s*uses:\s*([^\s#]+)', line)
        if m and not m.group(1).startswith('./') and not re.search(r'@[0-9a-f]{40}$', m.group(1)):
            bad.append(f'{f}:{n}: {m.group(1)} is not pinned to a commit SHA')
print('\n'.join(bad) or 'workflows: all actions SHA-pinned, permissions declared')
sys.exit(1 if bad else 0)
