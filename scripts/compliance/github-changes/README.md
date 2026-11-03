# GitHub change evidence

The required `Change evidence` status belongs to the exact PR head. The small
workflow reads GitHub metadata using trusted default-branch code; it does not
execute PR code or start full CI. Full CI remains manually dispatched.

A merge needs independent approval and passing checks, or one complete exception
comment from a current repository writer. For a sole-reviewer merge, record the
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

Comment edits and deletions, PR pushes, and manual CI completion re-evaluate the
status. After an independent review, manually refresh the workflow if needed.
API errors leave the status pending. Inspect without writing a status:

```sh
python3 scripts/compliance/github-changes/index.py --repository Abloatai/monorepo --pull-request NUMBER
python3 -m unittest discover -s scripts/compliance/github-changes
```

The default branch protection must require `Change evidence`, enforce it for
administrators and retain existing protections. The workflow must be installed
before that requirement is enabled. Verify the actual live requirement after
configuration changes; a checked-in workflow alone does not enforce merges.

Vanta keeps a separate exception field. After a merge is ingested, copy the
specific GitHub attestation and actual check outcomes into that PR's Vanta
justification, refresh both code-change tests and verify their outcomes. Do not
close the task until that receipt is recorded. The current Vanta connector has
no justification-write tool, so this step uses the signed-in Vanta UI; the
workflow does not pretend a GitHub comment automatically becomes Vanta evidence.
