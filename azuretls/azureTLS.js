#!/usr/bin/env node

/**
 * AzureTLS Node.js Example using ffi-napi
 *
 * This example demonstrates how to use the AzureTLS CFFI library from Node.js.
 *
 * Installation:
 * npm install ffi-napi ref-napi ref-struct-napi
 */

// const ffi = require('ffi-napi');
// const ref = require('ref-napi');
const ffi = require('@2060.io/ffi-napi');
const ref = require('@2060.io/ref-napi');
const StructType = require('ref-struct-di')(ref);
const path = require('path');
const os = require('os');
const fs = require('fs');
const FormData = require('form-data');
const ProxyChain = require('proxy-chain');
const { networkPolicy, retryableStatus, computeBackoffMs } = require('../network-policy');

// Define the C structures as JavaScript objects using ref-struct
const CFfiResponse = StructType({
    status_code: 'int',
    body: 'char*',
    body_len: 'int',
    headers: 'char*',
    url: 'char*',
    error: 'char*'
});

const CFfiRequest = StructType({
    method: 'char*',
    url: 'char*',
    body: 'char*',
    headers: 'char*',
    proxy: 'char*',
    timeout_ms: 'int',
    force_http1: 'int',
    force_http3: 'int',
    ignore_body: 'int',
    no_cookie: 'int',
    disable_redirects: 'int',
    max_redirects: 'int',
    insecure_skip_verify: 'int'
});


