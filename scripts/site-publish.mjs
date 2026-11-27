#!/usr/bin/env node
// What the production build links (architecture/DESIGN.md section 4.15, "Unlisted screens and indexing"). `site.config.json` lists the screens nothing links (`unlistedScreens`, route tokens) and the outline entries it hides (`hiddenEntries`); without them every screen is listed. Every screen is built either way: an unlisted screen keeps its remote and its registration, and its pages open by their address with `noindex`. Composition stays whole, so `npm run dev`, the tests and the UI gate link every screen: only the production build takes the links out.
//   node scripts/site-publish.mjs build   runs the site build (`npm run build --prefix site`) with the publishing choices in the build variables the screens and the shell read (VITE_SITE_HIDDEN_SCREENS, VITE_SITE_HIDDEN_ENTRIES)
//   node scripts/site-publish.mjs check   fails when the built site links an unlisted screen (an address of it in the document, the discovery files or the twins, a link in a listed screen's content), when an unlisted screen has no registration or no remote entry file, or when the page map lacks a page it declares or lets one be indexed
// `scripts/site-dist.mjs` lays out every remote, and template-site-meta keeps the unlisted screens in the page map, not indexable, and leaves them out of the discovery files and the twins.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { pruneOutline } from '../template-site/src-app/mfe_packages/shared/site/content/publish.ts';

/** The shell's screen domain instance, relative to the site: its `id` names the domain, its `route` is the address key (`screen`). */
const SCREEN_DOMAIN_FILE = ['packages', 'framework', 'src', 'plugins', 'microfrontends', 'gts', 'frontx.screensets', 'instances', 'domains', 'screen.v1.json'];
/** The outline files a screen package may carry, as template-site-meta reads them. */
const OUTLINE_FILES = ['src/content/outline.json', 'src/content/outline.generated.json'];
/** The folders of dist/ that hold built code, never generated text: a screen's bundle carries its whole content, which the build-time checks read from the sources instead. */
const CODE_DIRS = new Set(['mfe', 'assets']);
/** The text files of dist/ the check reads; in the generated machine files (the document, the discovery files) an extension id is a link too. */
const TEXT_FILE = /\.(html|md|txt|xml|json|webmanifest)$/;
const MACHINE_FILE = /\.(html|xml|json|webmanifest)$/;
/** The markup files of dist/: a backtick opens no code in HTML or XML, so they are read whole, their inline scripts included, and nothing between two backticks of one line is skipped. */
const MARKUP_FILE = /\.(html|xml)$/;
/** The aggregate the shell registers the screens from: it must carry the unlisted screens, so the link scan leaves it to the registration check. */
const AGGREGATE_FILE = 'generated-mfe-manifests.json';
/** The page map template-site-meta inlines into the document: head-sync gives each page, an unlisted one included, its head from it, so the link scan leaves it to the noindex check. */
const PAGE_MAP = /<script type="application\/json" id="site-meta-map">([\s\S]*?)<\/script>/;
/** The shell's own sources and the content the screens share, relative to the site: their code is bundled into every page, so a literal address in it is a link the dist scan cannot see (it skips the built code). */
const SHELL_SOURCE_DIRS = [['src-app', 'app'], ['src-app', 'mfe_packages', 'shared']];
const SOURCE_FILE = /\.(ts|tsx|json|md)$/;
/** Tests are not bundled, and may plant an address on purpose. */
const TEST_FILE = /\.test\.[^/\\]+$/;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const NOT_A_PACKAGE = (name) => name === 'shared' || name.startsWith('.');

/**
 * The site's publishing choices from its config, each list checked: `unlistedScreens` and `hiddenEntries`, empty when absent. The key's former name, `unpublishedScreens`, is refused, so a config written for the old meaning (screens left out of the build) is renamed, not read as listing every screen.
 * @param {Record<string, unknown>} config - the parsed site config
 * @returns {{ unlisted: string[], hiddenEntries: string[] }}
 */
