'use strict';

const api = window.electronAPI;

const titles = ['Welcome', 'Trust & certificate', 'Traffic mode', 'Quick tour'];
let step = 0;
const total = 4;

const elTitle = document.getElementById('onb-title');
const elStepLabel = document.getElementById('onb-step-label');
const btnBack = document.getElementById('onb-back');
const btnNext = document.getElementById('onb-next');
const panels = document.querySelectorAll('.onb-panel');

function render() {
    panels.forEach((p) => {
        p.classList.toggle('active', Number(p.dataset.step) === step);
    });
    elTitle.textContent = titles[step] || 'Welcome';
    elStepLabel.textContent = `Step ${step + 1} of ${total}`;
    btnBack.style.visibility = step === 0 ? 'hidden' : 'visible';
    btnNext.textContent = step === total - 1 ? 'Get started' : 'Next';
}

btnBack.addEventListener('click', () => {
    if (step > 0) {
        step--;
        render();
    }
});

btnNext.addEventListener('click', async () => {
    if (step < total - 1) {
        step++;
        render();
        return;
    }
    try {
        if (api.completeOnboarding) await api.completeOnboarding();
        window.close();
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'Could not save';
        if (typeof showToast === 'function') showToast(msg, { type: 'error' });
    }
});

render();
