/**
 * CRED engine — portal adapters + registry (Phase 10.6a).
 *
 * An adapter is pure, declarative navigation logic. It NEVER reads a credential
 * field and NEVER types a password — in Mode A the human authenticates on the
 * real page; the adapter only detects the logged-in state and triggers the
 * export download.
 */

import type { PortalAdapter } from './types'

/**
 * Detect that we've reached the authenticated "my Social Security" area. Looks
 * for a sign-out affordance rather than a specific URL, since the dashboard path
 * varies. **`beta`: validate against a real account — selectors may need a tweak.**
 */
const SSA_LOGGED_IN_JS =
  '!!document.querySelector(\'a[href*="logout" i], a[href*="signout" i], a[href*="sign-out" i]\')'

/**
 * Click the "Download your Statement (PDF)" link. Returns false if it can't be
 * found, so the runtime fails cleanly instead of hanging. **`beta`: the exact
 * link text/href needs validation against a live my-Social-Security account.**
 */
const SSA_DOWNLOAD_JS = `(() => {
  const a = [...document.querySelectorAll('a, button')].find((el) => {
    const t = (el.textContent || '').toLowerCase();
    const href = (el.getAttribute('href') || '').toLowerCase();
    return /statement/.test(t) && (/\\.pdf/.test(href) || /download/.test(t));
  });
  if (!a) return false;
  a.click();
  return true;
})()`

/**
 * SSA — *my Social Security*. Downloads the Statement PDF, which the SSA
 * recognizer (PR #220) indexes. Origins include Login.gov / ID.me because
 * assisted login legitimately redirects through those identity providers — the
 * navigation allow-list must let those hops through or login itself would break.
 */
export const SSA_ADAPTER: PortalAdapter = {
  id: 'ssa',
  name: 'Social Security (my Social Security)',
  loginUrl: 'https://secure.ssa.gov/RIL/SiView.action',
  origins: [
    'https://secure.ssa.gov',
    'https://www.ssa.gov',
    'https://secure.login.gov',
    'https://www.login.gov',
    'https://api.id.me',
    'https://wallet.id.me',
    'https://insurance.id.me'
  ],
  status: 'beta',
  isLoggedIn: (page) => page.evaluate<boolean>(SSA_LOGGED_IN_JS),
  fetch: async (page) => {
    const path = await page.waitForDownload(async () => {
      const clicked = await page.evaluate<boolean>(SSA_DOWNLOAD_JS)
      if (!clicked) {
        throw new Error(
          'SSA: could not find the Statement download link — the portal layout may have changed.'
        )
      }
    })
    return { kind: 'download', path }
  }
}

/** Every portal Compass can automate. v1 ships one (SSA), Mode A only. */
export const CRED_ADAPTERS: PortalAdapter[] = [SSA_ADAPTER]

/** The adapter for `id`, or undefined when it isn't a known portal. */
export function getAdapter(id: string): PortalAdapter | undefined {
  return CRED_ADAPTERS.find((a) => a.id === id)
}