// @cpt-algo:cpt-site-algo-production-build-layout-publishing:p2
export function publishingChoices(config) {
  // @cpt-begin:cpt-site-algo-production-build-layout-publishing:p2:inst-read-lists
  const list = (name) => {
    const value = config[name] ?? [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) throw new Error(`site-publish: site.config.json ${name} must be a list of non-empty strings`);
    return value;
  };
  if (Object.hasOwn(config, 'unpublishedScreens')) throw new Error('site-publish: site.config.json unpublishedScreens is now unlistedScreens: an unlisted screen is built and opens by its address, only its links go; rename the key');
  return { unlisted: list('unlistedScreens'), hiddenEntries: list('hiddenEntries') };
  // @cpt-end:cpt-site-algo-production-build-layout-publishing:p2:inst-read-lists
}

/**
 * The screen extensions of the composed packages, read with the shell scanner rules (no `shared`, no dot entries, no package marked `templateExample`).
 * @param {string} siteDir - the site directory
 * @returns {{ domainKey: string, screens: { token: string, id: string, packageDir: string, routes: string[] }[] }} - `routes` are the paths the screen's `seo.routes` declares
 */
export function composedScreens(siteDir) {
  // @cpt-begin:cpt-site-algo-production-build-layout-publishing:p2:inst-read-screens
  const domain = readJson(path.join(siteDir, ...SCREEN_DOMAIN_FILE));
  const packagesDir = path.join(siteDir, 'src-app', 'mfe_packages');
  const screens = [];
  for (const name of fs.readdirSync(packagesDir).sort()) {
    const file = path.join(packagesDir, name, 'mfe.json');
    if (NOT_A_PACKAGE(name) || !fs.existsSync(file)) continue;
    const manifest = readJson(file);
    if (manifest.templateExample === true) continue;
    for (const extension of manifest.extensions ?? []) {
      if (extension.domain === domain.id) screens.push({ token: String(extension.route).replace(/^\//, ''), id: extension.id, packageDir: name, routes: Object.keys(extension.seo?.routes ?? {}) });
    }
  }
  return { domainKey: domain.route, screens };
  // @cpt-end:cpt-site-algo-production-build-layout-publishing:p2:inst-read-screens
}

/**
 * What the build links: the unlisted screens resolved to their extension ids. Fails on a token no screen declares, on the home screen, which the brand and the bare address open, and on a footer screen, which every page links.
 * @param {Record<string, unknown>} config - the parsed site config
 * @param {{ token: string, id: string, packageDir: string }[]} screens - the composed screen extensions
 */
export function resolvePublishing(config, screens) {
  // @cpt-begin:cpt-site-algo-production-build-layout-publishing:p2:inst-resolve-tokens
  const { unlisted, hiddenEntries } = publishingChoices(config);
  const tokens = new Set(screens.map((screen) => screen.token));
  const unknown = unlisted.filter((token) => !tokens.has(token));
  if (unknown.length > 0) throw new Error(`site-publish: site.config.json unlistedScreens names ${unknown.join(', ')}, which no composed screen declares`);
  if (unlisted.includes(String(config.homeScreen))) throw new Error(`site-publish: site.config.json unlistedScreens names the home screen ${config.homeScreen}`);
  const footer = (Array.isArray(config.footerScreens) ? config.footerScreens : []).filter((token) => unlisted.includes(token));
  if (footer.length > 0) throw new Error(`site-publish: site.config.json footerScreens links ${footer.join(', ')}, which unlistedScreens names`);
  const hidden = screens.filter((screen) => unlisted.includes(screen.token));
  return { unlisted, hiddenEntries, hiddenScreens: hidden.map((screen) => screen.id) };
  // @cpt-end:cpt-site-algo-production-build-layout-publishing:p2:inst-resolve-tokens
}

/**
 * The build variables that carry the publishing choices to the screens (template-site's `shared/site/content/publish.ts` reads them) and to the shell's header (`site/src-app/app/layout/site.ts`).
 * @param {{ hiddenScreens: string[], hiddenEntries: string[] }} publishing
 * @returns {Record<string, string>}
 */
export function publishingEnv(publishing) {
  // @cpt-begin:cpt-site-algo-production-build-layout-publishing:p2:inst-build-variables
  return { VITE_SITE_HIDDEN_SCREENS: JSON.stringify(publishing.hiddenScreens), VITE_SITE_HIDDEN_ENTRIES: JSON.stringify(publishing.hiddenEntries) };
  // @cpt-end:cpt-site-algo-production-build-layout-publishing:p2:inst-build-variables
}

/** The folder of dist/ that holds one sub-folder per remote (`scripts/site-dist.mjs`). */
const MFE_DIR = 'mfe';

/**
 * The remote entry file a registered screen loads, as a path in dist/, or why there is none. The screen's extension names its entry, which the config must declare; the entry's manifest is the object it carries, or the config's manifest when the entry references that one by id. The file is the manifest's `publicPath` joined with its `remoteEntry` path and name, the way the MFE handler resolves it against the aggregate, and must sit under `mfe/`.
 * @param {object} config - the aggregate config that registers the screen
 * @param {string} extensionId - the screen's extension id
 * @returns {{ file: string } | { problem: string }}
 */
export function remoteEntryFile(config, extensionId) {
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-check-remotes
  const extension = (config.extensions ?? []).find((candidate) => candidate.id === extensionId);
  const entry = (config.entries ?? []).find((candidate) => candidate.id === extension?.entry);
  if (!entry) return { problem: `declares no entry ${extension?.entry ?? '(none named)'} for the unlisted screen ${extensionId}` };
  const manifest = typeof entry.manifest === 'object' && entry.manifest !== null ? entry.manifest : entry.manifest === config.manifest?.id ? config.manifest : undefined;
  if (!manifest) return { problem: `gives the entry ${entry.id} of the unlisted screen ${extensionId} no manifest it carries or its config's manifest names` };
  const publicPath = manifest.metaData?.publicPath;
  const remoteEntry = manifest.metaData?.remoteEntry;
  if (typeof publicPath !== 'string' || typeof remoteEntry?.name !== 'string' || remoteEntry.name === '') return { problem: `gives the unlisted screen ${extensionId} no remote entry address` };
  const file = path.posix.normalize([publicPath, remoteEntry.path ?? '', remoteEntry.name].filter(Boolean).join('/'));
  return file.startsWith(`${MFE_DIR}/`) ? { file } : { problem: `gives the unlisted screen ${extensionId} the remote entry ${file}, which is not under ${MFE_DIR}/` };
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-check-remotes
}

/**
 * The address of an unlisted screen in a text: `screen=<token>` ended by anything that cannot continue a token.
 * @param {string} domainKey - the screen domain's address key
 * @param {string} token - the screen's route token
 */
function addressPattern(domainKey, token) {
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-check-outputs
  return new RegExp(`[?&;]${domainKey}=${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-check-outputs
}

/**
 * A text without its code: fenced blocks and inline code spans, where an address is quoted source text, not a link. A fenced block goes only between two matching fence lines and a code span only when it opens and closes on one line, so a stray backtick cannot hide a link on another line; a fence that never closes throws, so the check fails closed.
 * @param {string} text
 * @returns {string}
 */
export function withoutCode(text) {
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-check-outputs
  const lines = text.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fence = /^(`{3,})[^`]*$/.exec(lines[index])?.[1];
    if (fence) {
      const close = lines.findIndex((line, at) => at > index && new RegExp(`^${fence}\`*[ \\t\\r]*$`).test(line));
      if (close === -1) throw new Error(`a code fence opened on line ${index + 1} never closes`);
      kept.push('');
      index = close;
      continue;
    }
    kept.push(lines[index].replace(/(`+)(?!`).*?(?<!`)\1(?!`)/g, ''));
  }
  return kept.join('\n');
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-check-outputs
}

