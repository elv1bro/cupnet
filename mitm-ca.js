'use strict';

/**
 * Pure Node.js CA + MITM leaf certificate generation (no openssl binary).
 * Extracted from mitm-proxy.js for maintainability.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let caKey;
let caCert;
let caKeyPem;
let caCertPem;

/**
 * Encode ASN.1 TLV
 */
function asn1(tag, ...contents) {
    const body = Buffer.concat(contents.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c)));
    const len  = body.length;
    let lenBuf;
    if (len < 0x80) {
        lenBuf = Buffer.from([len]);
    } else if (len < 0x100) {
        lenBuf = Buffer.from([0x81, len]);
    } else {
        lenBuf = Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
    }
    return Buffer.concat([Buffer.from([tag]), lenBuf, body]);
}

const SEQ  = c => asn1(0x30, ...c);
const SET  = c => asn1(0x31, ...c);
const OID  = b => asn1(0x06, b);
const INT  = b => asn1(0x02, b);
const BIT  = b => asn1(0x03, Buffer.concat([Buffer.from([0x00]), b]));
const OCT  = b => asn1(0x04, b);
const UTF8 = s => asn1(0x0c, Buffer.from(s, 'utf8'));
const ctx  = (n, b) => asn1(0xa0 | n, b);
const RAW  = b => b;

const OID_sha256withECDSA = Buffer.from('2a8648ce3d040302', 'hex');
const OID_basicConstraints = Buffer.from('551d13', 'hex');
const OID_subjectAltName = Buffer.from('551d11', 'hex');
const OID_subjectKeyId   = Buffer.from('551d0e', 'hex');
const OID_authorityKeyId = Buffer.from('551d23', 'hex');

function encodeRDN(oidHex, value) {
    return SET([SEQ([OID(Buffer.from(oidHex, 'hex')), UTF8(value)])]);
}

function encodeTime(date) {
    const s = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    return asn1(0x18, Buffer.from(s, 'ascii'));
}

function encodeSerial(n) {
    let h = n.toString(16);
    if (h.length % 2) h = '0' + h;
    let b = Buffer.from(h, 'hex');
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return INT(b);
}

function buildCert({ subjectCN, subjectOrg, issuerCN, serial, notBefore, notAfter,
    pubKeyDer, signerKey, isCA, san, authorityKeyIdBytes }) {

    const subject = subjectOrg
        ? SEQ([encodeRDN('550403', subjectCN), encodeRDN('55040a', subjectOrg), encodeRDN('550406', 'US')])
        : SEQ([encodeRDN('550403', subjectCN)]);

    const issuer = issuerCN === subjectCN && subjectOrg
        ? subject
        : SEQ([encodeRDN('550403', issuerCN)]);

    const extensions = [];

    const bcValue = isCA
        ? SEQ([asn1(0x01, Buffer.from([0xff]))])
        : SEQ([]);
    extensions.push(SEQ([OID(OID_basicConstraints),
        asn1(0x01, Buffer.from([0xff])),
        OCT(bcValue)]));

    const pubKeyHash = crypto.createHash('sha1')
        .update(Buffer.from(pubKeyDer).slice(-65))
        .digest();
    extensions.push(SEQ([OID(OID_subjectKeyId), OCT(OCT(pubKeyHash))]));

    if (authorityKeyIdBytes) {
        extensions.push(SEQ([OID(OID_authorityKeyId),
            OCT(SEQ([ctx(0, authorityKeyIdBytes)]))]));
    }

    if (san) {
        const sanExt = SEQ([asn1(0x82, Buffer.from(san, 'ascii'))]);
        extensions.push(SEQ([OID(OID_subjectAltName), OCT(sanExt)]));
    }

    const tbsCert = SEQ([
        ctx(0, asn1(0x02, Buffer.from([0x02]))),
        encodeSerial(serial),
        SEQ([OID(OID_sha256withECDSA)]),
        issuer,
        SEQ([encodeTime(notBefore), encodeTime(notAfter)]),
        subject,
        RAW(Buffer.from(pubKeyDer)),
        ctx(3, SEQ(extensions)),
    ]);

    const sig = crypto.sign('SHA256', tbsCert, signerKey);
    return SEQ([RAW(tbsCert), SEQ([OID(OID_sha256withECDSA)]), BIT(sig)]);
}

