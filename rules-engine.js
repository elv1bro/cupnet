'use strict';

const db = require('./db');

/**
 * Evaluates all enabled rules against a completed request entry.
 * Returns the list of matched rules with their actions.
 *
 * @param {object} entry – request row from DB (or in-memory log entry)
 * @returns {Array<{rule, actions}>}
 */
function evaluate(entry) {
    const rules = db.getRules().filter(r => r.enabled);
    const matched = [];

    for (const rule of rules) {
        if (matchesRule(rule, entry)) {
            matched.push(rule);
            db.incrementRuleHitAsync(rule.id).catch(() => {});
        }
    }

    return matched;
}

function matchesRule(rule, entry) {
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    if (!conditions.length) return false;
    return conditions.every(cond => matchCondition(cond, entry));
}

function matchCondition(cond, entry) {
    const fieldValue = getField(cond.field, entry);
    const { op, value } = cond;

    switch (op) {
        case 'equals':     return String(fieldValue) === String(value);
        case 'notEquals':  return String(fieldValue) !== String(value);
        case 'contains':   return String(fieldValue).includes(String(value));
        case 'notContains':return !String(fieldValue).includes(String(value));
        case 'startsWith': return String(fieldValue).startsWith(String(value));
        case 'endsWith':   return String(fieldValue).endsWith(String(value));
        case 'matches': {
            try { return new RegExp(value).test(String(fieldValue)); }
            catch { return false; }
        }
        case 'gt': return Number(fieldValue) > Number(value);
        case 'lt': return Number(fieldValue) < Number(value);
        case 'gte': return Number(fieldValue) >= Number(value);
        case 'lte': return Number(fieldValue) <= Number(value);
        case 'between': {
            const [min, max] = Array.isArray(value) ? value : [value, value];
            const n = Number(fieldValue);
            return n >= Number(min) && n <= Number(max);
        }
        case 'exists':    return fieldValue != null && fieldValue !== '';
        case 'notExists': return fieldValue == null || fieldValue === '';
        default: return false;
    }
}

function getField(field, entry) {
    const fieldMap = {
        url:          () => entry.url || '',
        method:       () => entry.method || '',
        status:       () => entry.status,
        type:         () => entry.type || '',
        duration:     () => entry.duration_ms || entry.duration || 0,
        responseBody: () => entry.response_body || entry.responseBody || '',
        requestBody:  () => entry.request_body  || entry.requestBody  || '',
        host:         () => {
            try { return new URL(entry.url || '').hostname; } catch { return ''; }
        },
        error:        () => entry.error || ''
    };
    return fieldMap[field] ? fieldMap[field]() : '';
}

/**
 * Actions that CAN be handled in the main process:
 *   highlight – send IPC to renderer with { color, requestId }
 *   screenshot – trigger screenshot capture
 *   notification – show OS notification
 *   block – mark entry as blocked (must be used in request-interceptor)
 */
function buildActions(matchedRules) {
    const actions = [];
    for (const rule of matchedRules) {
        const ruleActions = Array.isArray(rule.actions) ? rule.actions : [];
        for (const action of ruleActions) {
            actions.push({ ...action, ruleName: rule.name, ruleId: rule.id });
        }
    }
    return actions;
}

module.exports = { evaluate, buildActions, matchesRule, matchCondition };
