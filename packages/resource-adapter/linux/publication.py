"""Trusted project-file staging publishes only after exact server-backed claims."""
import time

from store import Rejected, canonical


def publish_project(adapter, owner, operation, request, detail):
    store = adapter.store
    acquired = []
    deadline = time.monotonic() + 30
    with store.lock, store.db:
        witness = store.freeze_publication(operation)
        witness["requests"] = [{"operationId": operation, "resource": "file:" + path} for path in witness["paths"]]
        store.db.execute("UPDATE operations SET publication=? WHERE id=?", (canonical(witness), operation))
    original = {claim["resource"]: claim for claim in request["claims"]}
    try:
        adapter.authorize_project(owner, operation)
        for path in witness["paths"]:
            if time.monotonic() >= deadline:
                raise Rejected("command_timeout")
            resource = "file:" + path
            if resource == "file:.git" or path.startswith(".git/"):
                raise Rejected("permission_denied", [path])
            adapter.project_valid(owner, operation)
            if resource in original:
                with store.lock:
                    held = dict(store.authorize(owner, resource, original[resource]["claim"]))
                grant = {"claim": held["claim"], "fence": held["fence"], "expires": held["expires"]}
            else:
                # A missing reply is not a grant. The original operation is never reexecuted.
                grant = adapter.upstream(owner, "claim", resource=resource, ttl="30s")
                acquired.append({"resource": resource, "claim": grant["claim"]})
                with store.lock, store.db:
                    store.install(owner, resource, grant)
            witness["claims"].append({"resource": resource, "claim": grant["claim"], "fence": grant["fence"]})
            with store.lock, store.db:
                store.db.execute("UPDATE operations SET publication=? WHERE id=?", (canonical(witness), operation))
        adapter.authorize_project(owner, operation)
        for claim in witness["claims"]:
            adapter.execute(owner, {"action": "heartbeat", "ttl": "30s", "resource": claim["resource"], "claim": claim["claim"]})
        if time.monotonic() >= deadline:
            raise Rejected("command_timeout")
        with store.lock, store.db:
            adapter.project_valid(owner, operation)
            return store.publish(operation, detail, publication=witness)
    finally:
        for claim in acquired:
            try:
                adapter.execute(owner, {"action": "release", **claim})
            except Exception:
                # The gateway retains ownership for close/TTL; no failed release permits publication.
                pass
