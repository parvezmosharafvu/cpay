#!/usr/bin/env python3
"""
Static checks on the public pages.

Kept as a real file rather than a heredoc inside the workflow: an
indented heredoc terminator inside a shell loop does not terminate,
which is exactly how the first version of this job broke.

Checks, in order of how often each has actually caught something here:
  1. <script> blocks parse as JavaScript
  2. every getElementById / el() target exists in the markup
  3. every inline on* handler is a defined function
  4. every rpc() call names a real function and passes real parameters
  5. payment surfaces keep accessible controls and QR ownership guards
  6. admin release gates stay server-backed and audited
  7. the payment processor is not named on any non-admin page
  8. no traditional payment method (bKash, Nagad, Binance Pay, bank) is
     named anywhere in public/; plain "bank" is a word match
  9. wallets-config.js entries are well formed: verified entries cite a
     source and date, and handoff links use an allowed scheme
"""
import glob
import re
import subprocess
import sys
import tempfile
import os

failures: list[str] = []


def check_js_syntax() -> None:
    for path in sorted(glob.glob("public/*.html")):
        with open(path, encoding="utf-8") as fh:
            blocks = re.findall(r"<script>(.*?)</script>", fh.read(), re.S)
        if not blocks:
            continue
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
            fh.write("\n;\n".join(blocks))
            tmp = fh.name
        proc = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
        os.unlink(tmp)
        if proc.returncode:
            first = next((l for l in proc.stderr.splitlines() if l.strip()), "syntax error")
            failures.append(f"{path}: JavaScript syntax — {first.strip()}")
        else:
            print(f"ok   {path} (js)")

    for path in sorted(glob.glob("public/*.js")):
        proc = subprocess.run(["node", "--check", path], capture_output=True, text=True)
        if proc.returncode:
            failures.append(f"{path}: JavaScript syntax")
        else:
            print(f"ok   {path} (js)")


def check_dom_references() -> None:
    for path in sorted(glob.glob("public/*.html")):
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        ids = set(re.findall(r'id="([\w-]+)"', src))
        used = set(re.findall(r"getElementById\('([\w-]+)'\)", src)) | set(
            re.findall(r"(?<![\w.])el\('([\w-]+)'\)", src)
        )
        handlers = set(re.findall(r'on(?:click|change|input|submit)="(\w+)\(', src))
        defined = set(re.findall(r"(?:async )?function (\w+)\(", src))

        for missing in sorted(used - ids):
            failures.append(f"{path}: references #{missing}, which is not in the markup")
        for undef in sorted(handlers - defined):
            failures.append(f"{path}: on-handler {undef}() is not defined")
        if not (used - ids) and not (handlers - defined):
            print(f"ok   {path} (dom)")


def check_rpc_signatures() -> None:
    sql = "\n".join(
        open(f, encoding="utf-8").read()
        for f in sorted(glob.glob("supabase/migrations/*.sql"))
    )
    defs: dict[str, set[str]] = {
        m.group(1): set(re.findall(r"\b(p_\w+)\s", m.group(2)))
        for m in re.finditer(r"create or replace function (?:public\.)?(\w+)\s*\(([^)]*)\)", sql, re.S)
    }

    for path in sorted(glob.glob("public/*.html") + glob.glob("public/*.js")):
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        ok = True
        for m in re.finditer(r"rpc\('(\w+(?:\.\w+)?)'(?:,\s*\{(.*?)\})?\)", src, re.S):
            name, args = m.group(1), m.group(2) or ""
            lookup = name.split('.')[-1]
            if lookup not in defs:
                failures.append(f"{path}: rpc('{name}') has no SQL definition")
                ok = False
                continue
            if extra := set(re.findall(r"(p_\w+)\s*:", args)) - defs[lookup]:
                failures.append(
                    f"{path}: rpc('{name}') passes {sorted(extra)}; "
                    f"the function accepts {sorted(defs[lookup])}"
                )
                ok = False
        if ok:
            print(f"ok   {path} (rpc)")


