/**
 * CupNet shared toast notifications (renderer-safe, no dependencies).
 * Styles: shared-dark-theme.css (#cn-toast-container, .cn-toast-*)
 */
(function attachCupnetToast(global) {
  'use strict';

  function ensureContainer() {
    let el = document.getElementById('cn-toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cn-toast-container';
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-relevant', 'additions');
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  /**
   * @param {string} message
   * @param {{ type?: 'info'|'success'|'warning'|'error', duration?: number }} [opts]
   */
  function showToast(message, opts) {
    if (message == null || message === '') return;
    const options = opts && typeof opts === 'object' ? opts : {};
    const type = options.type || 'info';
    const duration = typeof options.duration === 'number' ? options.duration : 3200;

    const container = ensureContainer();
    const toast = document.createElement('div');
    toast.className = 'cn-toast cn-toast-' + type;
    toast.setAttribute('role', 'status');
    toast.textContent = String(message);

    const close = () => {
      if (!toast.parentNode) return;
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
      toast.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
      setTimeout(() => toast.remove(), 160);
    };

    container.appendChild(toast);

    let t = null;
    if (duration > 0) {
      t = setTimeout(close, duration);
    }

    toast.addEventListener('click', () => {
      if (t) clearTimeout(t);
      close();
    });
  }

  global.showToast = showToast;
  global.cupnetToast = { show: showToast };
})(typeof window !== 'undefined' ? window : globalThis);
