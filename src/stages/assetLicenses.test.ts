import { describe, expect, it } from 'vitest';

/*
 * Every shipped binary asset under content/ must be listed in ASSET_LICENSES.md by its
 * repo-relative path. Files are found with Vite's import.meta.glob (like the stage registry),
 * which keeps this test free of node:fs so it type-checks with the app's browser tsconfig.
 * The non-eager glob only lists paths; nothing is loaded.
 */
const ASSET_PATHS = Object.keys(import.meta.glob('/content/**/*.{glb,png,webp,jpg,ogg,opus,wav,mp3}'))
  .map((path) => path.replace(/^\//, ''))
  .sort();
const DOCS = import.meta.glob('/ASSET_LICENSES.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const DOC = DOCS['/ASSET_LICENSES.md'] ?? '';

/** True when `path` appears in `text` as a whole path (not as part of a longer one). */
function mentions(text: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w./-])${escaped}(?![\\w/-])`, 'm').test(text);
}

describe('asset licences', () => {
  it('ASSET_LICENSES.md exists at the repo root', () => {
    expect(DOC.length, 'ASSET_LICENSES.md is missing or empty').toBeGreaterThan(0);
  });

  it('finds shipped assets under content/', () => {
    expect(ASSET_PATHS.length).toBeGreaterThan(0);
  });

  for (const path of ASSET_PATHS) {
    it(`${path} is listed in ASSET_LICENSES.md`, () => {
      expect(mentions(DOC, path), `${path} is not mentioned in ASSET_LICENSES.md`).toBe(true);
    });
  }

  it('matches whole paths only', () => {
    expect(mentions('| `content/a/b.glb` |', 'content/a/b.glb')).toBe(true);
    expect(mentions('see content/a/b.glb.', 'content/a/b.glb')).toBe(true);
    expect(mentions('`content/a/b.glbx`', 'content/a/b.glb')).toBe(false);
    expect(mentions('`x/content/a/b.glb`', 'content/a/b.glb')).toBe(false);
  });
});
