'use strict';

/**
 * Circuit breaker + candidate ordering with sliding-window error rate (H6)
 * and bounded Map size (H1 TTL-style eviction by last access).
 */
class ProxyResilienceManager {
    constructor(config = {}) {
        const cooldownMs = Number(config.cooldownMs) || 45000;
        const quarantineReq = Number(config.quarantineMs) || 120000;
        this.cfg = {
            enabled: config.enabled !== false,
            minSamples: Number(config.minSamples) || 6,
            consecutiveFailuresToOpen: Number(config.consecutiveFailuresToOpen) || 3,
            errorRateToOpenPct: Number(config.errorRateToOpenPct) || 60,
            cooldownMs,
            quarantineMs: Math.min(quarantineReq, cooldownMs),
            ewmaAlphaPct: Number(config.ewmaAlphaPct) || 30,
        };
        this.state = new Map();
        this.maxMapEntries = Number(config.maxMapEntries) || 200;
        this.sampleWindowMax = Number(config.sampleWindowMax) || 50;
    }

    _normalizeProxy(proxyUrl) {
        const s = String(proxyUrl || '').trim();
        if (!s) return '';
        try {
            const u = new URL(s);
            return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
        } catch {
            return s;
        }
    }

    _pruneMap() {
        if (this.state.size <= this.maxMapEntries) return;
        const arr = [...this.state.entries()].sort(
            (a, b) => (a[1].lastAccessAt || 0) - (b[1].lastAccessAt || 0),
        );
        const drop = this.state.size - this.maxMapEntries;
        for (let i = 0; i < drop; i++) this.state.delete(arr[i][0]);
    }

    _touch(entry) {
        entry.lastAccessAt = Date.now();
    }

    _pushSample(entry, sample) {
        entry.samples.push(sample);
        if (entry.samples.length > this.sampleWindowMax) {
            entry.samples.splice(0, entry.samples.length - this.sampleWindowMax);
        }
    }

    _ensureEntry(proxyUrl) {
        const key = this._normalizeProxy(proxyUrl);
        if (!this.state.has(key)) {
            this.state.set(key, {
                key,
                circuit: 'closed',
                circuitOpenedAt: 0,
                circuitOpenUntil: 0,
                quarantinedUntil: 0,
                consecutiveFailures: 0,
                lastError: '',
                lastErrorAt: 0,
                lastSuccessAt: 0,
                latencyEwmaMs: 0,
                samples: [],
                lastAccessAt: 0,
            });
        }
        const entry = this.state.get(key);
        this._touch(entry);
        this._pruneMap();
        return entry;
    }

    _errorRatePct(entry) {
        const s = entry.samples;
        if (!s.length) return 0;
        const fails = s.filter(x => !x.ok).length;
        return Math.round((fails / s.length) * 100);
    }

    _shouldOpenCircuit(entry) {
        if (entry.consecutiveFailures >= this.cfg.consecutiveFailuresToOpen) return true;
        if (entry.samples.length < this.cfg.minSamples) return false;
        return this._errorRatePct(entry) >= this.cfg.errorRateToOpenPct;
    }

    _toHalfOpenIfReady(entry) {
        const now = Date.now();
        if (entry.circuit === 'open' && now >= entry.circuitOpenUntil) {
            entry.circuit = 'half-open';
        }
    }

    canAttempt(proxyUrl) {
        if (!this.cfg.enabled) return true;
        const entry = this._ensureEntry(proxyUrl);
        this._toHalfOpenIfReady(entry);
        const now = Date.now();
        if (entry.quarantinedUntil > now) return false;
        return entry.circuit !== 'open';
    }

