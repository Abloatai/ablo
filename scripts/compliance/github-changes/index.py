"""Validate review exceptions and check evidence against the current PR head."""
import argparse
import json
import os
import re
import subprocess

CONTEXT = "Change evidence"
MARKER = "<!-- ablo-change-evidence -->"
OWN_CHECKS = {CONTEXT, "Reconcile change evidence"}


def github(path, body=None):
    command = ["gh", "api", path]
    if body is not None:
        command += ["--method", "POST", "--input", "-"]
    result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def pages(path):
    result, page = [], 1
    while True:
        values = github(f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
        result.extend(values)
        if len(values) < 100:
            return result
        page += 1


def field(body, name):
    match = re.search(rf"^{re.escape(name)}: ([^\n]+)$", body, re.MULTILINE)
    return match.group(1).strip() if match else ""


def evaluate(pr, reviews, records, checks):
    """Records are already restricted to writers; never treat an exception as review."""
    sha = pr["head"]["sha"]
    latest = {}
    for review in reviews:
        if review["state"] != "COMMENTED":
            latest[review["user"]["login"]] = review
    approved = any(r["state"] == "APPROVED" and r.get("commit_id") == sha
                   and login != pr["user"]["login"] for login, r in latest.items())
    records = [r for r in records if MARKER in r and field(r, "Head") == sha]
    # One complete attestation must cover this head; don't combine unrelated notes.
    record = next((r for r in reversed(records)
                   if len(field(r, "Review exception")) >= 40 and
                   re.search(r"https://(?:github\.com/[^\s]+/actions/runs/\d+|linear\.app/[^\s]+/issue/[^\s]+)", field(r, "Check evidence"))), "")
    failed = [c for c in checks if c["state"] != "success"]
    check_exception = bool(record and len(field(record, "Check exception")) >= 40)
    if not approved and not record:
        return "failure", "Missing independent review or a specific owner exception for this head"
    if (not checks or failed) and not check_exception:
        return "failure", "Missing passing checks or an explicit check exception with evidence"
    if not approved or not checks or failed:
        return "success", f"Owner exception recorded; {len(checks) - len(failed)} checks passed, {len(failed)} not passing"
    return "success", "Independent approval and passing checks verified on this head"


def reconcile(repository, number, publish):
    base = f"repos/{repository}"
    pr = github(f"{base}/pulls/{number}")
    sha = pr["head"]["sha"]
    if publish:
        github(f"{base}/statuses/{sha}", {"state": "pending", "context": CONTEXT,
               "description": "Rechecking current-head review and check evidence", "target_url": pr["html_url"]})
    reviews = pages(f"{base}/pulls/{number}/reviews")
    records = []
    for comment in pages(f"{base}/issues/{number}/comments"):
        if MARKER not in comment["body"] or comment["user"]["type"] != "User":
            continue
        permission = github(f"{base}/collaborators/{comment['user']['login']}/permission")
        if permission["permission"] in {"admin", "maintain", "write"}:
            records.append(comment["body"])
    checks, page = [], 1
    while True:
        runs = github(f"{base}/commits/{sha}/check-runs?filter=latest&per_page=100&page={page}")["check_runs"]
        checks.extend({"name": r["name"], "state": "success" if r["status"] == "completed" and r["conclusion"] == "success" else r["conclusion"] or r["status"], "url": r["html_url"]}
                      for r in runs if r["name"] not in OWN_CHECKS)
        if len(runs) < 100:
            break
        page += 1
    statuses = {}
    for status in pages(f"{base}/commits/{sha}/statuses"):
        statuses.setdefault(status["context"], status)
    checks.extend({"name": s["context"], "state": s["state"], "url": s.get("target_url")} for s in statuses.values() if s["context"] not in OWN_CHECKS)
    state, description = evaluate(pr, reviews, records, checks)
    # Fail closed if a push raced this read. A status on an old SHA never qualifies a new head.
    if github(f"{base}/pulls/{number}")["head"]["sha"] != sha:
        raise ValueError("PR head changed while reading its evidence; rerun")
    if publish:
        github(f"{base}/statuses/{sha}", {"state": state, "context": CONTEXT,
               "description": description[:140], "target_url": pr["html_url"]})
    result = {"repository": repository, "pr": number, "head": sha, "state": state,
              "description": description, "checks": checks}
    print(json.dumps(result))
    return state == "success"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--pull-request", type=int)
    parser.add_argument("--event")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repository):
        parser.error("Use OWNER/REPOSITORY")
    numbers = [args.pull_request] if args.pull_request else []
    if args.event:
        with open(args.event) as source:
            event = json.load(source)
        if event["repository"]["full_name"] != args.repository:
            parser.error("Event repository does not match")
        if "pull_request" in event:
            numbers = [event["pull_request"]["number"]]
        elif event.get("issue", {}).get("pull_request"):
            numbers = [event["issue"]["number"]]
        elif "workflow_run" in event:
            sha = event["workflow_run"]["head_sha"]
            numbers = [p["number"] for p in pages(f"repos/{args.repository}/commits/{sha}/pulls") if p["state"] == "open"]
    if not numbers:
        print("No pull request to reconcile")
        return
    accepted = [reconcile(args.repository, number, args.publish) for number in numbers]
    if not all(accepted):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
