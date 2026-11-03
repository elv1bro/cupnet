package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
	http "github.com/Noooste/fhttp"
)

// connErrPattern marks errors that mean the underlying connection is unusable, so an idempotent
// request should retry on a fresh one instead of surfacing the error. Besides the plain socket
// failures it also matches connection-desync errors: when a pooled keep-alive connection is reused
// after the upstream (or a sticky proxy that just rotated its exit) silently dropped it, Go reads
// leftover bytes where a status line belongs and reports `transport connection broken: malformed
// HTTP status code "…"`, or `unexpected EOF`, or `use of closed network connection`. Those are not
// origin errors — a fresh connection recovers them.
var connErrPattern = regexp.MustCompile(`(?i)\bEOF\b|connection reset|ECONNRESET|ETIMEDOUT|ECONNREFUSED|broken pipe|transport connection broken|malformed HTTP|use of closed`)

func upstreamTimeoutMs() int {
	return envInt("CUPNET_TIMEOUT_UPSTREAM_REQUEST_MS", 30000, 1000, 600000)
}

func createPooledSession(browser, proxy *string, ja3 *string) (*azuretls.Session, error) {
	prof := "chrome"
	if browser != nil && strings.TrimSpace(*browser) != "" {
		prof = strings.TrimSpace(*browser)
	}
	s := azuretls.NewSession()
	s.Browser = sessionBrowserName(prof)
	// Chrome 153-shaped ClientHello (see profiles.go); ApplyJa3 below overrides it when a JA3 is set.
	if fn := clientHelloSpecForBrowser(s.Browser); fn != nil {
		s.GetClientHelloSpec = fn
	}
	s.UserAgent = defaultUserAgentForBrowser(prof)
	s.InsecureSkipVerify = true
	s.SetTimeout(time.Duration(upstreamTimeoutMs()) * time.Millisecond)

	if proxy != nil && strings.TrimSpace(*proxy) != "" {
		if err := s.SetProxy(strings.TrimSpace(*proxy)); err != nil {
			s.Close()
			return nil, err
		}
	}

	if h2 := http2FingerprintForBrowser(prof); h2 != "" {
		if err := s.ApplyHTTP2(h2); err != nil {
			s.Close()
			return nil, err
		}
	}

	if ja3 != nil && strings.TrimSpace(*ja3) != "" {
		nav := navigatorForJa3(prof)
		if err := s.ApplyJa3(strings.TrimSpace(*ja3), nav); err != nil {
			// Match JS: log but continue
			fmt.Fprintf(os.Stderr, "[azuretls-go] ApplyJa3: %v\n", err)
		}
	}

	return s, nil
}

// headersToMap flattens response headers for the NDJSON reply. Repeated headers are joined with ", "
// (valid for list-valued headers) — except Set-Cookie, which must never be comma-joined (its Expires
// attribute contains commas, so a browser cannot split it back and every cookie after the first is
// lost). Repeated Set-Cookie values are sent as a JSON array; Node writes one header line per value.
func headersToMap(h http.Header) map[string]any {
	if h == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(h))
	for k, vals := range h {
		if len(vals) == 0 {
			continue
		}
		// Preserve canonical-ish keys as returned by server
		switch {
		case len(vals) == 1:
			out[k] = vals[0]
		case strings.EqualFold(k, "Set-Cookie"):
			out[k] = append([]string(nil), vals...)
		default:
			out[k] = strings.Join(vals, ", ")
		}
	}
	return out
}

// incomingLine matches the JSON line from mitm / azure-tls-worker.
type incomingLine struct {
	ID               string              `json:"id"`
	Method           string              `json:"method"`
	URL              string              `json:"url"`
	Headers          map[string]string   `json:"headers"`
	OrderedHeaders   json.RawMessage     `json:"orderedHeaders"`
	Body             *string             `json:"body"`
	BodyBase64       *string             `json:"bodyBase64"`
	Proxy            *string             `json:"proxy"`
	Browser          *string             `json:"browser"`
	Ja3              *string             `json:"ja3"`
	DisableRedirects *bool               `json:"disableRedirects"`
	ForceHTTP1       *bool               `json:"forceHttp1"`
	Stream           *bool               `json:"stream"` // stream the body as frames (stream.go)
	TabID            *string             `json:"tabId"`
	MaxRetries       *float64            `json:"maxRetries"`
	Timeout          *float64            `json:"timeout"`
	ConnectTo        *string             `json:"connectTo"` // dial this IP instead of resolving the host (connect_to.go)
}

