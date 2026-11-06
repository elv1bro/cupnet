import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const build = pkg.build || {};

describe('electron-builder config', () => {
    it('publishes to github', () => {
        const publish = Array.isArray(build.publish) ? build.publish : [build.publish];
        expect(publish).toContain('github');
    });

    it('mac artifactName is per-arch (multi-arch target must not collide)', () => {
        const target = build.mac?.target?.[0];
        // Both arches build; the filename MUST carry ${arch} or the second job
        // overwrites the first and users download the wrong-arch DMG.
        expect(target?.arch).toEqual(expect.arrayContaining(['x64', 'arm64']));
        expect(build.mac?.artifactName).toContain('${arch}');
        expect(build.mac?.artifactName).toContain('${version}');
    });

    it('win/linux artifactName carry the version', () => {
        expect(build.win?.artifactName).toContain('${version}');
        expect(build.linux?.artifactName).toContain('${version}');
    });

    it('build.files excludes dev junk from app.asar', () => {
        const files = build.files || [];
        for (const glob of ['!tests${/*}', '!docs${/*}', '!.github${/*}', '!.claude${/*}', '!*.md']) {
            expect(files).toContain(glob);
        }
        // Go worker SOURCES excluded (binary ships via extraResources).
        expect(files).toContain('!azuretls-go/**/*.go');
    });

    it('ships the Go worker binary via extraResources', () => {
        const extra = build.extraResources || [];
        const goBin = extra.find((e) => e && e.from === 'azuretls-go/bin');
        expect(goBin).toBeTruthy();
        expect(goBin.to).toBe('azuretls-go/bin');
    });

    it('wires the afterPack Go-worker guard (A-045: per-arch worker must ship)', () => {
        // The mac DMG target builds both x64+arm64; extraResources copies whatever
        // is in azuretls-go/bin into EACH. The afterPack hook fails the build if the
        // packaged app for its arch is missing the worker it loads at runtime, so a
        // CI step that only built the host-arch worker can't ship a workerless DMG.
        expect(build.afterPack).toBe('scripts/after-pack-verify-go-worker.cjs');
    });
});