/** Every file under a folder, as paths relative to it, skipping the folders `skip` names at the top. */
function filesUnder(dir, skip = new Set(), prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return prefix === '' && skip.has(entry.name) ? [] : filesUnder(path.join(dir, entry.name), skip, relative);
    return [relative];
  });
}

/**
 * Where the built site links an unlisted screen, or would not open or would let be indexed one, as messages; empty when it does neither.
 * - the aggregate in `dist/` does not register an unlisted screen's extension, or the remote entry file its manifest names (`mfe/<package>/remoteEntry.js`) is not in `dist/`, so its pages would not open;
 * - Markdown sits in an unlisted screen's twin folder (`dist/<token>/`), a twin left from an earlier configuration;
 * - a generated text file of `dist/` (the document without its page map, the discovery files, the twins; the aggregate is the registry and is left to the check above) names an unlisted screen's address (`?screen=<token>`): anywhere in markup (HTML, XML), where a backtick opens no code, and outside code elsewhere, where a quoted source file may mention one; a generated machine file (the document, the manifests, the sitemap) names its extension id;
 * - the page map in `dist/index.html` lacks a page an unlisted screen declares (its root, a route of its `seo.routes`), or lets one of its pages or pattern routes be indexed: head-sync writes the head and the robots meta from it;
 * - a listed screen package's sources under `src/` (tests aside) name such an address: its JSON data outside code, strings included, its TypeScript and Markdown anywhere, code included, since that code is what ships; or its outline, pruned as the page shows it, still links such a screen;
 * - the shell's own sources or the screens' shared content (`src-app/app/`, `src-app/mfe_packages/shared/`; TypeScript, JSON and Markdown, tests aside) name such an address anywhere, code included, since that code is what ships;
 * - a text the check reads opens a code fence that never closes, so it cannot tell its code from its links.
 * The unlisted screens' own packages are not read: a link between two unlisted pages (a demo's own navigation) leads to no listed page.
 * @param {string} siteDir - the site directory
 * @param {{ domainKey: string, screens: { token: string, id: string, packageDir: string, routes: string[] }[] }} composed - the composed screens
 * @param {{ unlisted: string[], hiddenScreens: string[], hiddenEntries: string[] }} publishing - what the build links
 * @returns {string[]}
 */