type outgoingLine struct {
	ID         string            `json:"id"`
	StatusCode int               `json:"statusCode"`
	BodyBase64 string            `json:"bodyBase64,omitempty"`
	Headers    map[string]any    `json:"headers,omitempty"`
	Error      any               `json:"error"` // string or nil (matches Node worker)
	Body       interface{}       `json:"body,omitempty"`
	Status     string            `json:"status,omitempty"`
	Cleared    *bool             `json:"cleared,omitempty"`
	Profiles   map[string]any    `json:"profiles,omitempty"`
}

func parseOrderedHeaders(raw json.RawMessage) (azuretls.OrderedHeaders, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var arr [][]string
	if err := json.Unmarshal(raw, &arr); err == nil && len(arr) > 0 {
		return azuretls.OrderedHeaders(arr), nil
	}
	// tolerate [["k","v"], ...] as []interface{}
	var generic []any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, err
	}
	var oh azuretls.OrderedHeaders
	for _, row := range generic {
		pair, ok := row.([]any)
		if !ok || len(pair) < 2 {
			continue
		}
		k, _ := pair[0].(string)
		v, _ := pair[1].(string)
		oh = append(oh, []string{k, v})
	}
	if len(oh) == 0 {
		return nil, nil
	}
	return oh, nil
}

func buildAzureRequest(in *incomingLine, bare bool) (*azuretls.Request, error) {
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if method == "" {
		method = http.MethodGet
	}
	req := &azuretls.Request{
		Method: method,
		Url:    in.URL,
		// Chromium owns cookies: it sends them in the Cookie header and stores Set-Cookie itself.
		// The session's own jar would otherwise record upstream cookies and append them to every
		// later request — clearing cookies in the browser would not stop them being sent (A-014).
		NoCookie: true,
	}
	ms := upstreamTimeoutMs()
	if in.Timeout != nil && *in.Timeout > 0 {
		ms = int(*in.Timeout)
	}
	req.TimeOut = time.Duration(ms) * time.Millisecond

	if in.ForceHTTP1 != nil && *in.ForceHTTP1 {
		req.ForceHTTP1 = true
	}

	if in.DisableRedirects != nil && *in.DisableRedirects {
		req.DisableRedirects = true
		req.MaxRedirects = 0
	}

	if bare {
		return req, nil
	}

	oh, err := parseOrderedHeaders(in.OrderedHeaders)
	if err != nil {
		return nil, err
	}
	if len(oh) > 0 {
		req.OrderedHeaders = oh
	} else if in.Headers != nil && len(in.Headers) > 0 {
		h := make(http.Header)
		for k, v := range in.Headers {
			h.Set(k, v)
		}
		req.Header = h
	}

	if in.BodyBase64 != nil && strings.TrimSpace(*in.BodyBase64) != "" {
		plain, err := base64.StdEncoding.DecodeString(strings.TrimSpace(*in.BodyBase64))
		if err != nil {
			return nil, err
		}
		req.Body = plain
	} else if in.Body != nil && *in.Body != "" {
		req.Body = *in.Body
	}

	return req, nil
}

