import { describe, expect, it } from 'vitest';
import { offeredLanguages, unlistedScreens } from './site';

const supported = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ar', name: 'Arabic' },
];

describe('offeredLanguages', () => {
  it('offers the supported languages the site ships, in the site order, and drops a code the framework cannot switch to', () => {
    expect(offeredLanguages(supported, ['de', 'xx', 'en']).map((language) => language.code)).toEqual(['de', 'en']);
    expect(offeredLanguages(supported, ['en'])).toHaveLength(1);
  });
});

describe('unlistedScreens', () => {
  it('reads the build variable as a JSON array of extension ids, none when it is unset or empty, and refuses any other value', () => {
    expect(unlistedScreens('["ext.kit","ext.demo"]')).toEqual(['ext.kit', 'ext.demo']);
    expect(unlistedScreens(undefined)).toEqual([]);
    expect(unlistedScreens('')).toEqual([]);
    expect(() => unlistedScreens('"ext.kit"')).toThrow('VITE_SITE_HIDDEN_SCREENS must be a JSON array of strings');
  });
});
