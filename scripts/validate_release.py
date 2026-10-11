#!/usr/bin/env python3
"""Fail closed unless a new version targets a merged PR commit on main."""
import json
import os
import re
import urllib.error
import urllib.request


def api(path):
    req = urllib.request.Request("https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + path,
        headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def main():
    if os.environ["GITHUB_REF"] != "refs/heads/main":
        raise SystemExit("Releases must run from main.")
    version = os.environ["RELEASE_VERSION"]
    if not re.fullmatch(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise SystemExit("Use a stable version tag such as v0.2.0 (no leading zeroes).")
    sha = os.environ["GITHUB_SHA"]
    prs = api("/commits/" + sha + "/pulls?per_page=100")
    if not any(pr.get("merged_at") and pr["base"]["ref"] == "main"
               and pr.get("merge_commit_sha") == sha for pr in (prs or [])):
        raise SystemExit("This commit must come from a merged pull request into main. Use squash or merge-commit merging.")
    if api("/git/ref/tags/" + version) is not None:
        raise SystemExit("Release tag already exists; use a new version.")
    with open(os.environ["GITHUB_OUTPUT"], "a") as out:
        out.write("version=" + version + "\n")
    print("Validated new release " + version + " at " + sha)


if __name__ == "__main__":
    main()
