/**
 * Runs Playwright e2e. When CUPNET_SKIP_E2E=1 or SKIP_E2E=1, all tests are ignored
 * (see playwright.config.js) and --pass-with-no-tests avoids a failing exit code.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const skip = process.env.CUPNET_SKIP_E2E === '1' || process.env.SKIP_E2E === '1';
const extraArgs = process.argv.slice(2);
const args = ['playwright', 'test', ...extraArgs];
if (skip) {
    args.push('--pass-with-no-tests');
}

const r = spawnSync('npx', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
});

process.exit(r.status === null ? 1 : r.status);
