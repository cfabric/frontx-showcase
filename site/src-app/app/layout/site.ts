/**
 * The site-wide choices the layout reads from the repository's `site.config.json`, next to `homeScreen` (see `home.ts`): the languages the whole site ships, the screens the footer links to, the screens whose footer takes the ink variant and the screen groups the header leaves out; and, from the production build's variables, the screens the site leaves unlisted. They are route tokens, language codes or extension ids, so the layout still names no screen and no language itself.
 */
import siteConfig from '../../../../site.config.json';

/** The language codes every part of the site (the shell's layout strings and every screen) ships strings for. `scripts/site-languages.test.mjs` holds the list to the locale files that exist. */
// @cpt-begin:cpt-site-algo-shell-layout-navigation-site-choices:p1:inst-read-config
export const SITE_LANGUAGES: readonly string[] = siteConfig.languages;

/** The route tokens of the screens the footer links to, in order. */
export const FOOTER_SCREENS: readonly string[] = siteConfig.footerScreens;

/** The route tokens of the screens whose footer takes the ink variant (V2's showcase footer). */
export const INK_FOOTER_SCREENS: readonly string[] = siteConfig.inkFooterScreens;

/** The nav group names whose screens the header's menu does not list; the screens stay registered and reachable by address. The site hides none. */
export const HEADER_HIDDEN_GROUPS: readonly string[] = siteConfig.headerHiddenGroups;

/** The extension ids of the screens the production build leaves unlisted (`unlistedScreens` of `site.config.json`, resolved by `scripts/site-publish.mjs` into the build variable `VITE_SITE_HIDDEN_SCREENS`): the header's menu leaves them out, while they stay registered and open by their address. None in `npm run dev` and the tests, which do not set the variable. */
export const UNLISTED_SCREENS: readonly string[] = unlistedScreens(import.meta.env.VITE_SITE_HIDDEN_SCREENS);
// @cpt-end:cpt-site-algo-shell-layout-navigation-site-choices:p1:inst-read-config

/**
 * The unlisted screens' extension ids from the build variable: a JSON array of strings, none when the variable is unset or empty.
 * @param raw - the variable's value
 */
export function unlistedScreens(raw: unknown): string[] {
  // @cpt-begin:cpt-site-algo-shell-layout-navigation-site-choices:p1:inst-read-config
  if (raw === undefined || raw === '') return [];
  const value: unknown = JSON.parse(String(raw));
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('VITE_SITE_HIDDEN_SCREENS must be a JSON array of strings');
  return value;
  // @cpt-end:cpt-site-algo-shell-layout-navigation-site-choices:p1:inst-read-config
}

/**
 * The language options the header offers: the framework's supported languages the site ships, in the site's order. A code the framework does not support is dropped, since the i18n registry could not switch to it.
 * @param supported - the framework's `SUPPORTED_LANGUAGES`
 * @param shipped - the site's languages
 */
// @cpt-algo:cpt-site-algo-shell-layout-navigation-site-choices:p1
export function offeredLanguages<T extends { code: string }>(supported: readonly T[], shipped: readonly string[]): T[] {
  // @cpt-begin:cpt-site-algo-shell-layout-navigation-site-choices:p1:inst-offered-languages
  return shipped.flatMap((code) => supported.filter((language) => language.code === code));
  // @cpt-end:cpt-site-algo-shell-layout-navigation-site-choices:p1:inst-offered-languages
}
