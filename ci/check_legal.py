#!/usr/bin/env python3
"""Legal/support pages gate.

Default (every PR): a legal page that still contains DRAFT/TODO/[placeholder]
text must be noindex and must not be linked from any non-legal page.
--release: fail if ANY legal page still has draft/placeholder text, so a
production release cannot ship them (legal approval is an owner task)."""
import pathlib, re, sys
LEGAL = ['terms.html', 'privacy.html', 'refund.html', 'contact.html']
PUB = pathlib.Path('public')
release = '--release' in sys.argv
DRAFT = re.compile(r'\bDRAFT\b|\bTODO\b|\[[A-Z][^\]<]{2,60}\]')
bad, drafts = [], []
for name in LEGAL:
    p = PUB / name
    if not p.exists():
        continue
    s = p.read_text()
    if DRAFT.search(s):
        drafts.append(name)
        if 'noindex' not in s:
            bad.append(f'{name}: draft legal page is indexable (missing noindex)')
for f in list(PUB.rglob('*.html')) + list(PUB.rglob('*.js')):
    if f.name in LEGAL:
        continue
    s = f.read_text(errors='ignore')
    for name in drafts:
        if re.search(r'["\'/]' + re.escape(name[:-5]) + r'(\.html)?["\'#?/]', s):
            bad.append(f'{f}: links to draft legal page {name}')
if release:
    bad += [f'{n}: still contains DRAFT/TODO/[placeholder] text (owner legal sign-off required)' for n in drafts]
print('\n'.join(bad) or f'legal: OK (draft pages unlinked+noindex: {drafts or "none"})')
sys.exit(1 if bad else 0)