function derToPem(tag, der) {
    const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN ${tag}-----\n${b64}\n-----END ${tag}-----\n`;
}

function generateCA() {
    caKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    _finishCA(caKey.publicKey, caKey.privateKey);
    return { caKeyPem, caCertPem };
}

/**
 * Load existing CA from disk or generate a new one and save it.
 * @param {string} dir — directory to store ca-key.pem + ca-cert.pem
 * @returns {{ caKeyPem: string, caCertPem: string, generated: boolean }}
 */
function loadOrGenerateCA(dir) {
    const keyFile  = path.join(dir, 'ca-key.pem');
    const certFile = path.join(dir, 'ca-cert.pem');

    try {
        if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
            const savedKey  = fs.readFileSync(keyFile, 'utf8');
            const savedCert = fs.readFileSync(certFile, 'utf8');
            caKey = crypto.createPrivateKey(savedKey);
            caKey = { publicKey: crypto.createPublicKey(caKey), privateKey: caKey };
            caKeyPem  = savedKey;
            caCertPem = savedCert;
            const certDer = Buffer.from(
                savedCert.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64'
            );
            caCert = certDer;
            return { caKeyPem, caCertPem, generated: false };
        }
    } catch {
        // Corrupted files — regenerate
    }

    generateCA();
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(keyFile, caKeyPem, { mode: 0o600 });
        fs.writeFileSync(certFile, caCertPem, { mode: 0o644 });
    } catch {
        // Non-fatal — CA works in memory, just won't persist
    }
    return { caKeyPem, caCertPem, generated: true };
}

function generateCAAsync() {
    return new Promise((resolve, reject) => {
        crypto.generateKeyPair('ec', { namedCurve: 'P-256' }, (err, pubKey, privKey) => {
            if (err) return reject(err);
            caKey = { publicKey: pubKey, privateKey: privKey };
            _finishCA(pubKey, privKey);
            resolve({ caKeyPem, caCertPem });
        });
    });
}

function _finishCA(pubKey, privKey) {
    const pubDer = pubKey.export({ type: 'spki', format: 'der' });
    const now  = new Date();
    const then = new Date(now); then.setFullYear(then.getFullYear() + 10);

    const certDer = buildCert({
        subjectCN:  'CupNet MITM CA',
        subjectOrg: 'CupNet',
        issuerCN:   'CupNet MITM CA',
        serial:     Date.now(),
        notBefore:  now,
        notAfter:   then,
        pubKeyDer:  pubDer,
        signerKey:  privKey,
        isCA:       true,
        san:        null,
        authorityKeyIdBytes: null,
    });

    caKeyPem  = privKey.export({ type: 'pkcs8', format: 'pem' });
    caCertPem = derToPem('CERTIFICATE', certDer);
    caCert    = certDer;
}

const CERT_CACHE_MAX = 500;
const domainCertCache = new Map();
function cacheCert(hostname, cert) {
    if (domainCertCache.size >= CERT_CACHE_MAX) {
        domainCertCache.delete(domainCertCache.keys().next().value);
    }
    domainCertCache.set(hostname, cert);
}

const domainCertPending = new Map();

function getFakeCert(hostname) {
    if (domainCertCache.has(hostname)) {
        const c = domainCertCache.get(hostname);
        domainCertCache.delete(hostname);
        domainCertCache.set(hostname, c);
        return c;
    }
    return _generateDomainCert(hostname);
}

function getFakeCertAsync(hostname) {
    if (domainCertCache.has(hostname)) {
        const c = domainCertCache.get(hostname);
        domainCertCache.delete(hostname);
        domainCertCache.set(hostname, c);
        return Promise.resolve(c);
    }
    if (domainCertPending.has(hostname)) return domainCertPending.get(hostname);
    const p = new Promise((resolve, reject) => {
        crypto.generateKeyPair('ec', { namedCurve: 'P-256' }, (err, pubKey, privKey) => {
            if (err) return reject(err);
            try {
                const result = _buildDomainCert(hostname, pubKey, privKey);
                cacheCert(hostname, result);
                resolve(result);
            } catch (e) { reject(e); }
        });
    }).finally(() => domainCertPending.delete(hostname));
    domainCertPending.set(hostname, p);
    return p;
}

function _generateDomainCert(hostname) {
    const domKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const result = _buildDomainCert(hostname, domKey.publicKey, domKey.privateKey);
    cacheCert(hostname, result);
    return result;
}

function _buildDomainCert(hostname, pubKey, privKey) {
    const pubDer = pubKey.export({ type: 'spki', format: 'der' });
    const now    = new Date();
    const then   = new Date(now); then.setFullYear(then.getFullYear() + 2);
    const caPubDer = caKey.publicKey.export({ type: 'spki', format: 'der' });
    const caKeyId  = crypto.createHash('sha1').update(Buffer.from(caPubDer).slice(-65)).digest();
    const certDer  = buildCert({
        subjectCN:   hostname,
        subjectOrg:  null,
        issuerCN:    'CupNet MITM CA',
        serial:      Date.now() + Math.floor(Math.random() * 1000),
        notBefore:   now,
        notAfter:    then,
        pubKeyDer:   pubDer,
        signerKey:   caKey.privateKey,
        isCA:        false,
        san:         hostname,
        authorityKeyIdBytes: caKeyId,
    });
    return {
        key:  privKey.export({ type: 'pkcs8', format: 'pem' }),
        cert: derToPem('CERTIFICATE', certDer),
    };
}

function getCACertPem() {
    return caCertPem;
}

module.exports = {
    generateCA,
    generateCAAsync,
    loadOrGenerateCA,
    getFakeCert,
    getFakeCertAsync,
    getCACertPem,
};
