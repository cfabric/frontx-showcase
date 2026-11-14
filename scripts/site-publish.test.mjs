import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composedScreens, publishingChoices, publishingEnv, resolvePublishing, unlistedFindings, withoutCode } from './site-publish.mjs';

const SCREEN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1';
const ext = (name) => `ext.${name}`;

let site;

function write(file, content) {
  mkdirSync(path.dirname(path.join(site, file)), { recursive: true });
  writeFileSync(path.join(site, file), typeof content === 'string' ? content : JSON.stringify(content));
}

/** A composed package with screen extensions of the given tokens. */
function screenPackage(name, tokens, extra = {}) {
  write(`src-app/mfe_packages/${name}/mfe.json`, { ...extra, extensions: tokens.map((token) => ({ id: ext(token), domain: SCREEN, route: `/${token}` })) });
}

beforeEach(() => {
  site = mkdtempSync(path.join(tmpdir(), 'site-publish-'));
  write('packages/framework/src/plugins/microfrontends/gts/frontx.screensets/instances/domains/screen.v1.json', { id: SCREEN, route: 'screen' });
  screenPackage('home-mfe', ['home']);
  screenPackage('kit-mfe', ['kit']);
  screenPackage('demo-mfe', ['demo-a', 'demo-b']);
  screenPackage('example-mfe', ['example'], { templateExample: true });
  write('src-app/mfe_packages/shared/site/x.json', {});
});

afterEach(() => {
  rmSync(site, { recursive: true, force: true });
});