def check_reserved_slug_lists() -> None:
    sql = "\n".join(
        open(f, encoding="utf-8").read()
        for f in sorted(glob.glob("supabase/migrations/*.sql"))
    )
    bodies = re.findall(
        r"create or replace function validate_link_slug.*?\$\$;", sql, re.S | re.I
    )
    if not bodies:
        failures.append("validate_link_slug() not found in migrations")
        return
    canonical = set(re.findall(r"'([a-z0-9-]+)'", bodies[-1]))

    sources = {
        "public/404.html": r"RESERVED\s*=\s*(?:new Set\()?\[(.*?)\]",
        "public/dashboard.html": r"RESERVED\s*=\s*(?:new Set\()?\[(.*?)\]",
        "worker/og-preview-worker.js": r"RESERVED\s*=\s*new Set\(\[(.*?)\]",
    }
    for rel, pattern in sources.items():
        if not os.path.exists(rel):
            failures.append(f"{rel}: file missing")
            continue
        with open(rel, encoding="utf-8") as fh:
            m = re.search(pattern, fh.read(), re.S)
        if not m:
            failures.append(f"{rel}: no RESERVED list found")
            continue
        found = set(re.findall(r"['\"]([a-z0-9-]+)['\"]", m.group(1)))
        missing = sorted(canonical - found)
        if missing:
            failures.append(
                f"{rel}: reserved-slug list is missing {missing} — the database "
                f"would reject these but this copy would not"
            )
        else:
            print(f"ok   {rel} (reserved slugs)")


def check_payment_accessibility_and_qr() -> None:
    pages = {
        "public/404.html": [
            'id="amountDisplay"',
            'role="status" aria-live="polite"',
            'id="quickToggle" aria-expanded="false"',
            'id="classicInput"',
            'aria-label="Payment amount"',
            'id="payBtn" type="button"',
            'data-key="1" aria-label=',
            'data-key="back" aria-label="Backspace"',
        ],
        "public/invoice-cpay-v2.html": [
            'id="qrLink" class="qr-link-button" type="button"',
            'id="qrcode"',
            'id="timerPill" role="timer"',
            'id="copyBtn" class="pill-btn btn-copy" type="button"',
            'id="payBtn" class="pill-btn btn-pay" type="button"',
            'id="modalCloseBtn" type="button" aria-label=',
            'id="otherWalletsBtn"',
            'role="dialog" aria-modal="true" aria-labelledby="walletSheetTitle"',
            'id="statePanel" role="status" aria-live="polite"',
            'src="wallets-config.js"',
        ],
    }
    for rel, needles in pages.items():
        try:
            with open(rel, encoding="utf-8") as fh:
                src = fh.read()
        except OSError:
            failures.append(f"{rel}: file missing")
            continue
        missing = [needle for needle in needles if needle not in src]
        if missing:
            failures.append(f"{rel}: accessibility contract missing {missing}")
        else:
            print(f"ok   {rel} (payment accessibility)")

    qr = "supabase/migrations/0068_onchain_address_book.sql"
    try:
        with open(qr, encoding="utf-8") as fh:
            src = fh.read().lower()
    except OSError:
        failures.append(f"{qr}: file missing")
        return
    guards = [
        "alter table onchain_addresses enable row level security",
        "using (user_id = auth.uid() or is_admin())",
        "drop policy if exists \"onchain owner insert\"",
        "drop policy if exists \"onchain owner update\"",
        "drop policy if exists \"onchain owner delete\"",
        "and (user_id = auth.uid() or is_admin())",
        "on conflict (user_id, address)",
        "cpay_valid_onchain_address",
    ]
    missing = [guard for guard in guards if guard not in src]
    if missing:
        failures.append(f"{qr}: QR ownership/validation guard missing {missing}")
    else:
        print(f"ok   {qr} (QR ownership guards)")


