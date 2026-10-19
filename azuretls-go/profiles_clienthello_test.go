package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
	tls "github.com/Noooste/utls"
)

// ---- offline ClientHello capture --------------------------------------------------------------

type capturedExt struct {
	id   uint16
	data []byte
}

type capturedHello struct {
	ciphers []uint16
	exts    []capturedExt
}

func (h *capturedHello) ext(id uint16) ([]byte, bool) {
	for _, e := range h.exts {
		if e.id == id {
			return e.data, true
		}
	}
	return nil, false
}

func isGrease(v uint16) bool { return (v>>8) == v&0xff && v&0x0f == 0x0a }

// parseClientHello parses a raw TLS ClientHello handshake message (type 1 + 3-byte length + body).
func parseClientHello(t *testing.T, raw []byte) *capturedHello {
	t.Helper()
	if len(raw) < 4 || raw[0] != 1 {
		t.Fatalf("not a ClientHello handshake message (len=%d)", len(raw))
	}
	p := raw[4:]
	p = p[2+32:] // legacy_version + random
	sidLen := int(p[0])
	p = p[1+sidLen:]
	csLen := int(binary.BigEndian.Uint16(p))
	p = p[2:]
	h := &capturedHello{}
	for i := 0; i < csLen; i += 2 {
		h.ciphers = append(h.ciphers, binary.BigEndian.Uint16(p[i:]))
	}
	p = p[csLen:]
	cmLen := int(p[0])
	p = p[1+cmLen:]
	extLen := int(binary.BigEndian.Uint16(p))
	p = p[2:]
	exts := p[:extLen]
	for len(exts) >= 4 {
		id := binary.BigEndian.Uint16(exts)
		el := int(binary.BigEndian.Uint16(exts[2:]))
		h.exts = append(h.exts, capturedExt{id: id, data: append([]byte(nil), exts[4:4+el]...)})
		exts = exts[4+el:]
	}
	return h
}

// marshalSpec applies spec to a utls connection over an unused pipe and returns the raw
// ClientHello bytes without any network I/O.
func marshalSpec(t *testing.T, spec *tls.ClientHelloSpec, serverName string) []byte {
	t.Helper()
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()
	uc := tls.UClient(c1, &tls.Config{ServerName: serverName, InsecureSkipVerify: true}, tls.HelloCustom)
	if err := uc.ApplyPreset(spec); err != nil {
		t.Fatalf("ApplyPreset: %v", err)
	}
	if err := uc.BuildHandshakeState(); err != nil {
		t.Fatalf("BuildHandshakeState: %v", err)
	}
	raw := uc.HandshakeState.Hello.Raw
	if len(raw) == 0 {
		t.Fatal("empty ClientHello")
	}
	return raw
}

func u16list(data []byte) []uint16 {
	var out []uint16
	for i := 0; i+1 < len(data); i += 2 {
		out = append(out, binary.BigEndian.Uint16(data[i:]))
	}
	return out
}

func withoutGrease(in []uint16) []uint16 {
	out := make([]uint16, 0, len(in))
	for _, v := range in {
		if !isGrease(v) {
			out = append(out, v)
		}
	}
	return out
}

// ---- expectations captured from Google Chrome 153.0.8010.53 (2026-09-25) ------------------------

// chrome153ExtensionTypes is the set of non-GREASE extensions real Chrome 153 sends (17 → JA4 "t13d1517h2").
var chrome153ExtensionTypes = []uint16{0, 5, 10, 11, 13, 16, 18, 23, 27, 35, 43, 45, 51, 17613, 51764, 65037, 65281}

var chrome153SigAlgs = []uint16{0x0904, 0x0905, 0x0906, 0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601}

var chrome153Ciphers = []uint16{
	0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8,
	0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035,
}

var chrome153Groups = []uint16{0x11ec, 0x001d, 0x0017, 0x0018}

