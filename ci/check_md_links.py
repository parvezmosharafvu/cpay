#!/usr/bin/env python3
"""Fail on broken local links in tracked Markdown files.

Checks that [text](relative/path) targets inside the repository exist. For
[text](relative/path#anchor) only the file is checked; the #anchor is not. External (http/https/mailto) links are not
fetched: CI must not depend on third-party uptime.
"""
import re, subprocess, sys, pathlib, urllib.parse

root = pathlib.Path(__file__).resolve().parent.parent
tracked = subprocess.run(['git', 'ls-files', '-z', '*.md'], cwd=root, capture_output=True, text=True)
if tracked.returncode == 0:
    files = [f for f in tracked.stdout.split('\0') if f]
else:
    # Source ZIP exports have no .git directory. Do not scan dependencies.
    if (root / '.git').exists():
        sys.exit(tracked.stderr.strip() or 'Unable to enumerate tracked Markdown files')
    excluded = {'.git', 'node_modules', '.venv', 'vendor'}
    files = sorted(str(p.relative_to(root)) for p in root.rglob('*.md')
                   if not excluded.intersection(p.relative_to(root).parts))
    print('Source archive: checking Markdown files without Git metadata.')
link = re.compile(r'(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|!\[[^\]]*\]\(([^)\s]+)\)')
bad = []
for f in files:
    p = root / f
    text = p.read_text(encoding='utf-8', errors='replace')
    text = re.sub(r'```.*?```', '', text, flags=re.S)
    text = re.sub(r'`[^`\n]*`', '', text)
    for m in link.finditer(text):
        target = m.group(1) or m.group(2)
        if re.match(r'^[a-z][a-z0-9+.-]*:', target, re.I) or target.startswith('#'):
            continue
        path = urllib.parse.unquote(target.split('#', 1)[0])
        if not path:
            continue
        dest = (root / path.lstrip('/')) if path.startswith('/') else (p.parent / path)
        if not dest.exists():
            bad.append(f'{f}: {target}')
if bad:
    print('Broken local Markdown links:')
    print('\n'.join(bad))
    sys.exit(1)
print(f'Markdown links OK across {len(files)} files.')
