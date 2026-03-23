'use strict';
const e = require('electron');
console.log('electron type:', typeof e);
if (typeof e === 'object' && e) {
    console.log('keys:', Object.keys(e).slice(0, 10).join(', '));
    console.log('app:', typeof e.app);
} else {
    console.log('value:', JSON.stringify(e));
}
process.exit(0);
