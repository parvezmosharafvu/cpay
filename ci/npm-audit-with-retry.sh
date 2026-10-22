#!/usr/bin/env bash
# Run a required npm production audit. Retry only when npm's audit API is
# temporarily unavailable; a vulnerability or any other error fails closed.
set -euo pipefail

package_dir="${1:-.}"
if [[ ! -f "${package_dir}/package-lock.json" ]]; then
  echo "::error::Missing package-lock.json in ${package_dir}; audit not run" >&2
  exit 1
fi
cd "${package_dir}"

for attempt in 1 2 3; do
  audit_log="$(mktemp)"
  if npm audit --omit=dev --audit-level=high --fetch-retries=0 --fetch-timeout=45000 >"${audit_log}" 2>&1; then
    cat "${audit_log}"
    rm -f "${audit_log}"
    exit 0
  fi

  cat "${audit_log}"
  # npm's retiring Quick Audit endpoint can now return HTTP 400 after a
  # failed Bulk Advisory request. Run a *full* audit with a pinned modern
  # client, and accept only its actual clean exit code. Never skip auditing.
  if grep -Eq 'npm (warn|error) audit 400 Bad Request - POST https://registry[.]npmjs[.]org/-/npm/v1/security/audits/quick' "${audit_log}"; then
    rm -f "${audit_log}"
    echo "::warning::npm Quick Audit endpoint returned 400; retrying the full security audit with pinned npm@11.21.1" >&2
    if npx --yes npm@11.21.1 audit --omit=dev --audit-level=high --fetch-retries=0 --fetch-timeout=45000; then
      exit 0
    fi
    echo "::error::Modern npm audit also failed; dependency security gate remains blocked" >&2
    exit 1
  fi

  # Transient 502/503/504 registry errors get a bounded retry. All other
  # errors and all high/critical advisories fail closed.
  if ! grep -Eq 'npm (warn|error) audit (502|503|504) .*POST https://registry[.]npmjs[.]org/-/npm/v1/security/audits(/quick)?' "${audit_log}"; then
    rm -f "${audit_log}"
    echo "::error::npm audit failed; dependency security gate remains blocked" >&2
    exit 1
  fi
  rm -f "${audit_log}"

  if (( attempt == 3 )); then
    echo "::error::npm audit API unavailable after three attempts; security gate remains blocked" >&2
    exit 1
  fi
  echo "::warning::npm audit API temporarily unavailable (attempt ${attempt}/3); retrying" >&2
  sleep "$(( attempt * 5 ))"
done