func TestChromeClientHelloSpecMatchesChrome153(t *testing.T) {
	h := parseClientHello(t, marshalSpec(t, chromeClientHelloSpec(), "example.com"))

	// Cipher suites: one leading GREASE, then Chrome's list in Chrome's order.
	if !isGrease(h.ciphers[0]) {
		t.Fatalf("first cipher should be GREASE, got %#04x", h.ciphers[0])
	}
	if got := withoutGrease(h.ciphers); !reflect.DeepEqual(got, chrome153Ciphers) {
		t.Fatalf("ciphers:\n got  %#04x\n want %#04x", got, chrome153Ciphers)
	}

	// Extension type set (GREASE removed, no padding — the MLKEM key share already exceeds 512 bytes).
	var types []uint16
	greaseExts := 0
	for _, e := range h.exts {
		if isGrease(e.id) {
			greaseExts++
			continue
		}
		types = append(types, e.id)
	}
	sort.Slice(types, func(i, j int) bool { return types[i] < types[j] })
	if !reflect.DeepEqual(types, chrome153ExtensionTypes) {
		t.Fatalf("extension types:\n got  %d\n want %d", types, chrome153ExtensionTypes)
	}
	if greaseExts != 2 {
		t.Fatalf("expected 2 GREASE extensions, got %d", greaseExts)
	}
	if _, has := h.ext(21); has {
		t.Fatal("padding extension must not be present (Chrome 153 does not send it with the MLKEM key share)")
	}

	// 51764 trust_anchors payload byte-for-byte.
	tai, ok := h.ext(extTrustAnchorIDs)
	if !ok {
		t.Fatal("extension 51764 (trust_anchors) missing")
	}
	if !bytes.Equal(tai, chrome153TrustAnchorIDs) {
		t.Fatalf("trust_anchors payload differs:\n got  %x\n want %x", tai, chrome153TrustAnchorIDs)
	}
	if len(tai) != 186 || int(binary.BigEndian.Uint16(tai)) != len(tai)-2 {
		t.Fatalf("trust_anchors payload framing: len=%d inner=%d", len(tai), binary.BigEndian.Uint16(tai))
	}

	// signature_algorithms: GREASE first, then ML-DSA x3, then the classical Chrome list.
	sa, _ := h.ext(13)
	sig := u16list(sa[2:]) // skip list length
	if len(sig) != 12 {
		t.Fatalf("expected 12 signature schemes, got %d: %#04x", len(sig), sig)
	}
	if !isGrease(sig[0]) {
		t.Fatalf("first signature scheme should be GREASE, got %#04x", sig[0])
	}
	if got := sig[1:]; !reflect.DeepEqual(got, chrome153SigAlgs) {
		t.Fatalf("sigalgs:\n got  %#04x\n want %#04x", got, chrome153SigAlgs)
	}

	// supported_groups, supported_versions, key_share groups, ALPN, ALPS, compress_certificate.
	sg, _ := h.ext(10)
	groups := u16list(sg[2:])
	if !isGrease(groups[0]) || !reflect.DeepEqual(withoutGrease(groups), chrome153Groups) {
		t.Fatalf("groups: %#04x", groups)
	}
	sv, _ := h.ext(43)
	vers := u16list(sv[1:])
	if !isGrease(vers[0]) || !reflect.DeepEqual(withoutGrease(vers), []uint16{0x0304, 0x0303}) {
		t.Fatalf("versions: %#04x", vers)
	}
	ks, _ := h.ext(51)
	if len(ks) != 1263 {
		t.Fatalf("key_share length %d, Chrome 153 sends 1263 (GREASE + X25519MLKEM768 + X25519)", len(ks))
	}
	alpn, _ := h.ext(16)
	if !bytes.Equal(alpn, []byte("\x00\x0c\x02h2\x08http/1.1")) {
		t.Fatalf("alpn: %q", alpn)
	}
	alps, _ := h.ext(17613)
	if !bytes.Equal(alps, []byte{0x00, 0x03, 0x02, 'h', '2'}) {
		t.Fatalf("alps: %x", alps)
	}
	cc, _ := h.ext(27)
	if !bytes.Equal(cc, []byte{0x02, 0x00, 0x02}) {
		t.Fatalf("compress_certificate: %x", cc)
	}
}