function getLibraryPath() {
    const platform = os.platform(); // 'linux', 'win32', 'darwin'
    const arch = os.arch(); // 'x64', 'arm64'

    let libArch;
    if (arch === 'x64') {
        libArch = 'amd64';
    } else if (arch === 'arm64') {
        libArch = 'arm64';
    } else {
        throw new Error(`Unsupported architecture: ${arch}`);
    }

    let ext;
    if (platform === 'win32') {
        ext = 'dll';
    } else if (platform === 'darwin') {
        ext = 'dylib';
    } else if (platform === 'linux') {
        ext = 'so';
    } else {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    const libName = `libazuretls_${platform}_${libArch}.${ext}`;

    let libDir = path.join(__dirname, 'lib');
    const asarInfix = `${path.sep}app.asar${path.sep}`;
    const idx = libDir.indexOf(asarInfix);
    if (idx !== -1) {
        libDir = libDir.slice(0, idx) + `${path.sep}app.asar.unpacked${path.sep}` + libDir.slice(idx + asarInfix.length);
    }
    return path.join(libDir, libName);
}


// Load the shared library
const azureTLS = ffi.Library(getLibraryPath(), {
    // Library initialization
    'azuretls_init': ['void', []],
    'azuretls_cleanup': ['void', []],

    // Session management
    'azuretls_session_new': ['uint64', ['char*']],
    'azuretls_session_close': ['void', ['uint64']],

    // HTTP requests
    'azuretls_session_do': [ref.refType(CFfiResponse), ['uint64', 'char*']],

    // TLS/HTTP fingerprinting
    'azuretls_session_apply_ja3': ['char*', ['uint64', 'char*', 'char*']],
    'azuretls_session_apply_http2': ['char*', ['uint64', 'char*']],
    'azuretls_session_apply_http3': ['char*', ['uint64', 'char*']],

    // Proxy management
    'azuretls_session_set_proxy': ['char*', ['uint64', 'char*']],
    'azuretls_session_clear_proxy': ['void', ['uint64']],

    // SSL pinning
    'azuretls_session_add_pins': ['char*', ['uint64', 'char*', 'char*']],
    'azuretls_session_clear_pins': ['char*', ['uint64', 'char*']],

    // Utility functions
    'azuretls_session_get_ip': ['char*', ['uint64']],
    'azuretls_version': ['char*', []],

    // Memory management
    'azuretls_free_string': ['void', ['char*']],
    'azuretls_free_response': ['void', [ref.refType(CFfiResponse)]]
});

class AzureTLSClient {
    constructor(config = {}) {
        // =======================================================================
        // ===          КАК ПОЛЬЗОВАТЬСЯ СИСТЕМОЙ КОЛБЭКОВ (ПРИМЕРЫ)          ===
        // =======================================================================
        //
        // Колбэки - это функции, которые вы "регистрируете" в клиенте.
        // Они автоматически вызываются после каждого ответа, позволяя вам
        // анализировать ответ и выполнять какие-либо действия, например,
        // повторять запрос.
        //
        // Структура колбэка:
        // async (response, requestOptions, client) => { ... }
        //
        // - response: Объект с результатом запроса { statusCode, body, headers, error }.
        // - requestOptions: Оригинальные опции, с которыми был вызван запрос.
        // - client: Экземпляр самого клиента, чтобы можно было вызывать его методы (например, client.setProxy()).
        //
        // ВОЗВРАЩАЕМОЕ ЗНАЧЕНИЕ:
        // - `true`: Сигнал клиенту, что нужно ПОВТОРИТЬ этот же запрос.
        // - `false` или `undefined`: Ничего не делать, продолжить как обычно.
        this.responseCallbacks = new Map();
        
        // Флаг для детального логирования (можно включить через переменную окружения или config)
        this.debugMode = config.debug || process.env.DEBUG_AZURE_TLS === 'true' || process.argv.includes('--debugAzureTls');

        azureTLS.azuretls_init();

        // ⚠️ ВАЖНО: Поддерживаем оба варианта имени опции для совместимости
        // По умолчанию устанавливаем true для избежания ошибок TLS pinning
        const insecureSkipVerify = config.insecure_skip_verify !== undefined 
            ? config.insecure_skip_verify === true 
            : (config.insecureSkipVerify !== undefined 
                ? config.insecureSkipVerify === true 
                : true); // По умолчанию true
        
        const sessionConfig = {
            browser: config.browser || 'chrome',
            user_agent: config.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            proxy: config.proxy || null,
            timeout_ms: config.timeout || networkPolicy.timeouts.upstreamRequestMs,
            max_redirects: config.maxRedirects || 10,
            insecure_skip_verify: insecureSkipVerify,
            ordered_headers: config.orderedHeaders || null
        };

        // Create session
        const configJson = JSON.stringify(sessionConfig);
        const configBuffer = Buffer.from(configJson + '\0', 'utf8');
        this.sessionId = azureTLS.azuretls_session_new(configBuffer);

        if (!this.sessionId) {
            throw new Error('Failed to create AzureTLS session');
        }
    }

    /**
     * Добавляет именованный колбэк для обработки ответа.
     * Колбэк будет вызван после каждого запроса.
     * @param {string} name - Уникальное имя колбэка.
     * @param {function(object, object, AzureTLSClient): Promise<boolean>} callback - Функция обратного вызова.
     * Аргументы: (response, requestOptions, client).
     * Если колбэк возвращает `true`, запрос будет повторен.
     */
    addCallbackResponse(name, callback) {
        if (typeof callback !== 'function') {
            throw new Error('Callback must be a function.');
        }
        this.responseCallbacks.set(name, callback);
    }

    /**
     * Удаляет именованный колбэк.
     * @param {string} name - Имя колбэка для удаления.
     */
    removeCallbackResponse(name) {
        this.responseCallbacks.delete(name);
    }

    async request(options) {
        const maxRetries = options.maxRetries ?? networkPolicy.retry.maxRetries;
        const signal = options.signal || null;
        let attempt = 0;
        let lastResult = null;
        const startedAt = Date.now();

        while (attempt <= maxRetries) {
            if (signal?.aborted) {
                throw new DOMException('Request aborted', 'AbortError');
            }

            const useOrdered = options.orderedHeaders && options.orderedHeaders.length > 0;
            // body: всегда строка для FFI (object → JSON.stringify, как в post())
            let bodyVal = options.body ?? null;
            if (bodyVal !== null && typeof bodyVal === 'object' && !Buffer.isBuffer(bodyVal)) {
                bodyVal = JSON.stringify(bodyVal);
            }
            const requestConfig = {
                method: options.method || 'GET',
                url: options.url,
                body: bodyVal,
                headers: useOrdered ? null : (options.headers || null),
                ordered_headers: useOrdered ? options.orderedHeaders : null,
                proxy: options.proxy || null,
                timeout_ms: options.timeout || networkPolicy.timeouts.upstreamRequestMs,
                force_http1: options.forceHttp1 === true,
                force_http3: options.forceHttp3 === true,
                ignore_body: options.ignoreBody === true,
                no_cookie: options.noCookie === true,
                // Go JSON parser expects bool for disable_redirects
                disable_redirects: options.disableRedirects === true,
                max_redirects: options.disableRedirects === true ? 0 : (options.maxRedirects || 10),
                insecure_skip_verify: options.insecureSkipVerify === true
            };
            if (options.body_base64) {
                requestConfig.body_b64 = options.body_base64;
                delete requestConfig.body;
            }

            if (requestConfig.disable_redirects || requestConfig.max_redirects === 0) {
                process.stderr.write(`[ffi-dbg] sending to FFI: disable_redirects=${requestConfig.disable_redirects} max_redirects=${requestConfig.max_redirects} url=${requestConfig.url}\n`);
            }
            if (process.env.CUPNET_MITM_DEBUG === '1') {
                const dump = { ...requestConfig };
                if (dump.body_b64) dump.body_b64 = `[${dump.body_b64.length} chars base64]`;
                if (dump.body && dump.body.length > 200) dump.body = dump.body.slice(0, 200) + '...';
                if (dump.ordered_headers) dump.ordered_headers = dump.ordered_headers.map(([k, v]) => [k, (v && v.length > 80) ? v.slice(0, 80) + '...' : v]);
                const s = JSON.stringify(dump);
                process.stderr.write(`[mitm-debug] FFI request: ${s.length > 1500 ? s.slice(0, 1500) + '...' : s}\n`);
            }
            const requestJson = JSON.stringify(requestConfig);
            const requestBuffer = Buffer.from(requestJson + '\0', 'utf8');

            // [OPT-T1] Асинхронный FFI вызов — НЕ блокирует event loop
            // Синхронный azuretls_session_do блокировал весь Node.js на время HTTP-запроса,
            // из-за чего Promise.all не давал реального параллелизма
            const ffiPromise = new Promise((resolve, reject) => {
                azureTLS.azuretls_session_do.async(this.sessionId, requestBuffer, (err, ptr) => {
                    if (err) reject(err);
                    else resolve(ptr);
                });
            });

            // [OPT-T2] Race с AbortSignal — если задача отменена, не ждём FFI ответа
            let responsePtr;
            if (signal) {
                const abortPromise = new Promise((_, reject) => {
                    if (signal.aborted) return reject(new DOMException('Request aborted', 'AbortError'));
                    signal.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')), { once: true });
                });
                responsePtr = await Promise.race([ffiPromise, abortPromise]);
            } else {
                responsePtr = await ffiPromise;
            }

            if (responsePtr.isNull()) {
                throw new Error('Request failed - null response from FFI');
            }

            // Log only in debug mode

            
            // Детальное логирование только при включенном debug режиме
            if (this.debugMode) {
                console.log('Full request config:', requestJson);
            }

            const response = responsePtr.deref();
            const result = {
                statusCode: response.status_code,
                body: null,
                bodyLength: response.body_len,
                headers: {},
                url: null,
                error: null
            };

            if (response.body && !response.body.isNull() && response.body_len > 0) {
                const rawBuf = Buffer.from(response.body.reinterpret(response.body_len));
                result.bodyBase64 = rawBuf.toString('base64');
                result.body = rawBuf.toString('utf8');
            }
            if (response.headers && !response.headers.isNull()) try { result.headers = JSON.parse(response.headers.readCString()) || {}; } catch (e) { result.headers = {}; }
            if (response.url && !response.url.isNull()) result.url = response.url.readCString();
            if (response.error && !response.error.isNull()) result.error = response.error.readCString();

            if (requestConfig.disable_redirects || requestConfig.max_redirects === 0) {
                const sc = result.headers['set-cookie'] || result.headers['Set-Cookie'] || '';
                const loc = result.headers['location']  || result.headers['Location']  || '';
                process.stderr.write(`[ffi-dbg] FFI response: status=${result.statusCode} set-cookie=${sc} location=${loc} finalUrl=${result.url||''}\n`);
            }

            azureTLS.azuretls_free_response(responsePtr);

            lastResult = result;

            if (result.error) {
                console.error(`Request error on attempt ${attempt + 1}: ${result.error}`);
            }

            // --- ОБРАБОТКА КОЛБЭКОВ ---
            let shouldRetry = false;
            let skipAutoRetry = false; // Флаг для предотвращения автоматического ретрая
            for (const callback of this.responseCallbacks.values()) {
                const retrySignal = await callback(result, options, this);
                if (retrySignal === true) {
                    shouldRetry = true;
                    break;
                } else if (retrySignal === false) {
                    // ⚡ ИСПРАВЛЕНИЕ: Если колбэк возвращает false, предотвращаем автоматический ретрай
                    skipAutoRetry = true;
                }
            }

            
            if (!shouldRetry && !skipAutoRetry) {
                if (result.error) {
                    shouldRetry = true;
                } else if (retryableStatus(result.statusCode)) {
                    shouldRetry = true;
                }
            }

            const retryBudgetExceeded = (Date.now() - startedAt) >= networkPolicy.retry.budgetMs;
            if (shouldRetry && attempt < maxRetries && !retryBudgetExceeded) {
                attempt++;
                if (this.debugMode) {
                    console.log(`Retrying request, attempt ${attempt}/${maxRetries}`);
                }
                const backoffMs = computeBackoffMs(attempt - 1);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                continue;
            } else {
                break;
            }
        }

        if (lastResult.error) {
            throw new Error(`Request failed after all attempts: ${lastResult.error}`);
        }

        return lastResult;
    }

    async get(url, options = {}) {
        return this.request({...options, method: 'GET', url});
    }

    async post(url, data, options = {}) {
        if (data instanceof FormData) {
            const form = data;
            const formHeaders = form.getHeaders();
            const multipartBody = await form.getBuffer();
            const body_base64 = multipartBody.toString('base64');
            const headers = {...options.headers, ...formHeaders};

            // Сразу вызываем request и выходим
            return this.request({...options, method: 'POST', url, headers, body_base64});
        }

        const body = typeof data === 'object' ? JSON.stringify(data) : data;
        return this.request({...options, method: 'POST', url, body});
    }


    async put(url, data, options = {}) {
        const body = typeof data === 'object' ? JSON.stringify(data) : data;
        return this.request({...options, method: 'PUT', url, body});
    }

    async delete(url, options = {}) {
        return this.request({...options, method: 'DELETE', url});
    }

    // Apply JA3 fingerprint for TLS fingerprinting
    applyJA3(ja3String, navigator = null) {
        const ja3Buffer = Buffer.from(ja3String + '\0', 'utf8');
        const navBuffer = navigator ? Buffer.from(navigator + '\0', 'utf8') : null;
        const result = azureTLS.azuretls_session_apply_ja3(this.sessionId, ja3Buffer, navBuffer);
        if (result && !result.isNull()) {
            const error = result.readCString();
            azureTLS.azuretls_free_string(result);
            if (error) {
                throw new Error(`Failed to apply JA3: ${error}`);
            }
        }
    }

    // Apply HTTP/2 fingerprint
    applyHTTP2Fingerprint(fingerprint) {
        const fpBuffer = Buffer.from(fingerprint + '\0', 'utf8');
        const result = azureTLS.azuretls_session_apply_http2(this.sessionId, fpBuffer);
        if (result && !result.isNull()) {
            const error = result.readCString();
            azureTLS.azuretls_free_string(result);
            if (error) {
                throw new Error(`Failed to apply HTTP/2 fingerprint: ${error}`);
            }
        }
    }

    // Set proxy
    setProxy(proxyUrl) {
        // 1. Создаем правильный C-string buffer с помощью ref-napi
        const proxyCStr = ref.allocCString(proxyUrl);

        // 2. Передаем этот buffer в FFI-вызов
        const result = azureTLS.azuretls_session_set_proxy(this.sessionId, proxyCStr);

        // 3. Логика обработки результата остается прежней
        if (result && !result.isNull()) {
            const error = result.readCString(); // ref-napi добавляет эту удобную функцию к буферам
            azureTLS.azuretls_free_string(result);
            if (error) {
                throw new Error(`Failed to set proxy: ${error}`);
            }
        }
    }

    // Clear proxy
    clearProxy() {
        azureTLS.azuretls_session_clear_proxy(this.sessionId);
    }

    // Get current IP
    async getIP() {
        const result = azureTLS.azuretls_session_get_ip(this.sessionId);
        if (result && !result.isNull()) {
            const ip = result.readCString();
            azureTLS.azuretls_free_string(result);
            return ip;
        }
        return null;
    }

    // Get library version
    static getVersion() {
        const result = azureTLS.azuretls_version();
        if (result && !result.isNull()) {
            const version = result.readCString();
            azureTLS.azuretls_free_string(result);
            return version;
        }
        return 'unknown';
    }

    // Clean up resources
    close() {
        if (this.sessionId) {
            azureTLS.azuretls_session_close(this.sessionId);
            this.sessionId = null;
        }
    }

    // Cleanup library resources (call when your app is shutting down)
    static cleanup() {
        azureTLS.azuretls_cleanup();
    }
}

// Usage examples
async function examples() {
    try {
        console.log('AzureTLS Version:', AzureTLSClient.getVersion());

        // // Create a client instance
        const client = new AzureTLSClient({
            browser: 'chrome',
            timeout: 30000,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        });

        // Example 1: Simple GET request
        console.log('\n--- Example 1: Simple GET request ---');
        const response1 = await client.get('https://httpbin.org/get');
        console.log('Status Code:', response1.statusCode);
        console.log('Response Body:', response1.body);
//
//         // Example 2: POST request with JSON data
//         console.log('\n--- Example 2: POST request ---');
//         const postData = { name: 'John Doe', email: 'john@example.com' };
//         const response2 = await client.post('https://httpbin.org/post', postData, {
//             headers: {
//                 'Content-Type': 'application/json',
//                 'User-Agent': 'AzureTLS-Node-Client/1.0'
//             }
//         });
//         console.log('Status Code:', response2.statusCode);
//         console.log('Response Headers:', response2.headers);
//
//         // Example 3: GET request with custom headers
//         console.log('\n--- Example 3: GET with custom headers ---');
//         const response3 = await client.get('https://httpbin.org/headers', {
//             headers: {
//                 'X-Custom-Header': 'MyValue',
//                 'Authorization': 'Bearer token123'
//             }
//         });
//         console.log('Status Code:', response3.statusCode);
//         console.log('Response Body:', response3.body);
//
//         // Example 4: Apply JA3 fingerprint (example JA3)
//         console.log('\n--- Example 4: JA3 Fingerprinting ---');
//         try {
//             const ja3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-21,29-23-24,0';
//             client.applyJA3(ja3);
//             console.log('JA3 fingerprint applied successfully');
//
//             const response4 = await client.get('https://httpbin.org/json');
//             console.log('Request with JA3 - Status Code:', response4.statusCode);
//         } catch (error) {
//             console.log('JA3 Error:', error.message);
//         }
//
//         // Example 5: Get current IP
//         console.log('\n--- Example 5: Get IP ---');
//         try {
//             const ip = await client.getIP();
//             console.log('Current IP:', ip);
//         } catch (error) {
//             console.log('IP Error:', error.message);
//         }
//
//         // ==========================================================
// // ===       ФИНАЛЬНАЯ ВЕРСИЯ С АВТОМАТИЧЕСКОЙ ОБРАБОТКОЙ FormData   ===
// // ==========================================================
//         console.log('\n--- Example 6: Automatic FormData handling in post() ---');
//
//         const testFilePath = path.join(__dirname, 'test.txt');
//         const testFileContent = 'This is a test file, handled automatically by client.post!';
//         fs.writeFileSync(testFilePath, testFileContent);
//         console.log(`Создан тестовый файл: ${testFilePath}`);
//
//         const form = new FormData();
//
//         const fileBuffer = fs.readFileSync(testFilePath);
//         form.append('file', fileBuffer, { filename: 'test.txt' });
//         form.append('source', 'automatic-form-data-handling');
//
//         console.log('Отправка файла на https://httpbin.org/post...');
//         const response6 = await client.post(
//             'https://httpbin.org/post',
//             form, // <--- Просто передаем form!
//         );
//
//         console.log('Статус код:', response6.statusCode);
//         const responseBody = JSON.parse(response6.body);
//
//         console.log('\n--- Ответ от httpbin.org: ---');
//         console.log('Данные формы (form):', responseBody.form);
//         console.log('Полученные файлы (files):', responseBody.files);
//
//         if (responseBody.files && responseBody.files.file === testFileContent && responseBody.form.source === 'automatic-form-data-handling') {
//             console.log('\n✅ Успех! Автоматическая обработка FormData сработала!');
//         } else {
//             console.error('\n❌ Ошибка! Что-то пошло не так при автоматической обработке.');
//         }
//
//         fs.unlinkSync(testFilePath);

        const demoProxy = process.env.CUPNET_PROXY_URL;
        if (demoProxy) {
            client.setProxy(demoProxy);
            const response2 = await client.get('https://httpbin.org/get');
            console.log('Status Code:', response2.statusCode);
            console.log('Response Body:', response2.body);
        } else {
            console.log('Skip proxy demo: set CUPNET_PROXY_URL=<PROXY_URL>');
        }

        // Clean up
        client.close();

    } catch (error) {
        console.error('Error:', error.message);
    }
}

async function examples() {
    try {
        console.log('AzureTLS Version:', AzureTLSClient.getVersion());

        // // Create a client instance
        const client = new AzureTLSClient({
            browser: 'chrome',
            timeout: 30000,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        });

        // Example 1: Simple GET request
        console.log('\n--- Example 1: Simple GET request ---');
        const response1 = await client.get('https://httpbin.org/get');
        console.log('Status Code:', response1.statusCode);
        console.log('Response Body:', response1.body);
//
//         // Example 2: POST request with JSON data
//         console.log('\n--- Example 2: POST request ---');
//         const postData = { name: 'John Doe', email: 'john@example.com' };
//         const response2 = await client.post('https://httpbin.org/post', postData, {
//             headers: {
//                 'Content-Type': 'application/json',
//                 'User-Agent': 'AzureTLS-Node-Client/1.0'
//             }
//         });
//         console.log('Status Code:', response2.statusCode);
//         console.log('Response Headers:', response2.headers);
//
//         // Example 3: GET request with custom headers
//         console.log('\n--- Example 3: GET with custom headers ---');
//         const response3 = await client.get('https://httpbin.org/headers', {
//             headers: {
//                 'X-Custom-Header': 'MyValue',
//                 'Authorization': 'Bearer token123'
//             }
//         });
//         console.log('Status Code:', response3.statusCode);
//         console.log('Response Body:', response3.body);
//
//         // Example 4: Apply JA3 fingerprint (example JA3)
//         console.log('\n--- Example 4: JA3 Fingerprinting ---');
//         try {
//             const ja3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-21,29-23-24,0';
//             client.applyJA3(ja3);
//             console.log('JA3 fingerprint applied successfully');
//
//             const response4 = await client.get('https://httpbin.org/json');
//             console.log('Request with JA3 - Status Code:', response4.statusCode);
//         } catch (error) {
//             console.log('JA3 Error:', error.message);
//         }
//
//         // Example 5: Get current IP
//         console.log('\n--- Example 5: Get IP ---');
//         try {
//             const ip = await client.getIP();
//             console.log('Current IP:', ip);
//         } catch (error) {
//             console.log('IP Error:', error.message);
//         }
//
//         // ==========================================================
// // ===       ФИНАЛЬНАЯ ВЕРСИЯ С АВТОМАТИЧЕСКОЙ ОБРАБОТКОЙ FormData   ===
// // ==========================================================
//         console.log('\n--- Example 6: Automatic FormData handling in post() ---');
//
//         const testFilePath = path.join(__dirname, 'test.txt');
//         const testFileContent = 'This is a test file, handled automatically by client.post!';
//         fs.writeFileSync(testFilePath, testFileContent);
//         console.log(`Создан тестовый файл: ${testFilePath}`);
//
//         const form = new FormData();
//
//         const fileBuffer = fs.readFileSync(testFilePath);
//         form.append('file', fileBuffer, { filename: 'test.txt' });
//         form.append('source', 'automatic-form-data-handling');
//
//         console.log('Отправка файла на https://httpbin.org/post...');
//         const response6 = await client.post(
//             'https://httpbin.org/post',
//             form, // <--- Просто передаем form!
//         );
//
//         console.log('Статус код:', response6.statusCode);
//         const responseBody = JSON.parse(response6.body);
//
//         console.log('\n--- Ответ от httpbin.org: ---');
//         console.log('Данные формы (form):', responseBody.form);
//         console.log('Полученные файлы (files):', responseBody.files);
//
//         if (responseBody.files && responseBody.files.file === testFileContent && responseBody.form.source === 'automatic-form-data-handling') {
//             console.log('\n✅ Успех! Автоматическая обработка FormData сработала!');
//         } else {
//             console.error('\n❌ Ошибка! Что-то пошло не так при автоматической обработке.');
//         }
//
//         fs.unlinkSync(testFilePath);

        const demoProxy = process.env.CUPNET_PROXY_URL;
        if (demoProxy) {
            client.setProxy(demoProxy);
            const response2 = await client.get('https://httpbin.org/get');
            console.log('Status Code:', response2.statusCode);
            console.log('Response Body:', response2.body);
        } else {
            console.log('Skip proxy demo: set CUPNET_PROXY_URL=<PROXY_URL>');
        }

        // Clean up
        client.close();

    } catch (error) {
        console.error('Error:', error.message);
    }
}

async function examples2() {
    console.log(`Используется версия AzureTLS: ${AzureTLSClient.getVersion()}`);

    // Создаем клиент с профилем, похожим на браузерный
    const client = new AzureTLSClient({
        browser: 'chrome_120', // Имитируем Chrome 120
        timeout: 30000,
    });

    try {
        const apiBase = process.env.CUPNET_API_BASE_URL || 'https://httpbin.org';
        const url = `${apiBase.replace(/\/+$/, '')}/post`;
        const demoProxy = process.env.CUPNET_PROXY_URL;
        const bearerToken = process.env.CUPNET_BEARER_TOKEN || '<BEARER_TOKEN>';
        const gwfNumber = process.env.CUPNET_GWF_NUMBER || 'GWF000000000';
        const userName = process.env.CUPNET_DEMO_USER || 'Demo User';
        if (demoProxy) client.setProxy(demoProxy);

        // Заголовки из вашего запроса
        const headers = {
            "Authorization" : `Bearer ${bearerToken}`,
            "Accept" : "application/json, text/plain, */*",
            "Content-Type" : "application/json",
            "origin" : process.env.CUPNET_ORIGIN || '<API_ORIGIN>',
            "referer" : process.env.CUPNET_REFERER || '<API_REFERER>',
            "Priority" : "u=1, i"
            // User-Agent и другие низкоуровневые заголовки будут добавлены автоматически
            // библиотекой в соответствии с профилем 'chrome_120'
        };

        // Тело запроса (payload)
        const payload = {
            "missionCode": "GBR",
            "vacCode": "OVB",
            "missionId": 1,
            "countryId": 97,
            "vacId": 311,
            "serviceLevelId": 3,
            "serviceLevel": "STD",
            "visaSubtype": "visit-visa-ooc-standard",
            "requestDate": "",
            "gwfNumber": gwfNumber,
            "action": "schedule",
            "userName": userName,
            "appointmentServiceId": 0,
            "appointmentServiceCode": "",
            "calendarTypeId": 0,
            "visaCategoryId": 105,
            "AccessToken": bearerToken,
            "countrycode": "RUS"
        };

        console.log("\n--- Отправка POST-запроса (safe demo) ---");
        console.log("URL:", url);

        // Используем метод client.post
        const response = await client.post(
            url,
            payload,      // Тело запроса (автоматически преобразуется в JSON-строку)
            { headers }   // Заголовки передаются в третьем аргументе (опции)
        );

        console.log("\n--- Ответ получен ---");
        console.log("Статус-код:", response.statusCode);

        // Пытаемся красиво напечатать JSON, если это он
        try {
            const responseBody = JSON.parse(response.body);
            console.log("Тело ответа (JSON):");
            console.log(JSON.stringify(responseBody, null, 2));
        } catch (e) {
            console.log("Тело ответа (TEXT):");
            console.log(response.body);
        }

    } catch (error) {
        console.error("\n--- ПРОИЗОШЛА КРИТИЧЕСКАЯ ОШИБКА ---");
        console.error(error);
    } finally {
        // Обязательно закрываем сессию, чтобы освободить ресурсы в Go
        if (client) {
            client.close();
            console.log("\nСессия AzureTLS успешно закрыта.");
        }
    }
}

// Run examples if this file is executed directly
if (require.main === module) {
    // examples().catch(console.error);
    examples2().catch(console.error);

}

// Export the class for use in other modules
module.exports = AzureTLSClient;
