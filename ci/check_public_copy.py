#!/usr/bin/env python3
"""Public copy guard: README.md, SECURITY.md, docs/ and public/ are public.

  1. the payment processor is not named in any public file (pages, admin
     included, README, SECURITY, docs). Identifiers stay allowed: BREEZ_*
     environment variables and settle_breez_payment() are configuration
     and schema names; JavaScript comment lines are not user-visible.
  2. no traditional payment method (bKash, Nagad, Binance Pay, bank) is
     named, not even to say it is not offered. Plain "bank" is a word match.
  3. README and docs do not promise "any Lightning wallet".

Run from the repository root: python3 ci/check_public_copy.py
"""
import glob
import os
import re
import sys

failures = []


def check_provider_name_hidden() -> None:
    # The payment processor is not named in any public page or script,
    # admin included, nor in README.md, SECURITY.md or docs/ (all public).
    # Identifiers stay allowed: BREEZ_* environment variables and
    # settle_breez_payment() are configuration and schema names, matched
    # out by the word boundaries (an underscore is part of the word).
    # JavaScript comment lines are not user-visible and are skipped.
    files = [
        p for p in sorted(glob.glob("public/**/*", recursive=True))
        if os.path.isfile(p)
        and os.path.splitext(p)[1] in (".html", ".js", ".css", ".json", ".map", ".svg", ".txt")
    ] + ["README.md", "SECURITY.md"] + sorted(glob.glob("docs/**/*.md", recursive=True))
    pat = re.compile(r"(?<![\w])breez(?![\w])", re.I)
    hits = []
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                if path.endswith(".js") and line.lstrip().startswith("//"):
                    continue
                if pat.search(line):
                    hits.append(f"{path}:{n}")
    if hits:
        failures.append(f"payment provider named in a public file: {hits[:10]}")
    else:
        print(f"ok   provider name absent from {len(files)} public files (pages, README, SECURITY, docs)")


def check_no_traditional_payment_terms() -> None:
    # CPAY receives Lightning and pays out USDT/USDC only. The public site
    # and docs must not name bKash, Nagad, Binance Pay or a bank, not even
    # to say they are not offered. Plain "bank" is matched as a word.
    files = [
        p for p in sorted(glob.glob("public/**/*", recursive=True))
        if os.path.isfile(p)
        and os.path.splitext(p)[1] in (".html", ".js", ".css", ".json", ".svg", ".txt", ".xml", ".webmanifest")
        and "/assets/" not in p
    ] + ["README.md", "SECURITY.md"] + sorted(glob.glob("docs/**/*.md", recursive=True))
    pat = re.compile(r"bkash|nagad|binance|\bbank(s|ing)?\b|wire transfer", re.I)
    hits = []
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                if pat.search(line):
                    hits.append(f"{path}:{n}")
    if hits:
        failures.append(f"traditional payment method named in a public file: {hits[:10]}")
    else:
        print(f"ok   no traditional payment methods in {len(files)} public files (pages, README, SECURITY, docs)")


def check_no_any_wallet_claim() -> None:
    # Not every Lightning wallet can pay every invoice; README and docs
    # must not promise "any Lightning wallet".
    files = ["README.md"] + sorted(glob.glob("docs/**/*.md", recursive=True))
    hits = []
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                if re.search(r"any\s+lightning\s+wallet", line, re.I):
                    hits.append(f"{path}:{n}")
    if hits:
        failures.append(f"'any Lightning wallet' claim: {hits[:10]}")
    else:
        print(f"ok   no 'any Lightning wallet' claim in README or docs")


check_provider_name_hidden()
check_no_traditional_payment_terms()
check_no_any_wallet_claim()

if failures:
    text = "\n".join(f"FAIL {f}" for f in failures)
    print(text)
    print(text, file=sys.stderr)
    sys.exit(1)
print("\nPublic copy checks passed.")