func TestChromeClientHelloSpecFreshPerCall(t *testing.T) {
	// Chrome shuffles extension order per connection and re-draws GREASE values; our spec builder
	// runs once per connection, so two builds must not be byte-identical in ordering.
	orders := map[string]bool{}
	sigGrease := map[uint16]bool{}
	for i := 0; i < 8; i++ {
		h := parseClientHello(t, marshalSpec(t, chromeClientHelloSpec(), "example.com"))
		var order []byte
		for _, e := range h.exts {
			order = append(order, byte(e.id>>8), byte(e.id))
		}
		orders[string(order)] = true
		sa, _ := h.ext(13)
		sigGrease[u16list(sa[2:])[0]] = true
	}
	if len(orders) < 2 {
		t.Fatal("extension order did not change across 8 builds")
	}
	for v := range sigGrease {
		if !isGrease(v) {
			t.Fatalf("non-GREASE leading signature scheme %#04x", v)
		}
	}
}

func TestGreaseSignatureScheme(t *testing.T) {
	seen := map[tls.SignatureScheme]bool{}
	for i := 0; i < 256; i++ {
		v := uint16(greaseSignatureScheme())
		if !isGrease(v) {
			t.Fatalf("not a GREASE value: %#04x", v)
		}
		seen[tls.SignatureScheme(v)] = true
	}
	if len(seen) < 8 {
		t.Fatalf("GREASE values not random enough: %d distinct", len(seen))
	}
}

func TestClientHelloSpecForBrowser(t *testing.T) {
	t.Setenv(envChromeUpstreamPreset, "")
	if clientHelloSpecForBrowser(azuretls.Chrome) == nil {
		t.Fatal("chrome must get the custom spec")
	}
	for _, b := range []string{azuretls.Firefox, azuretls.Safari, azuretls.Ios, azuretls.Edge, azuretls.Opera, ""} {
		if clientHelloSpecForBrowser(b) != nil {
			t.Fatalf("%q must keep the library preset", b)
		}
	}
	t.Setenv(envChromeUpstreamPreset, "1")
	if clientHelloSpecForBrowser(azuretls.Chrome) != nil {
		t.Fatal("kill switch must disable the custom spec")
	}
}

func TestCreatePooledSessionUsesChromeSpec(t *testing.T) {
	t.Setenv(envChromeUpstreamPreset, "")
	chrome := "chrome"
	s, err := createPooledSession(&chrome, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.GetClientHelloSpec == nil {
		t.Fatal("chrome session must carry the custom ClientHelloSpec")
	}
	h := parseClientHello(t, marshalSpec(t, s.GetClientHelloSpec(), "example.com"))
	if _, ok := h.ext(extTrustAnchorIDs); !ok {
		t.Fatal("session spec lacks trust_anchors")
	}

	ff := "firefox"
	s2, err := createPooledSession(&ff, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if s2.GetClientHelloSpec != nil {
		t.Fatal("firefox session must keep the library preset")
	}

	t.Setenv(envChromeUpstreamPreset, "1")
	s3, err := createPooledSession(&chrome, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s3.Close()
	if s3.GetClientHelloSpec != nil {
		t.Fatal("kill switch must leave the library preset in place")
	}
}

// TestChromeSpecJA4Live checks the fingerprint tls.peet.ws computes for a worker session against
// real Chrome 153 (t13d1517h2_8daaf6152771_cb7bf5808d99). Needs network; opt in with
// CUPNET_GO_NET_TESTS=1.
func TestChromeSpecJA4Live(t *testing.T) {
	if os.Getenv("CUPNET_GO_NET_TESTS") != "1" {
		t.Skip("set CUPNET_GO_NET_TESTS=1 to run the live tls.peet.ws check")
	}
	t.Setenv(envChromeUpstreamPreset, "")
	chrome := "chrome"
	s, err := createPooledSession(&chrome, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.SetTimeout(30 * time.Second)
	resp, err := s.Get("https://tls.peet.ws/api/all")
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		TLS struct {
			JA4 string `json:"ja4"`
		} `json:"tls"`
	}
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, string(resp.Body[:min(len(resp.Body), 200)]))
	}
	const want = "t13d1517h2_8daaf6152771_cb7bf5808d99"
	if body.TLS.JA4 != want {
		t.Fatalf("JA4 %q, want %q (real Chrome 153)", body.TLS.JA4, want)
	}
	fmt.Fprintln(io.Discard, body.TLS.JA4)
}
