/** Guía ES — misma estructura y anclas que EN */
export default function es(kbdRow) {
    return `
<div class="g-hero">
    <img src="img.png" class="g-hero-logo" alt="CupNet">
    <div>
        <h1 class="g-hero-title">CupNet — Guía de uso</h1>
        <div class="g-hero-sub">Navegador proxy para desarrollo · MITM integrado · huellas AzureTLS · registros SQLite</div>
        <div style="margin-top:6px">
            <span class="g-pill">v2.0</span><span class="g-pill">SQLite</span>
            <span class="g-pill">CDP</span><span class="g-pill">AzureTLS</span>
        </div>
    </div>
</div>

<div id="brief" class="g-card g-brief">
    <h2>En resumen</h2>
    <ul>
        <li><b>Qué es:</b> navegador Electron donde el tráfico pasa por la pila CupNet: proxy ascendente opcional, MITM HTTPS en el puerto <b>8877</b>, TLS saliente mediante el worker <b>AzureTLS</b> (perfil JA3 / HTTP2).</li>
        <li><b>Registros:</b> peticiones en <b>SQLite</b> (CDP + ruta MITM). <b>REC</b> en la barra pausa/reanuda el registro; <b>Log</b> abre el visor (FTS, HAR, replay, traza, comparar).</li>
        <li><b>Gestor de proxies:</b> perfiles cifrados (llavero del SO), <b>Aplicar globalmente</b> o <b>Aplicar a la pestaña activa</b>, estadísticas MITM en vivo en la barra superior.</li>
        <li><b>Barra de herramientas:</b> DNS, editor de peticiones, reglas e interceptación, analizador de página, consola del sistema, ajustes (ventana aparte).</li>
        <li><b>Página nueva pestaña:</b> búsqueda, accesos rápidos, tarjeta proxy/IP (insignia MITM, ámbito por pestaña), interruptor de cookies <b>Compartido / Aislado</b>, <b>proxy externo</b> para curl/scripts.</li>
        <li><b>Confianza:</b> las sesiones Chromium integradas confían automáticamente en el CA MITM. Para otras herramientas use el PEM en disco (véase <a href="#mitm">MITM y CA</a>) o enrute por el proxy externo.</li>
    </ul>
</div>

<div class="g-card g-toc">
    <h2>Contenido</h2>
    <a href="#brief">0. En resumen</a>
    <a href="#gs">1. Inicio rápido</a>
    <a href="#traffic">2. Ruta de tráfico y grabación</a>
    <a href="#proxy">3. Gestor de proxies</a>
    <a href="#fingerprint">4. Huella digital y TLS</a>
    <a href="#toolbar">5. Barra de herramientas</a>
    <a href="#hotkeys">6. Atajos</a>
    <a href="#logs">7. Registros · Traza · Comparar</a>
    <a href="#editor">8. Editor de peticiones</a>
    <a href="#rules">9. Reglas e interceptación</a>
    <a href="#cookies">10. Gestor de cookies</a>
    <a href="#isolated">11. Pestañas aisladas</a>
    <a href="#dns">12. Anulaciones DNS</a>
    <a href="#analyzer">13. Analizador de página</a>
    <a href="#console">14. Consola del sistema</a>
    <a href="#newtab">15. Página nueva pestaña</a>
    <a href="#settings">16. Ventana Ajustes</a>
    <a href="#mitm">17. MITM · Archivo CA · Omisiones</a>
    <a href="#issues">18. Problemas comunes</a>
</div>

<div id="gs" class="g-card">
    <h2>1) Inicio rápido</h2>
    <ol>
        <li>Desde la carpeta del proyecto: <code>ELECTRON_RUN_AS_NODE= npm start</code> (los IDE pueden fijar <code>ELECTRON_RUN_AS_NODE=1</code> — desactívelo para Electron).</li>
        <li>Se abre la ventana principal con barra de pestañas y navegación. La barra de direcciones acepta URL o búsqueda.</li>
        <li>Confirme que <b>REC</b> está activo para nuevas filas en la base; la insignia <b>Log #N</b> muestra sesión y recuento.</li>
        <li>Pulse la <b>pastilla de proxy</b> (izquierda de la dirección) para abrir el gestor — conecte un perfil o quede solo en MITM local.</li>
        <li>Nueva pestaña: <kbd>Ctrl T</kbd> o <b>+</b>. Aislada: <kbd>Ctrl ⇧T</kbd> o <b>+🔒</b>.</li>
    </ol>
    <div class="g-tip">Navegar sin proxy ascendente es normal. AzureTLS + MITM siguen moldeando HTTPS con MITM activo.</div>
</div>

<div id="traffic" class="g-card">
    <h2>2) Ruta de tráfico y grabación</h2>
    <p>Las pestañas usan el proxy de Chromium hacia el MITM de CupNet (<b>127.0.0.1:8877</b>). El HTTPS descifrado pasa por el <b>worker AzureTLS</b>; el servidor ve huella TLS de navegador real (perfil del perfil proxy o predeterminados).</p>
    <ul>
        <li><b>REC</b> — parte izquierda de la pastilla Log. Si la grabación está OFF, no se acumulan filas nuevas (ni capturas dependientes).</li>
        <li>Al pulsar REC puede ofrecer seguir la sesión o crear una nueva.</li>
        <li>El <b>banner mitm-init</b> en la página de nueva pestaña aparece mientras arranca la pila; la carga puede ir lenta unos segundos.</li>
    </ul>
    <div class="g-tip success">Las reglas de resaltado corren tras registrar. Las reglas de interceptación se evalúan en el pipeline MITM en modo MITM (véase Reglas).</div>
</div>

<div id="proxy" class="g-card">
    <h2>3) Gestor de proxies</h2>
    <p>Ábralo desde la pastilla o <b>Gestionar →</b> en el widget. Protocolos: <code>http</code>, <code>https</code>, <code>socks4</code>, <code>socks5</code>.</p>
    <h3>Perfiles</h3>
    <ul>
        <li><b>+ Nuevo</b> / lista — nombre, plantilla URL, notas.</li>
        <li>Credenciales en el llavero del SO (<code>safeStorage</code>) — no en texto claro en SQLite.</li>
        <li><b>⚡ Probar</b> — resuelve plantilla, mide latencia, muestra IP/geo/ASN.</li>
        <li><b>Aplicar globalmente</b> — conexión para todo el navegador.</li>
        <li><b>Aplicar a la pestaña activa</b> — vincula el formulario actual (SID/RAND) solo a la pestaña enfocada.</li>
        <li><b>⧉ Copiar</b> — duplicar; <b>✕ Eliminar</b> — borrar. <b>✕ Desconectar</b> quita el ascendente.</li>
    </ul>
    <h3>Variables de plantilla</h3>
    <div class="g-tip">
        <code>{RAND:min-max}</code> — entero aleatorio en cada conexión<br>
        <code>{SID}</code> — token efímero (auto <code>cupnet</code> + dígitos si está vacío)<br>
        <code>{VAR}</code> — valor guardado en la tabla de variables del perfil
    </div>
    <details><summary>Ejemplo</summary>
        <pre>socks5://user-{SID}:{PASSWORD}@{COUNTRY}.proveedor.com:{RAND:10000-19999}</pre>
    </details>
    <h3>Estadísticas MITM (barra superior)</h3>
    <p>req/s, latencia media, pendientes, totales, errores y perfil TLS activo — útil para diagnosticar lentitud o proxy roto.</p>
    <span class="g-status ok">✓ Tras conectar en global, la pestaña activa se recarga para adoptar la cadena nueva.</span>
</div>

<div id="fingerprint" class="g-card">
    <h2>4) Huella digital y TLS</h2>
    <p>Despliegue <b>🎭 Fingerprint / Identity</b> dentro de un perfil. Se aplica al conectar / aplicar ese perfil.</p>
    <h3>Identidad HTTP (CDP)</h3>
    <ul>
        <li><b>User-Agent</b> — ajustes predefinidos afectan cabeceras y <code>navigator.userAgent</code>.</li>
        <li><b>Zona horaria</b> — <code>Intl</code>, <code>Date</code>, etc.</li>
        <li><b>Idioma</b> — <code>Accept-Language</code> + <code>navigator.language</code>.</li>
    </ul>
    <h3>Huella TLS (AzureTLS)</h3>
    <ul>
        <li>Modo <b>Plantilla</b> — Chrome 133, Firefox 138, Safari 18, iOS 18, Edge 133, Opera 119.</li>
        <li>Modo <b>JA3 personalizado</b> — pegue la cadena; rellenos rápidos desde plantillas.</li>
    </ul>
    <p><b>⚡ Traffic Optimization</b> del mismo perfil puede bloquear imágenes/CSS/fuentes/medios/WebSocket con lista blanca de captcha.</p>
    <div class="g-tip success">Desconectar limpia overrides globales. Los enlaces por pestaña mueren al cerrar la pestaña.</div>
</div>

<div id="toolbar" class="g-card">
    <h2>5) Barra de herramientas</h2>
    ${kbdRow('← → ↻ ⌂', 'Atrás / Adelante / Recargar / Inicio (página de arranque)')}
    ${kbdRow('Pastilla proxy', 'Direct o nombre de perfil + detalle. Abre el gestor. Insignia de modo con MITM activo.')}
    ${kbdRow('Barra de dirección', 'URL o búsqueda — Enter')}
    <hr class="g-hr" style="margin:10px 0">
    ${kbdRow('<b>REC · Log #N</b>', 'REC alterna escritura en DB. Log abre el visor; insignia = sesión + recuento.')}
    ${kbdRow('<b>DevTools</b>', 'Herramientas para la pestaña activa. También <kbd>F12</kbd>.')}
    ${kbdRow('<b>Cookies</b>', 'Gestor de cookies')}
    ${kbdRow('<b>DNS</b>', 'Anulaciones DNS (insignia = hits)')}
    ${kbdRow('<b>Req Editor</b>', 'Petición HTTP rejugable')}
    ${kbdRow('<b>Rules</b>', 'Reglas e interceptación (insignia = hits)')}
    ${kbdRow('<b>Analyzer</b>', 'Analizador — formularios, captcha, endpoints')}
    ${kbdRow('<b>Console</b>', 'Consola del sistema stdout/stderr')}
    ${kbdRow('<b>Settings</b>', 'Ventana Ajustes (General / Tracking / Dispositivos / Rendimiento)')}
</div>

<div id="hotkeys" class="g-card">
    <h2>6) Atajos</h2>
    <p>En macOS use <kbd>⌘</kbd> en lugar de <kbd>Ctrl</kbd>. El menú de la aplicación lista los mismos aceleradores.</p>
    <h3>Pestañas y navegación</h3>
    ${kbdRow('<kbd>Ctrl T</kbd>', 'Nueva pestaña')}
    ${kbdRow('<kbd>Ctrl ⇧T</kbd>', 'Pestaña aislada')}
    ${kbdRow('<kbd>Ctrl W</kbd>', 'Cerrar')}
    ${kbdRow('<kbd>Ctrl Tab</kbd> / <kbd>Ctrl ⇧Tab</kbd>', 'Siguiente / anterior')}
    ${kbdRow('<kbd>Ctrl 1-9</kbd>', 'Enfocar pestaña (9 = última)')}
    ${kbdRow('<kbd>Ctrl L</kbd>', 'Foco en dirección')}
    ${kbdRow('<kbd>Ctrl R</kbd> / <kbd>F5</kbd>', 'Recargar')}
    ${kbdRow('<kbd>Ctrl ⇧R</kbd>', 'Recarga dura (sin caché)')}
    ${kbdRow('<kbd>Alt ←</kbd> / <kbd>Alt →</kbd>', 'Atrás / adelante')}
    <h3>Herramientas</h3>
    ${kbdRow('<kbd>Ctrl P</kbd>', 'Gestor de proxies')}
    ${kbdRow('<kbd>Ctrl ⇧L</kbd>', 'Registro de red')}
    ${kbdRow('<kbd>Ctrl Alt C</kbd>', 'Cookies (mac: ⌘⌥C)')}
    ${kbdRow('<kbd>Ctrl ⇧M</kbd>', 'DNS (menú aplicación)')}
    ${kbdRow('<kbd>Ctrl ⇧A</kbd>', 'Analizador de página')}
    ${kbdRow('<kbd>Ctrl ⇧K</kbd>', 'Consola del sistema')}
    ${kbdRow('<kbd>F2</kbd>', 'Captura de pantalla')}
    ${kbdRow('<kbd>F12</kbd>', 'DevTools — pestaña activa')}
    ${kbdRow('<kbd>Ctrl ⇧I</kbd>', 'DevTools — shell del navegador')}
</div>

<div id="logs" class="g-card">
    <h2>7) Registros · Traza · Comparar</h2>
    <p>HTTP(S)/WebSocket a SQLite: URL, método, cabeceras, cuerpos (binario admitido), tiempos, capturas como filas especiales.</p>
    <ul>
        <li><b>Filtros</b> — método, estado, MIME, pestaña, sesión.</li>
        <li><b>FTS</b> — búsqueda de texto completo en URL + cuerpo de respuesta.</li>
        <li><b>Exportar HAR</b> — HAR 1.2 (Charles, DevTools…).</li>
        <li><b>Replay</b> — enviar selección al editor.</li>
        <li><b>Traza</b> — instantáneas req/resp completas; ⌘/Ctrl-clic abre la ventana Trace.</li>
        <li><b>Comparar</b> — ranuras izquierda/derecha y ventana diff.</li>
        <li><b>Sesiones</b> — renombrar, cambiar, borrar.</li>
    </ul>
    <h3>Capturas automáticas</h3>
    <p>Intervalo y disparadores en <b>Ajustes → General / Tracking</b>. Fotogramas idénticos consecutivos omitidos. La página nueva pestaña queda fuera de registros y capturas.</p>
</div>

<div id="editor" class="g-card">
    <h2>8) Editor de peticiones</h2>
    <p>Estilo Postman con <code>net.fetch</code> de Electron — menos límites que <code>fetch</code> del renderer.</p>
    <ul>
        <li>Método, URL, tabla query, cabeceras, cuerpo (None / Raw / JSON / formulario).</li>
        <li>Override TLS opcional por petición.</li>
        <li>Panel respuesta: estado, cabeceras, JSON formateado, tiempos.</li>
        <li><b>Copiar como cURL</b>.</li>
    </ul>
    <div class="g-tip">Las cabeceras restringidas por Chromium pueden reescribirse u omitirse.</div>
</div>

<div id="rules" class="g-card">
    <h2>9) Reglas e interceptación</h2>
    <p>Abrir con <b>Rules</b>. Dos familias:</p>
    <h3>Reglas de resaltado</h3>
    <p>Tras registrar la respuesta: URL, método, estado, MIME, duración, host, cuerpos, errores — operadores <code>contains</code>, <code>equals</code>, regex, comparaciones numéricas… Acciones: <b>highlight</b>, <b>screenshot</b>, <b>notification</b>, <b>block</b> (marcar fila).</p>
    <h3>Reglas de interceptación</h3>
    <p>Antes de red: patrones comodín. Acciones: <b>block</b>, modificar cabeceras (petición/respuesta), <b>mock</b>.</p>
    <div class="g-tip">Con el <b>modo MITM</b>, la interceptación ocurre en el pipeline MITM (no mediante <code>protocol.handle</code>), manteniendo TLS creíble en sitios estrictos (Cloudflare / Turnstile).</div>
</div>

<div id="cookies" class="g-card">
    <h2>10) Gestor de cookies</h2>
    <ul>
        <li>Selector de sesión por pestaña, búsqueda en vivo, edición inline, importar/exportar JSON o Netscape <code>cookies.txt</code>.</li>
        <li>Filtro <b>pestaña actual</b> bloquea al dominio de navegación activo.</li>
        <li><b>Compartir a pestaña</b> copia entre sesiones con filtro de dominio opcional.</li>
    </ul>
</div>

<div id="isolated" class="g-card">
    <h2>11) Pestañas aisladas</h2>
    <p><b>+🔒</b> crea una partición Chromium propia — cookies, caché y almacenamiento separados. Al cerrar se borra todo. Exporte desde el gestor antes si lo necesita.</p>
    <div class="g-tip success">Ideal para varias cuentas o registros limpios.</div>
</div>

<div id="dns" class="g-card">
    <h2>12) Anulaciones DNS</h2>
    <p>El botón <b>DNS</b> abre el gestor host → IP usado dentro de CupNet. Los comodines HTTPS pueden requerir funciones MITM CORS; la UI avisa cuando aplica.</p>
</div>

<div id="analyzer" class="g-card">
    <h2>13) Analizador de página</h2>
    <p>Ventana aparte: formularios, widgets captcha detectados, endpoints recolectados, acciones auxiliares. Manténgala abierta al navegar; vuelva a ejecutar análisis cuando haga falta.</p>
</div>

<div id="console" class="g-card">
    <h2>14) Consola del sistema</h2>
    <p>Flujo de registros del proceso principal. Use guardar/exportar integrado para depuración.</p>
</div>

<div id="newtab" class="g-card">
    <h2>15) Página nueva pestaña</h2>
    <ul>
        <li><b>Búsqueda</b> — DDG / Google / Yandex / Bing (persistente local).</li>
        <li><b>Accesos rápidos</b> — URL o acceso directo a perfil proxy. <b>📖 Guide</b> abre este manual en la pestaña actual.</li>
        <li><b>Tarjeta proxy / IP</b> — punto de estado, insignia MITM, ascendente, IP pública + geo, píldora de ámbito (Global vs nombre de perfil).</li>
        <li><b>Franja de cookies</b> — Compartido / Aislado, contador, Abrir (gestor), Borrar todo.</li>
        <li><b>Proxy externo</b> — escucha HTTP (elija puerto) para curl, scripts o LAN; mismo TLS + registros cuando MITM lo permite.</li>
    </ul>
</div>

<div id="settings" class="g-card">
    <h2>16) Ventana Ajustes</h2>
    <p><b>Settings</b> abre ventana propia (no panel bajo la barra).</p>
    <h3>General</h3>
    <ul>
        <li><b>Desbloquear copiar/pegar</b> — evita que sitios bloqueen atajos de portapapeles.</li>
        <li><b>Dominios de omisión MITM</b> — un patrón por línea; coincidencias saltan MITM (retos incrustados).</li>
        <li><b>Filtros URL</b> — glob por línea; URL coincidentes fuera del registro (<b>Guardar</b>).</li>
    </ul>
    <h3>Tracking</h3>
    <p>Eventos para capturas automáticas: clics, carga completa, umbrales de red pendiente, ratón, pausa de teclado, scroll, reglas… Ajuste límites si hay ruido.</p>
    <h3>Dispositivos</h3>
    <p>Permisos y prioridad de cámara / micrófono para getUserMedia.</p>
    <h3>Rendimiento</h3>
    <p>Tabla de procesos Electron/Chromium (CPU, memoria, sandbox) en vivo.</p>
</div>

<div id="mitm" class="g-card">
    <h2>17) MITM · Archivo CA · Omisiones</h2>
    <p>El MITM termina TLS con un CA generado por CupNet, registra texto plano si corresponde y vuelve a cifrar hacia el ascendente con AzureTLS.</p>
    <h3>Confianza dentro de la app</h3>
    <p>Las BrowserViews confían en el CA automáticamente — rara vez necesita importar para pestañas internas.</p>
    <h3>PEM en disco (herramientas externas)</h3>
    <ul>
        <li><b>macOS:</b> <code>~/Library/Application Support/CupNet/mitm-ca/ca-cert.pem</code></li>
        <li><b>Windows:</b> <code>%APPDATA%\\CupNet\\mitm-ca\\ca-cert.pem</code></li>
        <li><b>Linux:</b> <code>~/.config/CupNet/mitm-ca/ca-cert.pem</code></li>
    </ul>
    <p>Importe el PEM solo si desea que otro navegador o SO confíe explícitamente. Prefiera el <b>proxy externo</b> para encadenar clientes CLI.</p>
    <h3>Lista de omisión</h3>
    <p><b>Ajustes → General → MITM bypass domains</b>. Combine con interceptación o DNS avanzados.</p>
    <span class="g-status warn">⚠ Instale CA solo en equipos que controle.</span>
</div>

<div id="issues" class="g-card">
    <h2>18) Problemas comunes</h2>
    <ul>
        <li><b>No arranca desde IDE</b> — <code>ELECTRON_RUN_AS_NODE= npm start</code> en shell limpio.</li>
        <li><b>Módulo nativo</b> — <code>npm run rebuild:arm64</code> o <code>npx electron-rebuild</code>.</li>
        <li><b>Fallos proxy ascendente</b> — formato URL, botón <b>Probar</b>, contador de errores MITM.</li>
        <li><b>Sitios estrictos / bucles captcha</b> — dominios de reto en omisión; evite rutas <code>protocol.handle</code> que compitan con MITM.</li>
        <li><b>Proxy externo deshabilitado</b> — requiere modo de tráfico MITM; el widget muestra el error.</li>
    </ul>
    <details><summary>Bootstrap desarrollador</summary>
        <pre>cd node/cupnet2
npm install --ignore-scripts
npm run rebuild:arm64
ELECTRON_RUN_AS_NODE= npm start</pre>
    </details>
</div>

<div class="g-footer">© CupNet 2.0 — Todos los derechos reservados.</div>
`;
}
