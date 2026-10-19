package main

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"

	azuretls "github.com/Noooste/azuretls-client"
	"github.com/Noooste/fhttp/http2"
	tls "github.com/Noooste/utls"
	"github.com/Noooste/utls/dicttls"
)

// BrowserProfile mirrors azure-tls-worker.js BROWSER_PROFILES (JSON for __get_profiles__).
type BrowserProfile struct {
	Browser   string `json:"browser"`
	UserAgent string `json:"userAgent"`
	HTTP2     string `json:"http2"`
	Desc      string `json:"desc"`
}

var browserProfiles = map[string]BrowserProfile{
	"chrome": {
		Browser:   "chrome",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
		HTTP2:     "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
		Desc:      "Chrome 154 (Windows)",
	},
	"firefox": {
		Browser:   "firefox",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0",
		HTTP2:     "1:65536;2:0;4:131072;5:16384|12517377|0|m,p,a,s",
		Desc:      "Firefox 156 (Windows)",
	},
	"safari": {
		Browser:   "safari",
		UserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
		HTTP2:     "2:0;3:100;4:2097152;8:1;9:1|10420225|0|m,s,a,p",
		Desc:      "Safari 27 (macOS)",
	},
	"ios": {
		Browser:   "ios",
		UserAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
		HTTP2:     "2:0;3:100;4:2097152;9:1|10420225|0|m,s,a,p",
		Desc:      "iOS 27 (Mobile Safari)",
	},
	"edge": {
		Browser:   "edge",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
		HTTP2:     "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
		Desc:      "Edge 153 (Windows)",
	},
	"opera": {
		Browser:   "opera",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 OPR/136.0.0.0",
		HTTP2:     "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
		Desc:      "Opera 136 (Windows)",
	},
}

// sessionBrowserName maps UI names (e.g. chrome_120) to azuretls Session.Browser preset.
func sessionBrowserName(browser string) string {
	b := browser
	if b == "" {
		b = "chrome"
	}
	if _, ok := browserProfiles[b]; ok {
		return b
	}
	s := strings.ToLower(b)
	if strings.HasPrefix(s, "chrome") {
		return azuretls.Chrome
	}
	if strings.HasPrefix(s, "firefox") {
		return azuretls.Firefox
	}
	if strings.HasPrefix(s, "safari") {
		return azuretls.Safari
	}
	if strings.HasPrefix(s, "edge") {
		return azuretls.Edge
	}
	if strings.HasPrefix(s, "opera") {
		return azuretls.Opera
	}
	if strings.HasPrefix(s, "ios") {
		return azuretls.Ios
	}
	return azuretls.Chrome
}

func http2FingerprintForBrowser(browser string) string {
	b := browser
	if b == "" {
		b = "chrome"
	}
	if p, ok := browserProfiles[b]; ok && p.HTTP2 != "" {
		return p.HTTP2
	}
	s := strings.ToLower(b)
	switch {
	case strings.HasPrefix(s, "chrome"):
		return browserProfiles["chrome"].HTTP2
	case strings.HasPrefix(s, "firefox"):
		return browserProfiles["firefox"].HTTP2
	case strings.HasPrefix(s, "safari"):
		return browserProfiles["safari"].HTTP2
	case strings.HasPrefix(s, "edge"):
		return browserProfiles["edge"].HTTP2
	case strings.HasPrefix(s, "opera"):
		return browserProfiles["opera"].HTTP2
	case strings.HasPrefix(s, "ios"):
		return browserProfiles["ios"].HTTP2
	default:
		return browserProfiles["chrome"].HTTP2
	}
}

// navigatorForJa3 is the second argument to ApplyJa3 (TLS profile context).
func navigatorForJa3(browser string) string {
	b := sessionBrowserName(browser)
	switch b {
	case azuretls.Firefox:
		return azuretls.Firefox
	case azuretls.Safari:
		return azuretls.Safari
	case azuretls.Ios:
		return azuretls.Ios
	case azuretls.Edge:
		return azuretls.Edge
	case azuretls.Opera:
		return azuretls.Opera
	default:
		return azuretls.Chrome
	}
}

func defaultUserAgentForBrowser(browser string) string {
	b := browser
	if b == "" {
		b = "chrome"
	}
	if p, ok := browserProfiles[b]; ok {
		return p.UserAgent
	}
	return browserProfiles["chrome"].UserAgent
}

