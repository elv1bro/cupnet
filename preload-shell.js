'use strict';

/**
 * Privileged shell preload — full electronAPI for browser.html, log-viewer, credentials,
 * proxy-manager, and other trusted tool windows. Tab pages use preload-view.js instead.
 */
module.exports = require('./preload.js');