// @cpt-algo:cpt-site-algo-production-build-layout-check-links:p2
export function unlistedFindings(siteDir, composed, publishing) {
  const findings = [];
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-check-remotes
  const distDir = path.join(siteDir, 'dist');
  const unlisted = composed.screens.filter((screen) => publishing.unlisted.includes(screen.token));
  const aggregateFile = path.join(distDir, AGGREGATE_FILE);
  if (!fs.existsSync(aggregateFile)) findings.push(`dist/${AGGREGATE_FILE} is missing, so no screen would open`);
  const configs = fs.existsSync(aggregateFile) ? readJson(aggregateFile) : [];
  for (const screen of unlisted) {
    const config = configs.find((candidate) => (candidate.extensions ?? []).some((extension) => extension.id === screen.id));
    if (!config) {
      if (fs.existsSync(aggregateFile)) findings.push(`dist/${AGGREGATE_FILE} does not register the unlisted screen ${screen.id}, so its pages would not open`);
      continue;
    }
    const entry = remoteEntryFile(config, screen.id);
    if ('problem' in entry) findings.push(`dist/${AGGREGATE_FILE} ${entry.problem}, so its pages would not open`);
    else if (!fs.existsSync(path.join(distDir, ...entry.file.split('/')))) findings.push(`dist/${entry.file} is missing, so the unlisted screen ${screen.token} would not open`);
  }
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-check-remotes
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-check-outputs
  const addresses = publishing.unlisted.map((token) => ({ token, pattern: addressPattern(composed.domainKey, token) }));
  /** The text outside code, or undefined with a finding when the check cannot tell code from links. */
  const prose = (label, text) => {
    try {
      return withoutCode(text);
    } catch (error) {
      findings.push(`${label}: ${error instanceof Error ? error.message : String(error)}; the check cannot tell its code from its links`);
      return undefined;
    }
  };
  const scan = (label, text, ids, markup) => {
    const outside = markup ? text : prose(label, text);
    if (outside !== undefined) for (const { token, pattern } of addresses) if (pattern.test(outside)) findings.push(`${label} links the unlisted screen ${token} (${composed.domainKey}=${token})`);
    if (ids) for (const id of publishing.hiddenScreens) if (text.includes(id)) findings.push(`${label} names the unlisted screen ${id}`);
  };
  for (const file of filesUnder(distDir, CODE_DIRS).filter((name) => TEXT_FILE.test(name) && name !== AGGREGATE_FILE)) {
    const text = fs.readFileSync(path.join(distDir, file), 'utf8');
    scan(`dist/${file.split(path.sep).join('/')}`, file.endsWith('.html') ? text.replace(PAGE_MAP, '') : text, MACHINE_FILE.test(file), MARKUP_FILE.test(file));
  }
  // An unlisted screen has no twin: its outline is not rendered, so Markdown in its token's folder is one left from an earlier configuration.
  for (const screen of unlisted) for (const file of filesUnder(path.join(distDir, screen.token)).filter((name) => name.endsWith('.md'))) findings.push(`dist/${screen.token}/${file.split(path.sep).join('/')} is a twin of the unlisted screen ${screen.token}, which publishes none`);
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-check-outputs
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-check-noindex
  const documentFile = path.join(distDir, 'index.html');
  const mapText = fs.existsSync(documentFile) ? PAGE_MAP.exec(fs.readFileSync(documentFile, 'utf8'))?.[1] : undefined;
  if (mapText === undefined) {
    if (unlisted.length > 0) findings.push('dist/index.html carries no page map, so the unlisted screens get no noindex head');
  } else {
    const screens = JSON.parse(mapText).screens ?? {};
    for (const screen of unlisted) {
      const own = Object.hasOwn(screens, screen.token) ? screens[screen.token] : undefined;
      const pages = own ? [...Object.values(own.pages ?? {}), ...(own.patterns ?? [])] : [];
      if (pages.length === 0) findings.push(`dist/index.html: the page map has no pages of the unlisted screen ${screen.token}, so they would take the site's head instead of their own`);
      else {
        // Every page the screen declares in seo.routes (and its root) needs its own head, or it would take the site's.
        const mapped = new Set([...Object.keys(own.pages ?? {}), ...(own.patterns ?? []).map((page) => page.route)]);
        for (const route of ['/', ...screen.routes]) if (!mapped.has(route)) findings.push(`dist/index.html: the page map has no page ${route} of the unlisted screen ${screen.token}, so it would take the site's head instead of its own`);
      }
      for (const page of pages) if (page.indexable !== false) findings.push(`dist/index.html: the page map lets ${page.address} of the unlisted screen ${screen.token} be indexed; its robots meta needs noindex`);
    }
  }
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-check-noindex
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-check-content
  const packagesDir = path.join(siteDir, 'src-app', 'mfe_packages');
  const listedPackages = new Set(composed.screens.filter((screen) => !publishing.unlisted.includes(screen.token)).map((screen) => screen.packageDir));
  for (const packageDir of [...listedPackages].sort()) {
    const dir = path.join(packagesDir, packageDir);
    for (const file of filesUnder(path.join(dir, 'src')).filter((name) => SOURCE_FILE.test(name) && !TEST_FILE.test(name))) {
      const label = `${packageDir}/src/${file.split(path.sep).join('/')}`;
      const source = fs.readFileSync(path.join(dir, 'src', file), 'utf8');
      // A data file's text is read outside code, where a quoted source may mention an address; a screen's code and Markdown are bundled as they are, so they are read whole, as the shell's are.
      const text = file.endsWith('.json') ? prose(label, source) : source;
      if (text !== undefined) for (const { token, pattern } of addresses) if (pattern.test(text)) findings.push(`${label} links the unlisted screen ${token} (${composed.domainKey}=${token})`);
    }
    for (const name of OUTLINE_FILES.filter((candidate) => fs.existsSync(path.join(dir, candidate)))) {
      const shown = JSON.stringify(pruneOutline(readJson(path.join(dir, name)), publishing));
      for (const id of publishing.hiddenScreens) if (shown.includes(id)) findings.push(`${packageDir}/${name} still links the unlisted screen ${id} after pruning; the page would show the link`);
    }
  }
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-check-content
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-check-shell
  for (const parts of SHELL_SOURCE_DIRS) {
    const dir = path.join(siteDir, ...parts);
    for (const file of filesUnder(dir).filter((name) => SOURCE_FILE.test(name) && !TEST_FILE.test(name))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const { token, pattern } of addresses) if (pattern.test(text)) findings.push(`${[...parts, ...file.split(path.sep)].join('/')} links the unlisted screen ${token} (${composed.domainKey}=${token})`);
    }
  }
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-check-shell
  // @cpt-begin:cpt-site-algo-production-build-layout-check-links:p2:inst-return-findings
  return findings;
  // @cpt-end:cpt-site-algo-production-build-layout-check-links:p2:inst-return-findings
}

