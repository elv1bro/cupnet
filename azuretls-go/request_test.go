package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	azuretls "github.com/Noooste/azuretls-client"
	http "github.com/Noooste/fhttp"
)

func TestHeadersToMap(t *testing.T) {
	h := http.Header{}
	h.Set("Content-Type", "text/plain")
	h.Add("X-Multi", "a")
	h.Add("X-Multi", "b")
	m := headersToMap(h)
	if m["Content-Type"] != "text/plain" {
		t.Fatalf("Content-Type: %v", m)
	}
	multi := m["X-Multi"]
	if multi == "" || !strings.Contains(multi, "a") || !strings.Contains(multi, "b") {
		t.Fatalf("X-Multi: %q", multi)
	}
	if len(headersToMap(nil)) != 0 {
		t.Fatal("nil header")
	}
}

func TestParseOrderedHeaders(t *testing.T) {
	raw := json.RawMessage(`[["Host","example.com"],["Accept","*/*"]]`)
	oh, err := parseOrderedHeaders(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(oh) != 2 || oh[0][0] != "Host" {
		t.Fatalf("got %#v", oh)
	}
	oh, err = parseOrderedHeaders(nil)
	if err != nil || oh != nil {
		t.Fatalf("nil: %#v err %v", oh, err)
	}
	oh, err = parseOrderedHeaders(json.RawMessage(`null`))
	if err != nil || oh != nil {
		t.Fatalf("null: %#v", oh)
	}
}

func TestBuildAzureRequestBare(t *testing.T) {
	in := &incomingLine{
		ID:     "1",
		Method: "GET",
		URL:    "https://example.com/",
	}
	req, err := buildAzureRequest(in, true)
	if err != nil {
		t.Fatal(err)
	}
	if req.Method != http.MethodGet || req.Url != in.URL {
		t.Fatalf("%#v", req)
	}
}

func TestIsIdempotentMethod(t *testing.T) {
	if !isIdempotentMethod("GET") || !isIdempotentMethod("head") {
		t.Fatal("GET/HEAD idempotent")
	}
	if isIdempotentMethod("POST") {
		t.Fatal("POST not idempotent")
	}
}

func TestIsConnErr(t *testing.T) {
	if !isConnErr(errors.New("read EOF")) {
		t.Fatal("EOF")
	}
	if !isConnErr(errors.New("connection reset by peer")) {
		t.Fatal("reset")
	}
	if isConnErr(nil) {
		t.Fatal("nil")
	}
	if isConnErr(errors.New("bad request")) {
		t.Fatal("non-conn")
	}
}

func TestBuildAzureRequestWithOrderedHeaders(t *testing.T) {
	raw := json.RawMessage(`[["Host","x.example"],["Accept","*/*"]]`)
	in := &incomingLine{
		ID:             "1",
		Method:         "GET",
		URL:            "https://example.com/",
		OrderedHeaders: raw,
	}
	req, err := buildAzureRequest(in, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.OrderedHeaders) != 2 || req.OrderedHeaders[0][0] != "Host" || req.OrderedHeaders[0][1] != "x.example" {
		t.Fatalf("ordered headers: %#v", req.OrderedHeaders)
	}
}

func TestBuildAzureRequestWithMapHeaders(t *testing.T) {
	in := &incomingLine{
		ID:      "1",
		Method:  "GET",
		URL:     "https://example.com/",
		Headers: map[string]string{"X-Test": "1", "Accept": "text/plain"},
	}
	req, err := buildAzureRequest(in, false)
	if err != nil {
		t.Fatal(err)
	}
	if req.Header == nil || req.Header.Get("X-Test") != "1" {
		t.Fatalf("header map: %#v", req.Header)
	}
}

func TestBuildAzureRequestBodyBase64(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString([]byte("hello"))
	in := &incomingLine{
		ID:         "1",
		Method:     "POST",
		URL:        "https://example.com/",
		BodyBase64: &b64,
	}
	req, err := buildAzureRequest(in, false)
	if err != nil {
		t.Fatal(err)
	}
	got := reqBodyString(t, req.Body)
	if got != "hello" {
		t.Fatalf("body %q", got)
	}
}

func TestBuildAzureRequestBodyString(t *testing.T) {
	body := "plain"
	in := &incomingLine{
		ID:     "1",
		Method: "POST",
		URL:    "https://example.com/",
		Body:   &body,
	}
	req, err := buildAzureRequest(in, false)
	if err != nil {
		t.Fatal(err)
	}
	if reqBodyString(t, req.Body) != "plain" {
		t.Fatal(req.Body)
	}
}

func reqBodyString(t *testing.T, body any) string {
	t.Helper()
	switch v := body.(type) {
	case []byte:
		return string(v)
	case string:
		return v
	default:
		t.Fatalf("unexpected body type %T", body)
		return ""
	}
}

func TestBuildAzureRequestTimeout(t *testing.T) {
	t.Setenv("CUPNET_TIMEOUT_UPSTREAM_REQUEST_MS", "30000")
	to := 5000.0
	in := &incomingLine{
		ID:      "1",
		Method:  "GET",
		URL:     "https://example.com/",
		Timeout: &to,
	}
	req, err := buildAzureRequest(in, false)
	if err != nil {
		t.Fatal(err)
	}
	if req.TimeOut.String() != "5s" {
		t.Fatalf("timeout %v", req.TimeOut)
	}
}

func TestBuildAzureRequestDisableRedirects(t *testing.T) {
	dr := true
	in := &incomingLine{
		ID:               "1",
		Method:           "GET",
		URL:              "https://example.com/",
		DisableRedirects: &dr,
	}
	req, err := buildAzureRequest(in, false)
	if err != nil {
		t.Fatal(err)
	}
	if !req.DisableRedirects || req.MaxRedirects != 0 {
		t.Fatalf("redirects: %#v", req)
	}
}

func TestBuildAzureRequestForceHTTP1(t *testing.T) {
	f := true
	in := &incomingLine{
		ID:         "1",
		Method:     "GET",
		URL:        "https://example.com/",
		ForceHTTP1: &f,
	}
	req, err := buildAzureRequest(in, false)
	if err != nil {
		t.Fatal(err)
	}
	if !req.ForceHTTP1 {
		t.Fatal("ForceHTTP1")
	}
}

func TestBuildAzureRequestDefaultMethod(t *testing.T) {
	in := &incomingLine{
		ID:  "1",
		URL: "https://example.com/",
	}
	req, err := buildAzureRequest(in, false)
	if err != nil {
		t.Fatal(err)
	}
	if req.Method != http.MethodGet {
		t.Fatal(req.Method)
	}
}

func TestParseOrderedHeadersGenericPath(t *testing.T) {
	raw := json.RawMessage(`[[1,"Host"],[2,"x"]]`)
	oh, err := parseOrderedHeaders(raw)
	if err != nil {
		t.Fatal(err)
	}
	// JSON numbers do not become string keys; generic path still yields two pairs.
	if len(oh) != 2 || oh[0][1] != "Host" || oh[1][1] != "x" {
		t.Fatalf("generic path: %#v", oh)
	}
}

func TestParseOrderedHeadersInvalidJSON(t *testing.T) {
	_, err := parseOrderedHeaders(json.RawMessage(`not json`))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestUpstreamTimeoutMsEnv(t *testing.T) {
	t.Setenv("CUPNET_TIMEOUT_UPSTREAM_REQUEST_MS", "45000")
	if got := upstreamTimeoutMs(); got != 45000 {
		t.Fatalf("got %d", got)
	}
}

func TestResponseToOutgoing(t *testing.T) {
	h := http.Header{}
	h.Set("Content-Type", "text/plain")
	resp := &azuretls.Response{
		StatusCode: 201,
		Header:     h,
		Body:       []byte("abc"),
	}
	out := responseToOutgoing(resp)
	if out.StatusCode != 201 {
		t.Fatal(out.StatusCode)
	}
	if out.Headers["Content-Type"] != "text/plain" {
		t.Fatal(out.Headers)
	}
	dec, err := base64.StdEncoding.DecodeString(out.BodyBase64)
	if err != nil || string(dec) != "abc" {
		t.Fatalf("body b64: %v %q", err, out.BodyBase64)
	}
}

func TestHandleHTTPRequestMissingID(t *testing.T) {
	out := handleHTTPRequest(&incomingLine{ID: ""})
	if out.Error != "missing id" {
		t.Fatalf("got %#v", out.Error)
	}
}
