/**
 * Rebuilds the LANGS object in cupnet-guide.html from scripts/guide-i18n/*.mjs
 * Run: node scripts/build-new-tab-guide.mjs  (npm run build:guide)
 */
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import en from './guide-i18n/en.mjs';
import fr from './guide-i18n/fr.mjs';
import es from './guide-i18n/es.mjs';
import ru from './guide-i18n/ru.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function kbdRow(key, desc) {
    return `<div class="g-kbd-row"><span class="kd">${key}</span><span class="kd-desc">${desc}</span></div>`;
}

const LANGS = {
    en: en(kbdRow),
    fr: fr(kbdRow),
    es: es(kbdRow),
    ru: ru(kbdRow),
};

const serialized =
    `const LANGS = {
en: ${JSON.stringify(LANGS.en)},
fr: ${JSON.stringify(LANGS.fr)},
es: ${JSON.stringify(LANGS.es)},
ru: ${JSON.stringify(LANGS.ru)},

    }; // end LANGS`;

const htmlPath = join(__dirname, '..', 'cupnet-guide.html');
let text = fs.readFileSync(htmlPath, 'utf8');
const start = text.indexOf('const LANGS = {');
const endMarker = '    }; // end LANGS';
const end = text.indexOf(endMarker);
if (start < 0 || end < 0) throw new Error('LANGS markers not found in cupnet-guide.html');
const newText = text.slice(0, start) + serialized + text.slice(end + endMarker.length);
fs.writeFileSync(htmlPath, newText);
console.log('OK: patched cupnet-guide.html LANGS');
