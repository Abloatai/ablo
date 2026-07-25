'use client';

/**
 * Neutral loading placeholder — the default value of `<AbloProvider>`'s
 * `fallback` prop. Rendered during the first bootstrap pass when the
 * consumer hasn't supplied their own skeleton.
 *
 * Design goals:
 *   - Zero design-system dependency. Inline styles only; no CSS file,
 *     no UI-lib imports, no Tailwind assumptions.
 *   - Theme-adaptive. Uses `currentColor` for the ring so the spinner
 *     inherits the text color from whichever ancestor defines it —
 *     works in light + dark contexts without a prop.
 *   - Self-centering. Flex-centered in a full-parent container so the
 *     common case (provider at the layout root) renders a spinner in
 *     the middle of the viewport. Consumers who need different
 *     positioning compose their own fallback and pass it explicitly.
 *   - Minimal bundle footprint. The whole component + keyframe is ~50
 *     bytes gzipped.
 *
 * Consumers wanting a branded loader should pass `fallback={<YourSkeleton />}`
 * on `<AbloProvider>`. Consumers wanting NO visual during bootstrap
 * pass `fallback={null}`. Consumers who want to skip the gate entirely
 * pass `fallback="passthrough"`.
 */
export function DefaultFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        minHeight: '100vh',
        color: 'currentColor',
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          border: '2px solid currentColor',
          borderTopColor: 'transparent',
          borderRadius: '50%',
          opacity: 0.6,
          animation: 'ablo-default-fallback-spin 0.8s linear infinite',
        }}
      />
      {/*
        Keyframe ships inline so the component has zero external-CSS
        dependencies. Name is prefixed so it can't collide with
        consumer-defined animations.
      */}
      <style>{`@keyframes ablo-default-fallback-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
