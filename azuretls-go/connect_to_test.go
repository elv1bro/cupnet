package main

import (
	"encoding/json"
	"fmt"
	stdhttp "net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

func TestConnectToIPValidation(t *testing.T) {
	s := func(v string) *string { return &v }
	cases := map[string]string{"127.0.0.1": "127.0.0.1", " 10.0.0.2 ": "10.0.0.2", "[::1]": "::1", "example.com": "", "": "", "1.2.3": ""}
	for in, want := range cases {
		if got := connectToIP(&incomingLine{ConnectTo: s(in)}); got != want {
			t.Fatalf("connectToIP(%q) = %q, want %q", in, got, want)
		}
	}
	if connectToIP(&incomingLine{}) != "" {
		t.Fatal("unset connectTo")
	}
}

func TestRequestPoolKeySplitsByConnectTo(t *testing.T) {
	ip := "10.1.2.3"
	plain := &incomingLine{URL: "https://a.example/x"}
	dial := &incomingLine{URL: "https://a.example/y", ConnectTo: &ip}
	if requestPoolKey(plain) == requestPoolKey(dial) {
		t.Fatal("an overridden request must not share the real host's pool")
	}
	if !strings.HasSuffix(requestPoolKey(dial), "::c:10.1.2.3") || !strings.HasPrefix(requestPoolKey(dial), requestPoolKey(plain)) {
		t.Fatalf("key %q", requestPoolKey(dial))
	}
}

// The URL keeps its hostname (SNI + Host + HTTP/2) while the connection goes to connectTo.
func TestConnectToDialsTheOverrideAndKeepsSNIAndH2(t *testing.T) {
	var mu sync.Mutex
	var gotHost, gotSNI string
	var gotProto int
	srv := httptest.NewUnstartedServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		mu.Lock()
		gotHost, gotProto = r.Host, r.ProtoMajor
		if r.TLS != nil {
			gotSNI = r.TLS.ServerName
		}
		mu.Unlock()
		fmt.Fprint(w, "ok")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	ip := "127.0.0.1"
	line, _ := json.Marshal(map[string]any{
		"id": "dial-1", "method": "GET", "url": "https://cupnet-dial.invalid:" + u.Port() + "/x",
		"connectTo": ip, "timeout": 10000,
	})
	out, err := handleHTTPRequestFromJSON(line)
	if err != nil {
		t.Fatal(err)
	}
	if out.Error != nil || out.StatusCode != 200 {
		t.Fatalf("status %d error %v", out.StatusCode, out.Error)
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.HasPrefix(gotHost, "cupnet-dial.invalid") || gotSNI != "cupnet-dial.invalid" {
		t.Fatalf("Host %q SNI %q — the hostname must reach the origin", gotHost, gotSNI)
	}
	if gotProto != 2 {
		t.Fatalf("proto %d, want HTTP/2", gotProto)
	}
}