// ---------------------------------------------------------------------------------------------
// TLS ClientHello for the "chrome" profile.
//
// azuretls-client v1.13.2 (latest release) ships a Chrome preset annotated "Chrome 133". Real
// Google Chrome 153.0.8010.53, measured 2026-09-25 (headless, both via a local raw ClientHello
// capture and https://tls.peet.ws/api/all), sends the same cipher suites, supported groups, key
// shares (GREASE + X25519MLKEM768 + X25519), ALPN, ALPS, ECH GREASE, certificate compression and
// HTTP/2 SETTINGS, but differs in two places:
//   1. an extra extension 51764 (0xca34, TLS Trust Anchor Identifiers, draft-ietf-tls-trust-anchor-ids)
//      whose payload is the fixed list of Chrome Root Store anchors participating in TAI;
//   2. signature_algorithms starts with a GREASE value and the three ML-DSA schemes
//      (0x0904 mldsa44, 0x0905 mldsa65, 0x0906 mldsa87) before the classical ones.
// With both applied the worker's JA4 is t13d1517h2_8daaf6152771_cb7bf5808d99 — identical to real
// Chrome 153 — instead of the preset's t13d1516h2_8daaf6152771_d8a2da3f94cd. Extension order is
// shuffled per connection, as Chrome does. Verify after every Chrome/azuretls bump with
// `node scripts/tls-fingerprint-compare.mjs` (repo root) and `go test ./...` here.
//
// Set CUPNET_TLS_CHROME_UPSTREAM_PRESET=1 to fall back to the library preset (kill switch — e.g.
// if a server picks an ML-DSA scheme for CertificateVerify, which utls cannot verify yet).
// ---------------------------------------------------------------------------------------------

const (
	// extTrustAnchorIDs is the TLS extension type of draft-ietf-tls-trust-anchor-ids (0xca34).
	extTrustAnchorIDs uint16 = 51764

	// ML-DSA signature schemes (draft-ietf-tls-mldsa), advertised by Chrome 153.
	sigMLDSA44 tls.SignatureScheme = 0x0904
	sigMLDSA65 tls.SignatureScheme = 0x0905
	sigMLDSA87 tls.SignatureScheme = 0x0906

	// envChromeUpstreamPreset disables chromeClientHelloSpec and uses the azuretls-client preset.
	envChromeUpstreamPreset = "CUPNET_TLS_CHROME_UPSTREAM_PRESET"
)

// chrome153TrustAnchorIDs is the trust_anchors (51764) extension payload captured byte-for-byte
// from Chrome 153.0.8010.53: a TrustAnchorIdentifierList (2-byte length + length-prefixed binary
// relative OIDs). It depends only on the Chrome Root Store, so it is constant across connections
// and machines for a given Chrome version.
var chrome153TrustAnchorIDs = mustHex(
	"00b8" +
		"0582df130212" + "08839a648c9b2d010a" + "08839a648c9b2d010d" + "04d6790905" + "04d6790908" +
		"08839a648c9b2d0112" + "0582df130206" + "0582df130213" + "0582df130201" + "08839a648c9b2d0113" +
		"04d679090b" + "04d679090d" + "04d679090a" + "0582df130214" + "0582df13020e" +
		"08839a648c9b2d0108" + "0582df13020f" + "04d6790906" + "08839a648c9b2d0107" + "0582df13020d" +
		"04d6790907" + "04d679090f" + "04d6790901" + "04d6790904" + "08839a648c9b2d010c" +
		"08839a648c9b2d0109" + "08839a648c9b2d010b" + "04d679090c",
)

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic("profiles: bad hex constant: " + err.Error())
	}
	return b
}

// greaseSignatureScheme returns a random BoringSSL-style GREASE value (0x?a?a) for the leading
// signature_algorithms entry. utls only re-GREASEs ciphers/groups/versions/extensions, so this is
// drawn here, once per ClientHello, exactly like BoringSSL's per-connection grease seed.
func greaseSignatureScheme() tls.SignatureScheme {
	var b [1]byte
	if _, err := rand.Read(b[:]); err != nil {
		return tls.SignatureScheme(tls.GREASE_PLACEHOLDER)
	}
	n := uint16(b[0] & 0x0f)
	return tls.SignatureScheme(0x0a0a | n<<12 | n<<4)
}

