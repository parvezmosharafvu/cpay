#!/usr/bin/env python3
"""
Deployed-vs-repo Edge Function drift check.

Lists the functions deployed to a Supabase project, lists the functions in
supabase/functions/ (a folder with an index.ts), and prints the difference:

  deployed, not in repo   orphans: deployed from somewhere else, or left
                          behind after the repo dropped them
  in repo, not deployed   never deployed, or deleted by hand

Exit 0 when the two sets match, 1 when they differ, 2 on a usage or API
error. Read-only: it only ever issues GET requests.

Where the deployed list comes from (pick one):

  --deployed-json FILE    a saved list, e.g. the output of
                          `supabase functions list --project-ref REF -o json`,
                          the Management API, or the Supabase MCP
                          list_edge_functions. Needs no secret, so CI uses it
                          against a fixture to test this script.
  --project-ref REF       live: GET https://api.supabase.com/v1/projects/REF/functions
                          with SUPABASE_ACCESS_TOKEN from the environment
                          (a personal access token; never printed). Run by the
                          owner by hand; CI has no such secret on purpose.

  --allow NAME            a deployed function known to be outside the repo,
                          reported but not counted as drift (repeatable).
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.supabase.com/v1/projects/{ref}/functions"


def repo_functions(root: Path) -> set[str]:
    base = root / "supabase" / "functions"
    return {p.name for p in base.iterdir() if p.is_dir() and (p / "index.ts").is_file() and not p.name.startswith("_")}


def parse_deployed(data) -> dict[str, dict]:
    # Accept a bare list, {"functions": [...]}, or {"result": [...]}.
    if isinstance(data, dict):
        data = data.get("functions") or data.get("result") or data.get("data") or []
    out: dict[str, dict] = {}
    for f in data:
        slug = f.get("slug") or f.get("name")
        if slug:
            out[slug] = f
    return out


def live_deployed(ref: str) -> dict[str, dict]:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if not token:
        sys.exit("SUPABASE_ACCESS_TOKEN is not set (needed for --project-ref)")
    req = urllib.request.Request(API.format(ref=ref), headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return parse_deployed(json.load(res))
    except urllib.error.HTTPError as e:
        print(f"Management API answered {e.code}", file=sys.stderr)
        sys.exit(2)


def describe(f: dict) -> str:
    bits = []
    if f.get("version") is not None:
        bits.append(f"v{f['version']}")
    if f.get("verify_jwt") is not None:
        bits.append(f"verify_jwt={str(f['verify_jwt']).lower()}")
    ep = f.get("entrypoint_path") or ""
    if ep and "/supabase/functions/" in ep:
        bits.append("from " + ep.split("/supabase/functions/")[0] + "/…")
    return " ".join(bits)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--deployed-json", type=Path)
    src.add_argument("--project-ref")
    ap.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    ap.add_argument("--allow", action="append", default=[])
    args = ap.parse_args()

    deployed = parse_deployed(json.loads(args.deployed_json.read_text())) if args.deployed_json else live_deployed(args.project_ref)
    repo = repo_functions(args.repo)

    only_deployed = sorted(set(deployed) - repo)
    only_repo = sorted(repo - set(deployed))
    allowed = [s for s in only_deployed if s in args.allow]
    drift = [s for s in only_deployed if s not in args.allow]

    print(f"repo: {len(repo)}  deployed: {len(deployed)}  in both: {len(repo & set(deployed))}")
    for s in sorted(repo & set(deployed)):
        print(f"  ok        {s}  {describe(deployed[s])}")
    for s in drift:
        print(f"  ORPHAN    {s}  deployed, not in repo  {describe(deployed[s])}")
    for s in allowed:
        print(f"  allowed   {s}  deployed, not in repo (--allow)  {describe(deployed[s])}")
    for s in only_repo:
        print(f"  MISSING   {s}  in repo, not deployed")
    if drift or only_repo:
        print("DRIFT: deployed functions and supabase/functions differ")
        return 1
    print("No drift.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
