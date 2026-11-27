# Cookie consent

The Admin workspace and public pages ask for a cookie decision. The banner
stays visible until the visitor accepts all cookies, allows only essential
cookies, or saves custom preferences.

## Behavior

- In Admin, the cookie notice uses the workspace footer before the app
  installation notice. On public pages, it sits above the page content.
- The decision is stored in `localStorage` under `savia.consent.cookies`
  (per browser/device), versioned through `COOKIE_CONSENT_VERSION`. A stored
  decision with a stale or malformed version re-shows the banner, so consent
  can be re-required when cookie categories change.
- Categories: essential (session/auth cookies, always on, not toggleable),
  analytics and marketing (off unless explicitly accepted).
- The notice and preferences dialog follow the selected interface language.
  Spanish, English and Brazilian Portuguese are available through
  `savia.consent.*`.

## Code

- `apps/admin/src/consent/cookie-consent-storage.ts` — read/write helpers.
- `apps/admin/src/consent/cookie-consent-banner.tsx` — banner + preferences
  dialog (unit tests in `cookie-consent-banner.test.tsx`).

Integrations that drop non-essential cookies or trackers must gate them on
`getCookieConsent()?.optional.<category>`.

Owner: platform team · Review date: 2027-09