    registerSuccess(proxyUrl, latencyMs = 0) {
        const entry = this._ensureEntry(proxyUrl);
        const now = Date.now();
        this._pushSample(entry, { t: now, ok: true, lat: latencyMs });
        entry.lastSuccessAt = now;
        entry.consecutiveFailures = 0;
        if (entry.circuit === 'half-open' || entry.circuit === 'open') entry.circuit = 'closed';
        const alpha = Math.max(0.01, Math.min(1, (this.cfg.ewmaAlphaPct || 30) / 100));
        const val = Math.max(0, Number(latencyMs) || 0);
        entry.latencyEwmaMs = entry.latencyEwmaMs
            ? Math.round(entry.latencyEwmaMs * (1 - alpha) + val * alpha)
            : val;
        return { key: entry.key, circuit: entry.circuit, latencyEwmaMs: entry.latencyEwmaMs };
    }

    registerFailure(proxyUrl, error) {
        const entry = this._ensureEntry(proxyUrl);
        const now = Date.now();
        this._pushSample(entry, { t: now, ok: false, lat: 0 });
        entry.consecutiveFailures++;
        entry.lastErrorAt = now;
        entry.lastError = error?.message || String(error || 'unknown');

        let event = null;
        if (this._shouldOpenCircuit(entry)) {
            entry.circuit = 'open';
            entry.circuitOpenedAt = Date.now();
            entry.circuitOpenUntil = entry.circuitOpenedAt + this.cfg.cooldownMs;
            event = 'circuit_opened';
        }
        if (entry.consecutiveFailures >= this.cfg.consecutiveFailuresToOpen) {
            entry.quarantinedUntil = Math.max(entry.quarantinedUntil, Date.now() + this.cfg.quarantineMs);
            event = event || 'quarantined';
        }
        return {
            key: entry.key,
            event,
            circuit: entry.circuit,
            openUntil: entry.circuitOpenUntil,
            quarantinedUntil: entry.quarantinedUntil,
            errorRatePct: this._errorRatePct(entry),
            consecutiveFailures: entry.consecutiveFailures,
            lastError: entry.lastError,
        };
    }

    orderCandidates(candidates = []) {
        const list = [...new Set((candidates || []).map(v => String(v || '').trim()).filter(Boolean))];
        const now = Date.now();
        return list.sort((a, b) => {
            const ea = this._ensureEntry(a);
            const eb = this._ensureEntry(b);
            this._toHalfOpenIfReady(ea);
            this._toHalfOpenIfReady(eb);

            const aBlocked = (ea.quarantinedUntil > now || ea.circuit === 'open') ? 1 : 0;
            const bBlocked = (eb.quarantinedUntil > now || eb.circuit === 'open') ? 1 : 0;
            if (aBlocked !== bBlocked) return aBlocked - bBlocked;

            const aScore = (ea.samples.filter(s => s.ok).length - ea.samples.filter(s => !s.ok).length)
                - Math.round((ea.latencyEwmaMs || 0) / 100);
            const bScore = (eb.samples.filter(s => s.ok).length - eb.samples.filter(s => !s.ok).length)
                - Math.round((eb.latencyEwmaMs || 0) / 100);
            return bScore - aScore;
        });
    }

    snapshot() {
        const out = [];
        for (const entry of this.state.values()) {
            const attempts = entry.samples.length;
            const successes = entry.samples.filter(s => s.ok).length;
            const failures = entry.samples.filter(s => !s.ok).length;
            out.push({
                key: entry.key,
                circuit: entry.circuit,
                attempts,
                successes,
                failures,
                consecutiveFailures: entry.consecutiveFailures,
                errorRatePct: this._errorRatePct(entry),
                latencyEwmaMs: entry.latencyEwmaMs,
                openUntil: entry.circuitOpenUntil,
                quarantinedUntil: entry.quarantinedUntil,
                lastError: entry.lastError,
                lastErrorAt: entry.lastErrorAt,
                lastSuccessAt: entry.lastSuccessAt,
            });
        }
        return out.sort((a, b) => b.attempts - a.attempts);
    }
}

module.exports = { ProxyResilienceManager };
