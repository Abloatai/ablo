# GitHub change evidence

The required `Change evidence` status belongs to the exact PR head. The small
workflow reads GitHub metadata using trusted default-branch code; it does not
execute PR code or start full CI. Full CI remains manually dispatched.

A merge needs independent approval on the current head with no failing checks,
or one complete exception comment from a current repository writer. Because full
CI is manually dispatched, an approved head with no hosted checks passes and the
status says that none ran; a failed check always needs the check exception. For a sole-reviewer merge, record the
actual reason, check results and a permanent evidence link before merging:

```text
<!-- ablo-change-evidence -->
Head: FULL_CURRENT_HEAD_SHA
Review exception: Explain why independent review was unavailable for this specific change.
Check evidence: LINK_TO_THE_GITHUB_RUN_OR_LINEAR_ISSUE_WITH_THIS_HEADS_CHECK_RESULTS
Check exception: Explain absent, failed, cancelled or skipped hosted checks and the focused verification actually performed.
```

Do not replace failed checks with a green claim. `Change evidence` measures the
presence of review/exception evidence; it does not certify tests or authorize a
production release. A new push invalidates the old comment. Production retains
its existing release checks and approval requirements. A generic standing
exception is insufficient. Do not put credentials or private logs in comments.

PR pushes, PR description edits and manual CI completion re-evaluate the
status. After adding or changing the exception comment, or after an independent
review, refresh it by dispatching the workflow for that pull request.
API errors leave the status pending. Inspect without writing a status:

```sh
python3 scripts/compliance/github-changes/index.py --repository Abloatai/monorepo --pull-request NUMBER
python3 -m unittest discover -s scripts/compliance/github-changes
```

The default branch protection must require `Change evidence`, enforce it for
administrators and retain existing protections. The workflow must be installed
before that requirement is enabled. Verify the actual live requirement after
configuration changes; a checked-in workflow alone does not enforce merges.

GitHub is the release completion record. After merge, record the final main
commit, actual check outcomes and deployment run links in Linear. Preserve
failed and skipped outcomes accurately. Task completion depends on the required
GitHub review, checks and deployment verification, not a separate Vanta receipt.
Do not open Vanta or add manual Vanta justifications as a release-completion step.
