import unittest
from index import evaluate, MARKER

SHA = "a" * 40
PR = {"head": {"sha": SHA}, "user": {"login": "owner"}}
NOTE = f"""{MARKER}
Head: {SHA}
Review exception: I am the sole available reviewer for this development-only monitoring repair.
Check evidence: https://linear.app/abloatai/issue/ABL-1364
Check exception: Full hosted CI was not run; the linked task records the focused Terraform plan and mock checks.
"""


class ChangeEvidenceTest(unittest.TestCase):
    def test_new_head_requires_new_attestation(self):
        self.assertEqual(evaluate(PR, [], [NOTE.replace(SHA, "b" * 40)], [])[0], "failure")

    def test_specific_exception_preserves_missing_and_failed_checks(self):
        for checks in [[], [{"state": "failure"}]]:
            state, description = evaluate(PR, [], [NOTE], checks)
            self.assertEqual(state, "success")
            self.assertIn("Owner exception recorded", description)
            self.assertIn(f"{len(checks)} not passing", description)

    def test_review_does_not_replace_check_evidence(self):
        review = {"user": {"login": "peer"}, "state": "APPROVED", "commit_id": SHA}
        self.assertEqual(evaluate(PR, [review], [], [])[0], "failure")
        self.assertEqual(evaluate(PR, [review], [], [{"state": "success"}])[0], "success")

    def test_stale_self_or_dismissed_reviews_do_not_qualify(self):
        for login, commit, state in [("owner", SHA, "APPROVED"), ("peer", "b" * 40, "APPROVED"), ("peer", SHA, "DISMISSED")]:
            review = {"user": {"login": login}, "state": state, "commit_id": commit}
            self.assertEqual(evaluate(PR, [review], [], [{"state": "success"}])[0], "failure")

    def test_incomplete_notes_cannot_be_combined(self):
        a = NOTE.replace("Review exception:", "Other:")
        b = NOTE.replace("Check evidence:", "Other:")
        self.assertEqual(evaluate(PR, [], [a, b], [])[0], "failure")


if __name__ == "__main__":
    unittest.main()