def check_admin_release_gates() -> None:
    """Keep the staging sign-off ledger connected to guarded RPCs.

    RPC names may live in admin.html or public/admin-ops-gates.js so a
    markup rewrite does not fail the job. Each missing needle is printed
    on stdout so the Actions log shows the reason next to the ok lines.
    """
    migration = "supabase/migrations/0080_ops_release_gates.sql"
    page = "public/admin.html"
    wire = "public/admin-ops-gates.js"
    try:
        with open(migration, encoding="utf-8") as fh:
            sql = fh.read()
        with open(page, encoding="utf-8") as fh:
            admin = fh.read()
        extra = ""
        if os.path.exists(wire):
            with open(wire, encoding="utf-8") as fh:
                extra = fh.read()
    except OSError as exc:
        msg = f"release-gates: {exc}"
        print(f"FAIL {msg}")
        failures.append(msg)
        return
    sql_needles = [
        "create table if not exists ops_release_gates",
        "alter table ops_release_gates enable row level security",
        "create or replace function admin_ops_release_gates()",
        "create or replace function admin_set_ops_release_gate(",
        "perform record_audit(",
        "grant execute on function public.admin_ops_release_gates() to authenticated",
        "grant execute on function public.admin_set_ops_release_gate(text, boolean, text)",
    ]
    page_needles = [
        'id="opsGateSummary"',
        'id="opsGateList"',
        "admin_ops_release_gates",
        "admin_set_ops_release_gate",
        "Staging sign-off ledger",
    ]
    missing = [f"{migration}: {n}" for n in sql_needles if n not in sql]
    blob = admin + "\n" + extra
    missing += [f"{page}|{wire}: {n}" for n in page_needles if n not in blob]
    if missing:
        print("FAIL admin release gates — missing needles:")
        for needle in missing:
            print(f"     {needle}")
        failures.append("release-gates: missing " + "; ".join(missing))
    else:
        print("ok   admin release gates (server-backed and audited)")


def check_direct_upload_contract() -> None:
    try:
        with open("package.json", encoding="utf-8") as fh:
            package = fh.read()
        with open("scripts/prepare-direct-upload.mjs", encoding="utf-8") as fh:
            uploader = fh.read()
        with open("docs/DIRECT-UPLOAD.md", encoding="utf-8") as fh:
            docs = fh.read()
    except OSError as exc:
        failures.append(f"direct-upload: {exc}")
        return
    needles = [
        '"prepare:upload": "node scripts/prepare-direct-upload.mjs"',
        "const outputDir = path.join(root, \"dist\")",
        "SUPABASE_SERVICE_ROLE|WEBHOOK_SECRET",
        "Deploy Supabase migrations and Edge Functions separately.",
        "0001` through `0080`",
    ]
    missing = [needle for needle in needles if needle not in package + uploader + docs]
    if missing:
        failures.append(f"direct-upload: missing {missing}")
    else:
        print("ok   direct-upload bundle guard")


def check_provider_name_hidden() -> None:
    files = [
        p for p in sorted(glob.glob("public/**/*", recursive=True))
        if os.path.isfile(p)
        and os.path.splitext(p)[1] in (".html", ".js", ".css", ".json", ".map", ".svg", ".txt")
        and not os.path.basename(p).startswith("admin")
    ]
    hits = []
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                if re.search(r"breez", line, re.I):
                    hits.append(f"{path}:{n}")
    if hits:
        failures.append(f"provider name on a non-admin page: {hits[:10]}")
    else:
        print(f"ok   provider name absent from {len(files)} non-admin public files")


def check_no_traditional_payment_terms() -> None:
    files = [
        p for p in sorted(glob.glob("public/**/*", recursive=True))
        if os.path.isfile(p)
        and os.path.splitext(p)[1] in (".html", ".js", ".css", ".json", ".svg", ".txt", ".xml", ".webmanifest")
    ]
    pat = re.compile(r"bkash|nagad|binance|\bbank(s|ing)?\b|wire transfer", re.I)
    hits = []
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                if pat.search(line):
                    hits.append(f"{path}:{n}")
    if hits:
        failures.append(f"traditional payment method named in public/: {hits[:10]}")
    else:
        print(f"ok   no traditional payment methods in {len(files)} public files")


