# Browser connectivity

The shared `useOnlineStatus` hook drives the offline banner, local sync controls
and realtime subscriptions. The PWA uses this verified state to check for app
updates and decide when a pending or explicit reload can run. A browser's
`navigator.onLine` signal is a hint:
embedded browsers and VPN configurations can report offline while Savia remains
reachable.

When that signal is offline, the app makes one shared, uncached `HEAD /api/health`
request against the configured Savia API origin. Any HTTP response, including
401, 403 or 5xx, confirms connectivity. API/authentication errors still belong to
the operation that failed; they are not represented as a network disconnection.
A network failure or an eight-second timeout retains the offline state.

If the browser continues reporting offline, a visible tab checks again on focus,
visibility changes or browser connectivity events. Hidden tabs pause background
checks and abort pending requests. All consumers share one in-memory request
with an eight-second deadline, released when the last subscriber unmounts.
Cancelled or superseded results cannot overwrite a newer online state. Checks
use Savia's API without credentials.

The offline shell sends API documentation, health checks, and short links to
the network. Short links resolve on the server before opening their destination.

The recovery fallback can outlive the application root after a failed boot or
chunk load. An explicit update temporarily retains the shared verifier and waits
for a bounded check even when no UI subscribers remain, then releases it.
Visibility changes do not cancel this explicit check; its eight-second deadline
still applies. Background checks continue to pause in hidden tabs.

This indicator describes connectivity, not API health or persistence guarantees.
The unchanged offline banner refers to existing local collection behavior.
