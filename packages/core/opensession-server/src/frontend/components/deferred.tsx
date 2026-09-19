import React from "react";

/*
 * A pane that loads when first rendered instead of at boot. The bundler
 * turns the import() into its own chunk, so the code for a view nobody has
 * opened yet (onboarding, automations, analytics, reviews...) stays off the
 * critical path of the first paint, which matters most on the phone. The
 * chunk is content-hashed and cached by the service worker after its first
 * fetch, so later opens cost nothing. The fallback is empty: on a warm cache
 * the wait is a few milliseconds, and a spinner that flashes for that long
 * reads as a glitch.
 */
export function deferred<P extends object>(
  load: () => Promise<React.ComponentType<P>>,
): React.ComponentType<P> {
  const Lazy = React.lazy(async () => ({ default: await load() }));
  return function Deferred(props: P) {
    return (
      <React.Suspense fallback={null}>
        <Lazy {...props} />
      </React.Suspense>
    );
  };
}
