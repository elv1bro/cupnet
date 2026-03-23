'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchesRule, matchCondition, buildActions } = require('../rules-engine');

test('rules-engine: matchCondition equals', () => {
    assert.equal(
        matchCondition({ field: 'method', op: 'equals', value: 'GET' }, { method: 'GET' }),
        true,
    );
    assert.equal(
        matchCondition({ field: 'method', op: 'equals', value: 'POST' }, { method: 'GET' }),
        false,
    );
});

test('rules-engine: matchesRule requires all conditions', () => {
    const rule = {
        conditions: [
            { field: 'method', op: 'equals', value: 'GET' },
            { field: 'url', op: 'contains', value: 'example.com' },
        ],
    };
    assert.equal(matchesRule(rule, { method: 'GET', url: 'https://example.com/x' }), true);
    assert.equal(matchesRule(rule, { method: 'POST', url: 'https://example.com/x' }), false);
});

test('rules-engine: buildActions flattens', () => {
    const actions = buildActions([
        { id: 1, name: 'A', actions: [{ type: 'highlight', color: 'red' }] },
        { id: 2, name: 'B', actions: [{ type: 'notification', title: 't' }] },
    ]);
    assert.equal(actions.length, 2);
    assert.equal(actions[0].ruleName, 'A');
    assert.equal(actions[1].ruleName, 'B');
});

console.log('\n✓ rules-engine tests passed\n');