/**
 * Reads the config and the composed screens of a repository.
 * @param {string} root - the repository root
 */
export function loadPublishing(root) {
  // @cpt-begin:cpt-site-algo-production-build-layout-publishing:p2:inst-load
  const siteDir = path.join(root, 'site');
  const composed = composedScreens(siteDir);
  return { siteDir, composed, publishing: resolvePublishing(readJson(path.join(root, 'site.config.json')), composed.screens) };
  // @cpt-end:cpt-site-algo-production-build-layout-publishing:p2:inst-load
}

// @cpt-flow:cpt-site-flow-production-build-layout-publish:p2
// @cpt-dod:cpt-site-dod-production-build-layout-publishing:p2
if (isEntryPoint(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const command = process.argv[2];
  try {
    // @cpt-begin:cpt-site-flow-production-build-layout-publish:p2:inst-load-choices
    const { siteDir, composed, publishing } = loadPublishing(root);
    // @cpt-end:cpt-site-flow-production-build-layout-publish:p2:inst-load-choices
    if (command === 'build') {
      // @cpt-begin:cpt-site-flow-production-build-layout-publish:p2:inst-build-site
      console.log(`site-publish: building with ${publishing.unlisted.length} unlisted screen(s)${publishing.unlisted.length > 0 ? `: ${publishing.unlisted.join(', ')}` : ''}`);
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const result = spawnSync(npm, ['run', 'build', '--prefix', siteDir], { stdio: 'inherit', env: { ...process.env, ...publishingEnv(publishing) } });
      process.exitCode = result.status ?? 1;
      // @cpt-end:cpt-site-flow-production-build-layout-publish:p2:inst-build-site
    } else if (command === 'check') {
      // @cpt-begin:cpt-site-flow-production-build-layout-publish:p2:inst-check-site
      const findings = unlistedFindings(siteDir, composed, publishing);
      for (const finding of findings) console.error(`site-publish: ${finding}`);
      if (findings.length > 0) process.exitCode = 1;
      else console.log(`site-publish: nothing links the ${publishing.unlisted.length} unlisted screen(s), and each is laid out, registered and noindex`);
      // @cpt-end:cpt-site-flow-production-build-layout-publish:p2:inst-check-site
    } else {
      console.error('usage: node scripts/site-publish.mjs build | check');
      process.exitCode = 2;
    }
  } catch (error) {
    // @cpt-begin:cpt-site-flow-production-build-layout-publish:p2:inst-report-error
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    // @cpt-end:cpt-site-flow-production-build-layout-publish:p2:inst-report-error
  }
}
