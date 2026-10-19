#!/usr/bin/env python3
"""Legal/support pages gate.

The owner's legal fields (entity, address, effective date, jurisdiction,
courts, privacy and support email) live in Admin → Settings
(platform_settings, migration 20261020010000). A page marks each one as
<span data-legal="KEY">[Label]</span>; public/legal-fields.js fills them in
and removes the "not yet published" note and noindex once the owner turns
on legal_published (allowed only when every field is filled).

Default (every PR):
  * no DRAFT/TODO/[placeholder] text outside data-legal fields;
  * every data-legal key is a known legal setting;
  * the pages stay noindex in the static HTML and are not linked from any
    other page or script, except public/site-settings.js, which adds the
    footer links only when legal_published is on.
--release: additionally ask production (get_public_site_settings, the
public anon RPC) whether legal_published is on. --settings-file FILE reads
that JSON from a file instead (offline / tests)."""
import json, pathlib, re, sys, urllib.request

LEGAL = ['terms.html', 'privacy.html', 'refund.html', 'contact.html']
KEYS = {'legal_entity_name', 'legal_address', 'legal_effective_date', 'legal_jurisdiction',
        'legal_courts', 'legal_privacy_email', 'legal_support_email'}
LINK_ALLOWED = {'site-settings.js'}
PUB = pathlib.Path('public')
FIELD = re.compile(r'<span data-legal="([a-z_]+)">\[[^\]<]{2,60}\]</span>')
DRAFT = re.compile(r'\bDRAFT\b|\bTODO\b|\[[A-Z][^\]<]{2,60}\]')
args = sys.argv[1:]
release = '--release' in args
bad = []
for name in LEGAL:
    p = PUB / name
    if not p.exists():
        bad.append(f'{name}: missing')
        continue
    s = p.read_text()
    for k in FIELD.findall(s):
        if k not in KEYS:
            bad.append(f'{name}: unknown legal field {k}')
    if DRAFT.search(FIELD.sub('', s)):
        bad.append(f'{name}: DRAFT/TODO/[placeholder] text outside the owner legal fields')
    if 'noindex' not in s:
        bad.append(f'{name}: static page must stay noindex (legal-fields.js removes it once published)')
    if 'legal-fields.js' not in s:
        bad.append(f'{name}: does not load legal-fields.js')
for f in list(PUB.rglob('*.html')) + list(PUB.rglob('*.js')):
    if f.name in LEGAL or f.name in LINK_ALLOWED:
        continue
    s = f.read_text(errors='ignore')
    for name in LEGAL:
        if re.search(r'["\'/]' + re.escape(name[:-5]) + r'(\.html)?["\'#?/]', s):
            bad.append(f'{f}: links to legal page {name} (only site-settings.js may, when published)')

if release and not bad:
    try:
        if '--settings-file' in args:
            data = json.loads(pathlib.Path(args[args.index('--settings-file') + 1]).read_text())
        else:
            cfg = (PUB / 'config.js').read_text()
            url = re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", cfg).group(1)
            key = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']+)'", cfg).group(1)
            req = urllib.request.Request(url + '/rest/v1/rpc/get_public_site_settings', data=b'{}', method='POST',
                                         headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
            data = json.loads(urllib.request.urlopen(req, timeout=15).read())
    except Exception as e:  # noqa: BLE001
        data = None
        bad.append(f'could not read the published legal settings ({type(e).__name__})')
    if data is not None:
        missing = sorted(k for k in KEYS if not str(data.get(k) or '').strip())
        if missing:
            bad.append('legal fields not filled in Admin → Settings: ' + ', '.join(missing))
        if data.get('legal_published') is not True:
            bad.append('legal pages not published (Admin → Settings → Legal pages → Publish)')

print('\n'.join(bad) or ('legal: OK (published)' if release else 'legal: OK (fields from settings; unlinked and noindex until published)'))
sys.exit(1 if bad else 0)
