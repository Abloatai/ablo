---
"@abloatai/humans": patch
---

`useAblo` and `useReactive` no longer re-subscribe and re-snapshot on every render. `useAblo` memoizes its computation, and while subscribed `useReactive` returns the snapshot its MobX reaction keeps current instead of re-running the selector, deep-copying and deep-comparing on each render. Pass a stable selector (module-level or `useCallback`): a new selector identity still starts a new observation.
