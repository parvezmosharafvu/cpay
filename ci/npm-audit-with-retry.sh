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
  # The audit endpoint can return 502/503/504; no other nonzero result
  # may be retried, and all unsuccessful audits block the release.
  if ! grep -Eq 'npm (warn|error) audit (502|503|504) .*POST https://registry\\.npmjs\\.org/-/npm/v1/security/audits(/quick)?' "${audit_log}"; then
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
