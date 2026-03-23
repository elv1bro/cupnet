#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { networkPolicy } = require('../network-policy');

function nowIso() { return new Date().toISOString(); }

function collectEnv() {
    const interesting = Object.keys(process.env)
        .filter(k => k.startsWith('CUPNET_'))
        .sort()
        .reduce((acc, k) => { acc[k] = process.env[k]; return acc; }, {});
    return interesting;
}

function buildBaseline() {
    return {
        ts: nowIso(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        policy: networkPolicy,
        env: collectEnv(),
    };
}

function main() {
    const baseline = buildBaseline();
    const outDir = path.join(process.cwd(), '_debug');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'stability-baseline.json');
    fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2), 'utf8');
    process.stdout.write(`Baseline saved: ${outPath}\n`);
}

main();
