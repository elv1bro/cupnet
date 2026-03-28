/** Guide FR — même structure et ancres que EN */
export default function fr(kbdRow) {
    return `
<div class="g-hero">
    <img src="img.png" class="g-hero-logo" alt="CupNet">
    <div>
        <h1 class="g-hero-title">CupNet — Guide d'utilisation</h1>
        <div class="g-hero-sub">Navigateur proxy développeur · MITM intégré · empreintes AzureTLS · journaux SQLite</div>
        <div style="margin-top:6px">
            <span class="g-pill">v2.0</span><span class="g-pill">SQLite</span>
            <span class="g-pill">CDP</span><span class="g-pill">AzureTLS</span>
        </div>
    </div>
</div>

<div id="brief" class="g-card g-brief">
    <h2>En bref</h2>
    <ul>
        <li><b>Présentation :</b> navigateur Electron où le trafic des onglets passe par la pile CupNet : proxy amont facultatif, MITM HTTPS sur le port <b>8877</b>, TLS sortant via le worker <b>AzureTLS</b> (profil JA3 / HTTP2).</li>
        <li><b>Journaux :</b> requêtes enregistrées dans <b>SQLite</b> (CDP + chemin MITM). Le bouton <b>REC</b> dans la barre d'outils met en pause/reprise ; <b>Log</b> ouvre le visualiseur (FTS, HAR, replay, trace, comparaison).</li>
        <li><b>Gestionnaire de proxies :</b> profils chiffrés ( trousseau OS), <b>Appliquer globalement</b> ou <b>Appliquer à l'onglet actif</b>, statistiques MITM en direct dans la barre supérieure.</li>
        <li><b>Barre d'outils :</b> DNS, éditeur de requêtes, règles &amp; interception, analyseur de page, console système, paramètres (fenêtre séparée).</li>
        <li><b>Page nouvel onglet :</b> recherche, liens rapides, carte proxy/IP (badge MITM, portée par onglet), interrupteur cookies <b>Partagé / Isolé</b>, <b>proxy externe</b> pour curl/scripts.</li>
        <li><b>Confiance :</b> les sessions Chromium intégrées font confiance au CA MITM automatiquement. Pour d'autres outils, utilisez le PEM sur disque (voir <a href="#mitm">MITM &amp; CA</a>) ou passez par le proxy externe.</li>
    </ul>
</div>

<div class="g-card g-toc">
    <h2>Sommaire</h2>
    <a href="#brief">0. En bref</a>
    <a href="#gs">1. Démarrage rapide</a>
    <a href="#traffic">2. Chemin réseau &amp; enregistrement</a>
    <a href="#proxy">3. Gestionnaire de proxies</a>
    <a href="#fingerprint">4. Empreinte &amp; TLS</a>
    <a href="#toolbar">5. Barre d'outils</a>
    <a href="#hotkeys">6. Raccourcis</a>
    <a href="#logs">7. Journaux · Trace · Comparer</a>
    <a href="#editor">8. Éditeur de requêtes</a>
    <a href="#rules">9. Règles &amp; interception</a>
    <a href="#cookies">10. Gestionnaire de cookies</a>
    <a href="#isolated">11. Onglets isolés</a>
    <a href="#dns">12. Remplacements DNS</a>
    <a href="#analyzer">13. Analyseur de page</a>
    <a href="#console">14. Console système</a>
    <a href="#newtab">15. Page nouvel onglet</a>
    <a href="#settings">16. Fenêtre Paramètres</a>
    <a href="#mitm">17. MITM · Fichier CA · Contournements</a>
    <a href="#issues">18. Problèmes fréquents</a>
</div>

<div id="gs" class="g-card">
    <h2>1) Démarrage rapide</h2>
    <ol>
        <li>Depuis le dossier du projet : <code>ELECTRON_RUN_AS_NODE= npm start</code> (les IDE peuvent définir <code>ELECTRON_RUN_AS_NODE=1</code> — à désactiver pour Electron).</li>
        <li>La fenêtre principale s'ouvre avec barre d'onglets et barre de navigation. La barre d'adresse accepte URL ou recherche.</li>
        <li>Vérifiez que <b>REC</b> est activé pour enregistrer les nouvelles requêtes ; le badge <b>Log #N</b> affiche session + compteur.</li>
        <li>Cliquez la <b>pastille proxy</b> (à gauche de l'adresse) pour ouvrir le gestionnaire — connectez un profil amont ou restez en MITM local seul.</li>
        <li>Nouvel onglet : <kbd>Ctrl T</kbd> ou <b>+</b>. Onglet isolé : <kbd>Ctrl ⇧T</kbd> ou <b>+🔒</b>.</li>
    </ol>
    <div class="g-tip">Naviguer sans proxy amont est normal. AzureTLS + MITM façonnent encore le HTTPS lorsque le mode MITM est actif.</div>
</div>

<div id="traffic" class="g-card">
    <h2>2) Chemin réseau &amp; enregistrement</h2>
    <p>Les onglets utilisent le proxy Chromium vers l'écoute MITM de CupNet (<b>127.0.0.1:8877</b>). Le HTTPS déchiffré transite par le <b>worker AzureTLS</b> : le serveur voit une empreinte TLS de navigateur réel (profil choisi par profil proxy / défauts).</p>
    <ul>
        <li><b>REC</b> — partie gauche de la pastille Log. Quand l'enregistrement est OFF, les nouvelles lignes (et fonctions liées, ex. captures auto) ne s'accumulent plus.</li>
        <li>Un clic sur REC peut proposer de poursuivre la session ou d'en créer une nouvelle.</li>
        <li>La <b>bannière mitm-init</b> sur la page nouvel onglet apparaît pendant le démarrage de la pile ; les pages peuvent être lentes quelques secondes.</li>
    </ul>
    <div class="g-tip success">Les règles de surbrillance s'exécutent après journalisation. Les règles d'interception agissent sur le chemin MITM en mode MITM (voir Règles).</div>
</div>

<div id="proxy" class="g-card">
    <h2>3) Gestionnaire de proxies</h2>
    <p>Ouverture via la pastille proxy ou <b>Gérer →</b> sur le widget. Protocoles : <code>http</code>, <code>https</code>, <code>socks4</code>, <code>socks5</code>.</p>
    <h3>Profils</h3>
    <ul>
        <li><b>+ Nouveau</b> / liste — nom, modèle d'URL proxy, notes.</li>
        <li>Identifiants via trousseau OS (<code>safeStorage</code>) — pas en clair dans SQLite.</li>
        <li><b>⚡ Tester</b> — résout le modèle, mesure la latence, affiche IP/géo/ASN.</li>
        <li><b>Appliquer globalement</b> — connexion pour tout le navigateur.</li>
        <li><b>Appliquer à l'onglet actif</b> — lie le formulaire courant (SID/RAND) uniquement à l'onglet focalisé.</li>
        <li><b>⧉ Copier</b> — dupliquer ; <b>✕ Supprimer</b> — retirer. <b>✕ Déconnecter</b> enlève l'amont.</li>
    </ul>
    <h3>Variables de modèle</h3>
    <div class="g-tip">
        <code>{RAND:min-max}</code> — entier aléatoire à chaque connexion<br>
        <code>{SID}</code> — jeton de session éphémère (auto <code>cupnet</code> + chiffres si vide)<br>
        <code>{NOM}</code> — valeur stockée dans le tableau des variables du profil
    </div>
    <details><summary>Exemple</summary>
        <pre>socks5://user-{SID}:{PASSWORD}@{COUNTRY}.fournisseur.com:{RAND:10000-19999}</pre>
    </details>
    <h3>Stats MITM (barre supérieure)</h3>
    <p>req/s, latence moyenne, requêtes en cours, totaux, erreurs et profil TLS actif — utile pour diagnostiquer lenteurs ou proxy défaillant.</p>
    <span class="g-status ok">✓ Après une connexion globale, l'onglet actif se recharge pour prendre la nouvelle chaîne.</span>
</div>

<div id="fingerprint" class="g-card">
    <h2>4) Empreinte &amp; TLS</h2>
    <p>Déplier <b>🎭 Fingerprint / Identity</b> dans un profil. S'applique à la connexion / application du profil.</p>
    <h3>Identité HTTP (CDP)</h3>
    <ul>
        <li><b>User-Agent</b> — préréglages (Chrome Win/Mac, Firefox, Safari, Mobile) pour en-têtes et <code>navigator.userAgent</code>.</li>
        <li><b>Fuseau horaire</b> — <code>Intl</code>, <code>Date</code>, etc.</li>
        <li><b>Langue</b> — <code>Accept-Language</code> + <code>navigator.language</code>.</li>
    </ul>
    <h3>Empreinte TLS (AzureTLS)</h3>
    <ul>
        <li>Mode <b>Template</b> — Chrome 133, Firefox 138, Safari 18, iOS 18, Edge 133, Opera 119.</li>
        <li>Mode <b>JA3 personnalisé</b> — collez une chaîne JA3 ; préremplissages pour copier un template.</li>
    </ul>
    <p><b>⚡ Traffic Optimization</b> du même profil peut bloquer images/CSS/polices/médias/WebSocket avec liste d'exemption captcha.</p>
    <div class="g-tip success">Déconnecter efface les overrides globaux. Les liaisons par onglet disparaissent à la fermeture de l'onglet.</div>
</div>

<div id="toolbar" class="g-card">
    <h2>5) Barre d'outils</h2>
    ${kbdRow('← → ↻ ⌂', 'Précédent / Suivant / Actualiser / Accueil (page de démarrage)')}
    ${kbdRow('Pastille proxy', 'Direct ou nom de profil + détail. Ouvre le gestionnaire. Badge de mode si MITM actif.')}
    ${kbdRow('Barre d\'adresse', 'URL ou recherche — Entrée')}
    <hr class="g-hr" style="margin:10px 0">
    ${kbdRow('<b>REC · Log #N</b>', "REC active/désactive l'écriture DB. Log ouvre le visualiseur ; badge = session + nombre.")}
    ${kbdRow('<b>DevTools</b>', "Outils pour l'onglet actif. Aussi <kbd>F12</kbd>.")}
    ${kbdRow('<b>Cookies</b>', 'Gestionnaire de cookies')}
    ${kbdRow('<b>DNS</b>', 'Remplacements DNS (badge = hits)')}
    ${kbdRow('<b>Req Editor</b>', 'Requête HTTP rejouable')}
    ${kbdRow('<b>Rules</b>', 'Règles &amp; interception (badge = hits)')}
    ${kbdRow('<b>Analyzer</b>', 'Analyseur — formulaires, captcha, endpoints')}
    ${kbdRow('<b>Console</b>', 'Console système stdout/stderr')}
    ${kbdRow('<b>Settings</b>', 'Fenêtre Paramètres (Général / Tracking / Périphériques / Performance)')}
</div>

<div id="hotkeys" class="g-card">
    <h2>6) Raccourcis</h2>
    <p>Sur macOS, <kbd>⌘</kbd> remplace <kbd>Ctrl</kbd>. Le menu application reprend les mêmes actions.</p>
    <h3>Onglets &amp; navigation</h3>
    ${kbdRow('<kbd>Ctrl T</kbd>', 'Nouvel onglet')}
    ${kbdRow('<kbd>Ctrl ⇧T</kbd>', 'Onglet isolé')}
    ${kbdRow('<kbd>Ctrl W</kbd>', 'Fermer')}
    ${kbdRow('<kbd>Ctrl Tab</kbd> / <kbd>Ctrl ⇧Tab</kbd>', 'Onglet suivant / précédent')}
    ${kbdRow('<kbd>Ctrl 1-9</kbd>', 'Focus onglet (9 = dernier)')}
    ${kbdRow('<kbd>Ctrl L</kbd>', 'Focus adresse')}
    ${kbdRow('<kbd>Ctrl R</kbd> / <kbd>F5</kbd>', 'Actualiser')}
    ${kbdRow('<kbd>Ctrl ⇧R</kbd>', 'Vidage cache')}
    ${kbdRow('<kbd>Alt ←</kbd> / <kbd>Alt →</kbd>', 'Retour / avant')}
    <h3>Outils</h3>
    ${kbdRow('<kbd>Ctrl P</kbd>', 'Gestionnaire de proxies')}
    ${kbdRow('<kbd>Ctrl ⇧L</kbd>', 'Journaux réseau')}
    ${kbdRow('<kbd>Ctrl Alt C</kbd>', 'Cookies (mac : ⌘⌥C)')}
    ${kbdRow('<kbd>Ctrl ⇧M</kbd>', 'DNS (menu application)')}
    ${kbdRow('<kbd>Ctrl ⇧A</kbd>', 'Analyseur de page')}
    ${kbdRow('<kbd>Ctrl ⇧K</kbd>', 'Console système')}
    ${kbdRow('<kbd>F2</kbd>', "Capture d'écran")}
    ${kbdRow('<kbd>F12</kbd>', 'DevTools — onglet actif')}
    ${kbdRow('<kbd>Ctrl ⇧I</kbd>', 'DevTools — coque du navigateur')}
</div>

<div id="logs" class="g-card">
    <h2>7) Journaux · Trace · Comparer</h2>
    <p>HTTP(S)/WebSocket partent dans SQLite : URL, méthode, en-têtes, corps (binaire pris en charge), durées, captures en lignes spéciales.</p>
    <ul>
        <li><b>Filtres</b> — méthode, statut, type MIME, onglet, session.</li>
        <li><b>FTS</b> — recherche plein texte URL + corps réponse.</li>
        <li><b>Export HAR</b> — HAR 1.2 (Charles, DevTools…).</li>
        <li><b>Replay</b> — envoyer la sélection vers l’éditeur.</li>
        <li><b>Trace</b> — instantanés complets req/rép ; ⌘/Ctrl-clic ouvre la fenêtre Trace.</li>
        <li><b>Comparer</b> — slots gauche/droit puis fenêtre de diff.</li>
        <li><b>Sessions</b> — renommer, basculer, supprimer.</li>
    </ul>
    <h3>Captures automatiques</h3>
    <p>Intervalle et déclencheurs intelligents : <b>Paramètres → Général / Tracking</b>. Images identiques consécutives ignorées. La page nouvel onglet est exclue des logs et captures.</p>
</div>

<div id="editor" class="g-card">
    <h2>8) Éditeur de requêtes</h2>
    <p>Outil type Postman via <code>net.fetch</code> d’Electron — moins de restrictions qu’un <code>fetch</code> du renderer.</p>
    <ul>
        <li>Méthode, URL, tableau query, en-têtes, corps (None / Raw / JSON / formulaire).</li>
        <li>Surcharge TLS optionnelle par requête.</li>
        <li>Panneau réponse : statut, en-têtes, JSON formaté, timing.</li>
        <li><b>Copier en cURL</b>.</li>
    </ul>
    <div class="g-tip">Les en-têtes restreints par Chromium peuvent être réécrits ou ignorés.</div>
</div>

<div id="rules" class="g-card">
    <h2>9) Règles &amp; interception</h2>
    <p>Ouvrir via <b>Rules</b>. Deux familles :</p>
    <h3>Règles de mise en évidence</h3>
    <p>Après réponse journalisée : URL, méthode, statut, MIME, durée, hôte, corps, erreurs — opérateurs <code>contains</code>, <code>equals</code>, regex, comparaisons numériques… Actions : <b>highlight</b>, <b>screenshot</b>, <b>notification</b>, <b>block</b> (marquer la ligne).</p>
    <h3>Règles d’interception</h3>
    <p>Avant le réseau : motifs wildcard. Actions : <b>block</b>, modifier en-têtes (requête/réponse), <b>mock</b>.</p>
    <div class="g-tip">Avec le <b>mode MITM</b>, l’interception est gérée dans le pipeline MITM (pas via <code>protocol.handle</code>), ce qui préserve un chemin TLS crédible pour les sites stricts (Cloudflare / Turnstile).</div>
</div>

<div id="cookies" class="g-card">
    <h2>10) Gestionnaire de cookies</h2>
    <ul>
        <li>Sélecteur de session par onglet, recherche live, édition inline, import/export JSON ou Netscape <code>cookies.txt</code>.</li>
        <li>Filtre <b>onglet actuel</b> verrouille sur le domaine de navigation actif.</li>
        <li><b>Partager vers onglet</b> copie entre sessions isolées/partagées avec filtre domaine optionnel.</li>
    </ul>
</div>

<div id="isolated" class="g-card">
    <h2>11) Onglets isolés</h2>
    <p><b>+🔒</b> crée une partition Chromium dédiée — cookies, cache, stockage séparés. Fermer l’onglet détruit les données. Export possible depuis le gestionnaire avant fermeture.</p>
    <div class="g-tip success">Idéal pour plusieurs comptes ou inscriptions « propres ».</div>
</div>

<div id="dns" class="g-card">
    <h2>12) Remplacements DNS</h2>
    <p>Le bouton <b>DNS</b> ouvre le gestionnaire hôte → IP utilisé par CupNet. Les motifs wildcard HTTPS peuvent exiger des fonctions MITM CORS — l’interface avertit si besoin.</p>
</div>

<div id="analyzer" class="g-card">
    <h2>13) Analyseur de page</h2>
    <p>Fenêtre dédiée : formulaires, widgets captcha détectés, endpoints collectés, actions d’aide. Gardez-la ouverte pendant la navigation ; relancez les analyses au besoin.</p>
</div>

<div id="console" class="g-card">
    <h2>14) Console système</h2>
    <p>Flux des journaux du processus principal. Utilisez les actions d’enregistrement pour exporter l’historique lors d’un debug.</p>
</div>

<div id="newtab" class="g-card">
    <h2>15) Page nouvel onglet</h2>
    <ul>
        <li><b>Recherche</b> — DDG / Google / Yandex / Bing (mémorisé localement).</li>
        <li><b>Liens rapides</b> — URL ou raccourci profil proxy. <b>📖 Guide</b> ouvre ce manuel dans l’onglet actif.</li>
        <li><b>Carte proxy / IP</b> — pastille d’état, badge MITM, amont, IP publique + géo, pilule de portée (Global vs nom du profil).</li>
        <li><b>Bande cookies</b> — Partagé / Isolé, compteur, Ouvrir (gestionnaire), Effacer tout.</li>
        <li><b>Proxy externe</b> — écoute HTTP (port au choix) pour curl, scripts ou LAN, même profil TLS + logs. Actif si le mode MITM l’autorise.</li>
    </ul>
</div>

<div id="settings" class="g-card">
    <h2>16) Fenêtre Paramètres</h2>
    <p><b>Settings</b> ouvre une fenêtre dédiée (pas un panneau sous la barre d’adresse).</p>
    <h3>Général</h3>
    <ul>
        <li><b>Débloquer copier-coller</b> — empêche les sites de bloquer les raccourcis presse-papiers.</li>
        <li><b>Domaines de contournement MITM</b> — un motif par ligne ; hôtes assortis évitent le MITM (défis intégrés).</li>
        <li><b>Filtres d’URL</b> — glob par ligne ; URL correspondantes exclues des logs (<b>Enregistrer</b>).</li>
    </ul>
    <h3>Tracking</h3>
    <p>Événements pour captures auto : clics, chargement terminé, seuils de requêtes en attente, activité souris, pause frappe, fin de scroll, règles… Ajustez les seuils si c’est trop bavard.</p>
    <h3>Périphériques</h3>
    <p>Listes autorisées et ordre de priorité caméra / micro pour getUserMedia.</p>
    <h3>Performance</h3>
    <p>Table des processus Electron/Chromium (CPU, mémoire, sandbox) rafraîchie en continu.</p>
</div>

<div id="mitm" class="g-card">
    <h2>17) MITM · Fichier CA · Contournements</h2>
    <p>Le proxy MITM termine le TLS avec un CA généré par CupNet, journalise le texte clair si activé, puis rechiffre amont via AzureTLS.</p>
    <h3>Confiance dans l’app</h3>
    <p>Les BrowserViews internes font confiance au CA automatiquement — import manuel rarement nécessaire pour les onglets CupNet.</p>
    <h3>PEM sur disque (outils externes)</h3>
    <p>Certificat public écrit dans le dossier user-data :</p>
    <ul>
        <li><b>macOS :</b> <code>~/Library/Application Support/CupNet/mitm-ca/ca-cert.pem</code></li>
        <li><b>Windows :</b> <code>%APPDATA%\\CupNet\\mitm-ca\\ca-cert.pem</code></li>
        <li><b>Linux :</b> <code>~/.config/CupNet/mitm-ca/ca-cert.pem</code></li>
    </ul>
    <p>Importez ce PEM dans un autre navigateur ou magasin de confiance seulement si vous le voulez explicitement. Préférez le <b>proxy externe</b> pour enchaîner des clients CLI via CupNet.</p>
    <h3>Liste de contournement</h3>
    <p><b>Paramètres → Général → MITM bypass domains</b>. Combinez avec interception / DNS pour des setups avancés.</p>
    <span class="g-status warn">⚠ N’importez des CA que sur des machines que vous contrôlez.</span>
</div>

<div id="issues" class="g-card">
    <h2>18) Problèmes fréquents</h2>
    <ul>
        <li><b>L’app ne démarre pas depuis l’IDE</b> — <code>ELECTRON_RUN_AS_NODE= npm start</code> dans un shell propre.</li>
        <li><b>Module natif</b> — <code>npm run rebuild:arm64</code> ou <code>npx electron-rebuild</code>.</li>
        <li><b>Erreurs proxy amont</b> — format d’URL, bouton <b>Tester</b>, compteur d’erreurs MITM.</li>
        <li><b>Sites stricts / boucles captcha</b> — domaines de défi dans la liste bypass ; évitez les chemins <code>protocol.handle</code> concurrents au MITM.</li>
        <li><b>Proxy externe grisé</b> — nécessite le mode trafic MITM ; le widget affiche l’erreur exacte.</li>
    </ul>
    <details><summary>Bootstrap développeur</summary>
        <pre>cd node/cupnet2
npm install --ignore-scripts
npm run rebuild:arm64
ELECTRON_RUN_AS_NODE= npm start</pre>
    </details>
</div>

<div class="g-footer">© CupNet 2.0 — Tous droits réservés.</div>
`;
}
