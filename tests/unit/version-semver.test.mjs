import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));

// Strict SemVer 2.0.0 core (optional pre-release / build metadata). Rejects the
// old date form `27.06.2026-5` (leading zeros, four-segment, non-monotonic).
const SEMVER =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

describe('version scheme', () => {
    it('package.json version is strict semver', () => {
        expect(pkg.version).toMatch(SEMVER);
    });

    it('is exactly 2.0.0 for this release', () => {
        // Guard against silently regressing to the non-monotonic date form.
        expect(pkg.version).toBe('2.0.0');
    });

    it('package-lock version fields match package.json', () => {
        expect(lock.version).toBe(pkg.version);
        // npm lockfile v2/v3 mirrors the version under packages[""].
        expect(lock.packages?.['']?.version).toBe(pkg.version);
    });
});
