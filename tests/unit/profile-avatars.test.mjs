'use strict';

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
    profileInitials,
    defaultColorForName,
    normalizeAvatarColor,
} from '../../main-process/services/profile-avatars.js';

describe('profile-avatars', () => {
    it('profileInitials uses first and last word', () => {
        assert.equal(profileInitials('Alex Morgan'), 'AM');
        assert.equal(profileInitials('Alex · Work'), 'AW');
    });

    it('profileInitials uses first two chars for single word', () => {
        assert.equal(profileInitials('DevOps'), 'DE');
    });

    it('profileInitials returns ? for empty name', () => {
        assert.equal(profileInitials(''), '?');
        assert.equal(profileInitials('   '), '?');
    });

    it('defaultColorForName is stable for the same name', () => {
        const a = defaultColorForName('Alex');
        const b = defaultColorForName('Alex');
        assert.equal(a, b);
        assert.match(a, /^#[0-9a-f]{6}$/);
    });

    it('normalizeAvatarColor falls back for invalid values', () => {
        assert.equal(normalizeAvatarColor('#AABBCC'), '#aabbcc');
        assert.equal(normalizeAvatarColor('nope'), '#3b82f6');
    });
});