describe('publishingChoices and resolvePublishing', () => {
  it('lists everything when the config has no lists', () => {
    expect(publishingChoices({})).toEqual({ unlisted: [], hiddenEntries: [] });
    expect(resolvePublishing({ homeScreen: 'home' }, composedScreens(site).screens)).toEqual({ unlisted: [], hiddenEntries: [], hiddenScreens: [] });
  });

  it('resolves unlisted tokens to their extension ids, reading screens with the scanner rules', () => {
    const { domainKey, screens } = composedScreens(site);
    expect(domainKey).toBe('screen');
    expect(screens.map((screen) => screen.token)).toEqual(['demo-a', 'demo-b', 'home', 'kit']);
    expect(resolvePublishing({ homeScreen: 'home', unlistedScreens: ['kit', 'demo-b'], hiddenEntries: ['teams'] }, screens)).toEqual({ unlisted: ['kit', 'demo-b'], hiddenEntries: ['teams'], hiddenScreens: [ext('demo-b'), ext('kit')] });
  });

  it('refuses a list of the wrong shape, an unknown token, the home screen, a footer screen and the former key', () => {
    const { screens } = composedScreens(site);
    expect(() => publishingChoices({ unlistedScreens: 'kit' })).toThrow('unlistedScreens must be a list of non-empty strings');
    expect(() => resolvePublishing({ homeScreen: 'home', unlistedScreens: ['nope'] }, screens)).toThrow('names nope, which no composed screen declares');
    expect(() => resolvePublishing({ homeScreen: 'home', unlistedScreens: ['home'] }, screens)).toThrow('names the home screen home');
    expect(() => resolvePublishing({ homeScreen: 'home', unlistedScreens: ['kit'], footerScreens: ['kit'] }, screens)).toThrow('footerScreens links kit');
    expect(() => publishingChoices({ unpublishedScreens: ['kit'] })).toThrow('unpublishedScreens is now unlistedScreens');
  });

  it('carries the choices to the screens as JSON arrays in the build variables', () => {
    expect(publishingEnv({ hiddenScreens: [ext('kit')], hiddenEntries: [] })).toEqual({ VITE_SITE_HIDDEN_SCREENS: '["ext.kit"]', VITE_SITE_HIDDEN_ENTRIES: '[]' });
  });

  it("reaches the shell's header: the build variables it writes are the ones the header's site choices read", async () => {
    for (const [name, value] of Object.entries(publishingEnv({ hiddenScreens: [ext('kit'), ext('demo-a')], hiddenEntries: [] }))) vi.stubEnv(name, value);
    vi.resetModules();
    try {
      // Imported by path, as verify-ui reads the composed site-meta: the shell's module is the site's to type-check, not the repository's.
      const { UNLISTED_SCREENS } = await import(path.join(import.meta.dirname, '..', 'site', 'src-app', 'app', 'layout', 'site.ts'));
      expect(UNLISTED_SCREENS).toEqual([ext('kit'), ext('demo-a')]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('unlistedFindings', () => {
  const publishing = { unlisted: ['kit', 'demo-a', 'demo-b'], hiddenEntries: [], hiddenScreens: [ext('demo-a'), ext('demo-b'), ext('kit')] };
  const outline = (entries) => ({ screen: 'home', strings: 'x', pages: [{ route: '/', title: 't', lead: 'l', entries }] });
  const page = (address, indexable) => ({ address, indexable });
  /** The page map template-site-meta inlines: every screen with its pages, the unlisted ones none of them indexable. */
  const pageMap = (screens = {}) => ({
    screens: {
      home: { pages: { '/': page('/?screen=home', true) }, patterns: [] },
      kit: { pages: { '/': page('/?screen=kit', false) }, patterns: [] },
      'demo-a': { pages: { '/': page('/?screen=demo-a', false) }, patterns: [] },
      'demo-b': { pages: { '/': page('/?screen=demo-b', false), '/week': page('/?screen=demo-b;route=week', false) }, patterns: [page('/?screen=demo-b;route=$id', false)] },
      ...screens,
    },
  });
  const documentWith = (map, body = '') => `<head><link rel="canonical" href="https://site.example/?screen=home" /><script type="application/json" id="site-meta-map">${JSON.stringify(map)}</script></head><body>${body}</body>`;
  const registrations = (tokens) => [{ extensions: tokens.slice(0, 1).map((token) => ({ id: ext(token) })) }, { extensions: tokens.slice(1).map((token) => ({ id: ext(token) })) }];
  const clean = () => {
    write('dist/index.html', documentWith(pageMap()));
    write('dist/sitemap.xml', '<loc>https://site.example/?screen=home</loc>');
    write('dist/home/index.md', '- [Home](https://site.example/?screen=home)\n\n```json\n{ "id": "ext.kit", "route": "/?screen=kit" }\n```\n');
    write('dist/generated-mfe-manifests.json', registrations(['home', 'kit', 'demo-a', 'demo-b']));
    for (const name of ['home-mfe', 'kit-mfe', 'demo-mfe']) write(`dist/mfe/${name}/remoteEntry.js`, 'export {};');
    write('dist/mfe/home-mfe/assets/chunk.js', `"${ext('kit')}"`);
    write('src-app/mfe_packages/home-mfe/src/content/outline.json', outline([{ type: 'card-tiles', items: [{ title: 'Kit', href: { extension: ext('kit') } }, { title: 'Docs', href: { url: 'https://docs.example/' } }] }]));
    write('src-app/mfe_packages/home-mfe/src/i18n/en.json', { title: 'Home', note: 'see ?screen=kitchen, another screen' });
    // A demo's own navigation between two unlisted screens leads to no listed page.
    write('src-app/mfe_packages/demo-mfe/src/nav.tsx', 'export const next = "?screen=demo-b";');
  };
  const findings = () => unlistedFindings(site, composedScreens(site), publishing);

  it('finds nothing in a build that lays out, registers and keeps noindex every unlisted screen, with a link the page prunes, a remote bundle, the page map and a link between two unlisted screens aside', () => {
    clean();
    expect(findings()).toEqual([]);
  });

  it('turns red on a planted address in content, in a twin, in the document outside its page map and in the sitemap, and on an id in the page manifest', () => {
    clean();
    write('src-app/mfe_packages/home-mfe/src/i18n/en.json', { title: 'Home', note: 'Open [the kit](?screen=kit;route=components/button).' });
    write('dist/home/index.md', '- [Kit](https://site.example/?screen=kit)');
    write('dist/index.html', documentWith(pageMap(), '<a href="./?screen=demo-a">Demo</a>'));
    write('dist/sitemap.xml', '<loc>https://site.example/?screen=demo-b</loc>');
    write('dist/seo-manifest.json', { pages: { 'https://site.example/?screen=home': { screen: 'home', note: ext('kit') } } });
    expect(findings()).toEqual([
      'dist/home/index.md links the unlisted screen kit (screen=kit)',
      'dist/index.html links the unlisted screen demo-a (screen=demo-a)',
      `dist/seo-manifest.json names the unlisted screen ${ext('kit')}`,
      'dist/sitemap.xml links the unlisted screen demo-b (screen=demo-b)',
      'home-mfe/src/i18n/en.json links the unlisted screen kit (screen=kit)',
    ]);
  });

  it('turns red on an unlisted screen without its remote or its registration, and on a page map that lets one of its pages be indexed or has none of them', () => {
    clean();
    rmSync(path.join(site, 'dist/mfe/kit-mfe'), { recursive: true });
    write('dist/generated-mfe-manifests.json', registrations(['home', 'kit', 'demo-b']));
    const screens = Object.entries(pageMap({ 'demo-b': { pages: { '/': page('/?screen=demo-b', false), '/week': page('/?screen=demo-b;route=week', true) }, patterns: [] } }).screens).filter(([token]) => token !== 'kit');
    write('dist/index.html', documentWith({ screens: Object.fromEntries(screens) }));
    expect(findings()).toEqual([
      `dist/generated-mfe-manifests.json does not register the unlisted screen ${ext('demo-a')}, so its pages would not open`,
      'dist/mfe/kit-mfe/ is missing, so the unlisted screen kit would not open',
      'dist/index.html: the page map lets /?screen=demo-b;route=week of the unlisted screen demo-b be indexed; its robots meta needs noindex',
      "dist/index.html: the page map has no pages of the unlisted screen kit, so they would take the site's head instead of their own",
    ]);
  });

  it('turns red on a link between two stray backticks on other lines, and on a code fence that never closes', () => {
    clean();
    write('dist/home/index.md', 'A ` b\n[link](https://site.example/?screen=kit)\nC ` d\n');
    write('src-app/mfe_packages/home-mfe/src/i18n/en.json', '{\n  "a": "```md",\n  "b": "[link](?screen=demo-a)"\n}\n');
    write('dist/docs/index.md', 'Text\n\n```md\n[link](https://site.example/?screen=home)\n');
    expect(findings()).toEqual([
      'dist/docs/index.md: a code fence opened on line 3 never closes; the check cannot tell its code from its links',
      'dist/home/index.md links the unlisted screen kit (screen=kit)',
      'home-mfe/src/i18n/en.json links the unlisted screen demo-a (screen=demo-a)',
    ]);
  });

  it("turns red on a literal address in the shell's sources and the shared content, and leaves their tests aside", () => {
    clean();
    write('src-app/app/layout/Header.tsx', 'export const kit = "/?screen=kit";');
    write('src-app/app/layout/Header.test.tsx', 'expect(href).toBe("/?screen=kit");');
    write('src-app/mfe_packages/shared/site/content/links.ts', "export const demo = '?screen=demo-b;route=/';");
    expect(findings()).toEqual([
      'src-app/app/layout/Header.tsx links the unlisted screen kit (screen=kit)',
      'src-app/mfe_packages/shared/site/content/links.ts links the unlisted screen demo-b (screen=demo-b)',
    ]);
  });

  it("turns red on a literal address in a listed screen's code, and leaves its tests aside", () => {
    clean();
    write('src-app/mfe_packages/home-mfe/src/comp.tsx', 'export const href = "?screen=kit";');
    write('src-app/mfe_packages/home-mfe/src/comp.test.tsx', 'expect(href).toBe("?screen=kit");');
    expect(findings()).toEqual(['home-mfe/src/comp.tsx links the unlisted screen kit (screen=kit)']);
  });

  it('turns red on an outline link the pruning cannot take out', () => {
    clean();
    write('src-app/mfe_packages/home-mfe/src/content/outline.json', outline([{ type: 'custom', target: { extension: ext('kit') } }]));
    expect(findings()).toEqual([`home-mfe/src/content/outline.json still links the unlisted screen ${ext('kit')} after pruning; the page would show the link`]);
  });
});

describe('withoutCode', () => {
  it('drops fenced blocks and inline code, where an address is quoted text, and keeps links', () => {
    const text = 'See [it](https://x/?screen=kit).\n\n```md\nOpen /?screen=kit\n```\n\nMeasure on `/?screen=kit;route=a` and ``a `b` c``.';
    expect(withoutCode(text)).toBe('See [it](https://x/?screen=kit).\n\n\n\nMeasure on  and .');
  });

  it('strips a code span only within one line and a fence only up to its matching close, and throws on a fence that never closes', () => {
    expect(withoutCode('A ` b\n[link](https://x/?screen=kit)\nC ` d')).toBe('A ` b\n[link](https://x/?screen=kit)\nC ` d');
    expect(withoutCode('````md\n```\n?screen=kit\n````\nafter')).toBe('\nafter');
    expect(() => withoutCode('text\n```md\n?screen=kit\n')).toThrow('a code fence opened on line 2 never closes');
  });
});