func isIdempotentMethod(m string) bool {
	switch strings.ToUpper(strings.TrimSpace(m)) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

func isConnErr(err error) bool {
	if err == nil {
		return false
	}
	return connErrPattern.MatchString(err.Error())
}

func doRequest(s *azuretls.Session, req *azuretls.Request) (*azuretls.Response, error) {
	return s.Do(req)
}

func responseToOutgoing(resp *azuretls.Response) outgoingLine {
	out := outgoingLine{
		StatusCode: resp.StatusCode,
		Headers:    headersToMap(resp.Header),
	}
	if resp.Body != nil {
		out.BodyBase64 = base64.StdEncoding.EncodeToString(resp.Body)
	}
	return out
}

func handleHTTPRequest(in *incomingLine) outgoingLine {
	id := in.ID
	if id == "" {
		return outgoingLine{ID: id, StatusCode: 0, Error: "missing id"}
	}

	retryLimit := 0
	if in.MaxRetries != nil {
		retryLimit = int(*in.MaxRetries)
		if retryLimit < 0 {
			retryLimit = 0
		}
	}
	_ = retryLimit // outer loop mirrors JS (unused); inner logic handles retries

	isIdem := isIdempotentMethod(in.Method)

	factory := sessionFactoryFor(in)

	sess, pkey, err := borrowByKey(requestPoolKey(in), factory)
	if err != nil {
		e := err.Error()
		return outgoingLine{ID: id, StatusCode: 0, Body: nil, Headers: map[string]any{}, Error: e}
	}

	if in.Ja3 != nil && strings.TrimSpace(*in.Ja3) != "" {
		nav := navigatorForJa3(derefString(in.Browser, "chrome"))
		if err := sess.ApplyJa3(strings.TrimSpace(*in.Ja3), nav); err != nil {
			fmt.Fprintf(os.Stderr, "[azuretls-go] ApplyJa3 (borrow): %v\n", err)
		}
	}

	req, err := buildAzureRequest(in, false)
	if err != nil {
		releaseSession(pkey, sess)
		return outgoingLine{ID: id, StatusCode: 0, Body: nil, Headers: map[string]any{}, Error: err.Error()}
	}

	resp, err := doRequest(sess, req)
	if err != nil && isConnErr(err) && isIdem {
		if sess != nil {
			sess.Close()
			poolsMu.Lock()
			p := pools[pkey]
			if p != nil {
				p.inUse--
			}
			poolsMu.Unlock()
		}

		// Fresh session retry with full headers
		fresh, errFresh := factory()
		if errFresh == nil {
			req2, rerr := buildAzureRequest(in, false)
			if rerr == nil {
				resp2, err2 := doRequest(fresh, req2)
				if err2 == nil {
					out := responseToOutgoing(resp2)
					out.ID = id
					out.Error = nil
					reinsertFreshSession(pkey, fresh)
					return out
				}
				fresh.Close()
			} else {
				fresh.Close()
			}
		}

		// Bare fallback
		bare, errBare := factory()
		if errBare != nil {
			return outgoingLine{ID: id, StatusCode: 0, Body: nil, Headers: map[string]any{}, Error: errBare.Error()}
		}
		reqBare, rerr := buildAzureRequest(in, true)
		if rerr != nil {
			bare.Close()
			return outgoingLine{ID: id, StatusCode: 0, Body: nil, Headers: map[string]any{}, Error: rerr.Error()}
		}
		resp3, err3 := doRequest(bare, reqBare)
		bare.Close()
		if err3 != nil {
			return outgoingLine{ID: id, StatusCode: 0, Body: nil, Headers: map[string]any{}, Error: err3.Error()}
		}
		out := responseToOutgoing(resp3)
		out.ID = id
		return out
	}

	if err != nil {
		// A failed upstream request leaves the connection in an unknown state (a timeout can abort
		// mid-body, leaving unread bytes that the next borrower would read as a status line). Drop it
		// rather than returning it to the idle pool, so one failure does not poison every reuse after.
		discardSession(pkey, sess)
		return outgoingLine{ID: id, StatusCode: 0, Body: nil, Headers: map[string]any{}, Error: err.Error()}
	}

	out := responseToOutgoing(resp)
	out.ID = id
	out.Error = nil
	releaseSession(pkey, sess)
	return out
}

func derefString(p *string, def string) string {
	if p == nil || strings.TrimSpace(*p) == "" {
		return def
	}
	return strings.TrimSpace(*p)
}

// handleHTTPRequestFromJSON parses one line and runs handleHTTPRequest (for tests).
func handleHTTPRequestFromJSON(line []byte) (outgoingLine, error) {
	var in incomingLine
	if err := json.Unmarshal(line, &in); err != nil {
		return outgoingLine{}, err
	}
	return handleHTTPRequest(&in), nil
}