// chromeClientHelloSpec builds the Chrome 153-shaped ClientHelloSpec described above. It is
// called by azuretls once per TLS connection (Session.GetClientHelloSpec), so the extension
// shuffle and the GREASE signature scheme are fresh every time.
func chromeClientHelloSpec() *tls.ClientHelloSpec {
	return &tls.ClientHelloSpec{
		CipherSuites: []uint16{
			tls.GREASE_PLACEHOLDER,
			tls.TLS_AES_128_GCM_SHA256,
			tls.TLS_AES_256_GCM_SHA384,
			tls.TLS_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			tls.TLS_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_RSA_WITH_AES_128_CBC_SHA,
			tls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []byte{0x00},
		Extensions: tls.ShuffleChromeTLSExtensions([]tls.TLSExtension{
			&tls.UtlsGREASEExtension{},
			&tls.KeyShareExtension{KeyShares: []tls.KeyShare{
				{Group: tls.CurveID(tls.GREASE_PLACEHOLDER), Data: []byte{0}},
				{Group: tls.X25519MLKEM768},
				{Group: tls.X25519},
			}},
			&tls.ALPNExtension{AlpnProtocols: []string{http2.NextProtoTLS, "http/1.1"}},
			&tls.SNIExtension{},
			&tls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []tls.SignatureScheme{
				greaseSignatureScheme(),
				sigMLDSA44,
				sigMLDSA65,
				sigMLDSA87,
				tls.ECDSAWithP256AndSHA256,
				tls.PSSWithSHA256,
				tls.PKCS1WithSHA256,
				tls.ECDSAWithP384AndSHA384,
				tls.PSSWithSHA384,
				tls.PKCS1WithSHA384,
				tls.PSSWithSHA512,
				tls.PKCS1WithSHA512,
			}},
			&tls.ExtendedMasterSecretExtension{},
			&tls.SessionTicketExtension{},
			&tls.SCTExtension{},
			&tls.RenegotiationInfoExtension{},
			&tls.PSKKeyExchangeModesExtension{Modes: []uint8{tls.PskModeDHE}},
			&tls.ApplicationSettingsExtensionNew{SupportedProtocols: []string{http2.NextProtoTLS}},
			&tls.UtlsCompressCertExtension{Algorithms: []tls.CertCompressionAlgo{tls.CertCompressionBrotli}},
			&tls.SupportedVersionsExtension{Versions: []uint16{
				tls.GREASE_PLACEHOLDER,
				tls.VersionTLS13,
				tls.VersionTLS12,
			}},
			&tls.SupportedCurvesExtension{Curves: []tls.CurveID{
				tls.GREASE_PLACEHOLDER,
				tls.X25519MLKEM768,
				tls.X25519,
				tls.CurveP256,
				tls.CurveP384,
			}},
			&tls.StatusRequestExtension{},
			&tls.SupportedPointsExtension{SupportedPoints: []byte{0x00}},
			&tls.GREASEEncryptedClientHelloExtension{
				CandidateCipherSuites: []tls.HPKESymmetricCipherSuite{
					{KdfId: dicttls.HKDF_SHA256, AeadId: dicttls.AEAD_AES_128_GCM},
				},
				CandidatePayloadLens: []uint16{128, 160, 192, 224}, // +16: 144, 176, 208, 240
			},
			&tls.GenericExtension{Id: extTrustAnchorIDs, Data: chrome153TrustAnchorIDs},
			&tls.UtlsGREASEExtension{},
			&tls.UtlsPaddingExtension{GetPaddingLen: tls.BoringPaddingStyle},
		}),
	}
}

// clientHelloSpecForBrowser returns the custom ClientHello builder for an azuretls Session.Browser
// preset name, or nil to keep the library preset. Only "chrome" is overridden: Edge/Opera/Firefox/
// Safari/iOS were not re-measured, and a JA3 override (ApplyJa3) replaces this anyway.
func clientHelloSpecForBrowser(browser string) func() *tls.ClientHelloSpec {
	if browser != azuretls.Chrome {
		return nil
	}
	if v := strings.TrimSpace(os.Getenv(envChromeUpstreamPreset)); v == "1" || strings.EqualFold(v, "true") {
		return nil
	}
	return chromeClientHelloSpec
}