WALLET_CHECK_JS = r"""
const fs = require('fs'); const vm = require('vm');
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('public/wallets-config.js', 'utf8'), ctx);
const list = ctx.window.CPAY_WALLETS; const errs = [];
if (!Array.isArray(list) || !list.length) errs.push('CPAY_WALLETS is empty');
const ids = new Set();
for (const w of list || []) {
  const id = w && w.id;
  if (!id || ids.has(id)) errs.push('missing or duplicate id: ' + id); ids.add(id);
  for (const k of ['displayName','protocol','platforms','handoff','lightning','invoiceTypes','group','enabled','verification'])
    if (!(k in w)) errs.push(id + ': missing ' + k);
  if (/breez/i.test(JSON.stringify(w))) errs.push(id + ': names the payment provider');
  if (!['universal','deeplink','lightning','copy'].includes(w.handoff)) errs.push(id + ': bad handoff');
  if (w.handoff === 'universal' && !/^https:\/\/[^/]+\/.*\{bolt11\}/.test(w.universalLink || '')) errs.push(id + ': universalLink must be https with {bolt11}');
  if (w.handoff === 'deeplink' && !/^[a-z][a-z0-9+.-]*:.*\{bolt11\}/.test(w.deepLink || '')) errs.push(id + ': deepLink needs {bolt11}');
  if (w.deepLink && /^(javascript|data|vbscript|file):/i.test(w.deepLink)) errs.push(id + ': unsafe deepLink scheme');
  const v = w.verification || {};
  if (!['verified','unverified'].includes(v.status)) errs.push(id + ': verification.status');
  if (v.status === 'verified' && !(/^https:\/\//.test(v.source || '') && /^\d{4}-\d{2}-\d{2}$/.test(v.date || '')))
    errs.push(id + ': verified entries need an https source and a YYYY-MM-DD date');
  if (v.status !== 'verified' && w.enabled && w.group === 'featured') errs.push(id + ': only verified wallets can be featured');
}
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log(list.length);
"""


def check_wallet_config() -> None:
    if not os.path.exists("public/wallets-config.js"):
        failures.append("public/wallets-config.js missing")
        return
    proc = subprocess.run(["node", "-e", WALLET_CHECK_JS], capture_output=True, text=True)
    if proc.returncode:
        failures.append("wallets-config.js: " + "; ".join(proc.stderr.strip().splitlines()[:10]))
    else:
        print(f"ok   wallets-config.js ({proc.stdout.strip()} entries well formed)")


def check_reseller_commission_removed() -> None:
    # 20261005010000 removed reseller commission: the RPCs and columns are
    # gone, so a page that still asks for them would break, and the public
    # site must not promise a commission that no longer exists.
    files = [
        p for p in sorted(glob.glob("public/**/*", recursive=True))
        if os.path.isfile(p) and os.path.splitext(p)[1] in (".html", ".js")
        and "/assets/" not in p
    ]
    hits = []
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                if re.search(r"commission", line, re.I):
                    hits.append(f"{path}:{n}")
    if hits:
        failures.append(f"reseller commission still referenced: {hits[:10]}")
    else:
        print(f"ok   reseller commission absent from {len(files)} public pages and scripts")


def check_reseller_role_removed() -> None:
    # 20261005020000 removed the reseller role: its pages, tables, columns
    # and RPCs are gone. A page that still asks for them would break. The
    # reserved-slug lists keep 'moderator' and 'reseller' on purpose, so
    # nobody can take those paths as a payment-link slug.
    gone_pages = [p for p in ("public/reseller.html", "public/moderator.html", "public/reseller-desk.js") if os.path.exists(p)]
    if gone_pages:
        failures.append(f"reseller pages still present: {gone_pages}")
    files = [
        p for p in sorted(glob.glob("public/**/*", recursive=True))
        if os.path.isfile(p) and os.path.splitext(p)[1] in (".html", ".js", ".css")
        and "/assets/" not in p
    ]
    pattern = re.compile(
        r"reseller|moderator|cost_locked|affiliate|team_messages|send_team_message|"
        r"self_withdraw|my_reseller_id|team_cost_percent|staff_[a-z_]+|daily_close",
        re.I,
    )
    hits = []
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                if "'moderator','reseller'" in line:
                    continue  # reserved slug list
                if pattern.search(line):
                    hits.append(f"{path}:{n}")
    if hits:
        failures.append(f"reseller role still referenced: {hits[:10]}")
    else:
        print(f"ok   reseller role absent from {len(files)} public pages, scripts and styles")


check_js_syntax()
check_dom_references()
check_rpc_signatures()
check_reserved_slug_lists()
check_payment_accessibility_and_qr()
check_admin_release_gates()
check_direct_upload_contract()
check_no_traditional_payment_terms()
check_wallet_config()
check_provider_name_hidden()
check_reseller_commission_removed()
check_reseller_role_removed()

if failures:
    text = "\n".join(f"FAIL {f}" for f in failures)
    print(text)
    print(text, file=sys.stderr)
    sys.exit(1)
print("\nAll frontend checks passed.")
