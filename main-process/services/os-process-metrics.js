'use strict';

const { execSync } = require('child_process');

/**
 * Best-effort CPU % and RSS for a foreign PID (not the current process).
 * @param {number} pid
 * @returns {{ cpuPercent: number, memWorkingSetBytes: number, memPrivateBytes: number } | null}
 */
function getPidMetrics(pid) {
    const n = Number(pid);
    if (!Number.isFinite(n) || n < 1 || n !== Math.floor(n)) return null;
    try {
        if (process.platform === 'win32') {
            const out = execSync(
                `powershell -NoProfile -Command "[math]::Round((Get-Process -Id ${n} -ErrorAction Stop).WorkingSet64)"`,
                { encoding: 'utf8', timeout: 2000 },
            ).trim();
            const ws = parseInt(out, 10);
            if (!Number.isFinite(ws)) return null;
            return { cpuPercent: 0, memWorkingSetBytes: ws, memPrivateBytes: 0 };
        }
        const out = execSync(`ps -p ${n} -o %cpu=,rss=`, { encoding: 'utf8', timeout: 2000 }).trim();
        const parts = out.split(/\s+/).filter(Boolean);
        if (parts.length < 2) return null;
        const cpu = parseFloat(parts[0]);
        const rssKb = parseInt(parts[1], 10);
        const rssBytes = Number.isFinite(rssKb) ? rssKb * 1024 : 0;
        return {
            cpuPercent: Number.isFinite(cpu) ? cpu : 0,
            memWorkingSetBytes: rssBytes,
            memPrivateBytes: 0,
        };
    } catch {
        return null;
    }
}

module.exports = { getPidMetrics };
