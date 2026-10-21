package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	azuretls "github.com/Noooste/azuretls-client"
	"time"
)

type streamFrame struct {
	hdr  map[string]any
	body []byte
}

// parseFrames decodes the worker's stdout: JSON header lines, each optionally followed by
// `chunk` raw bytes.
func parseFrames(t *testing.T, raw []byte) []streamFrame {
	t.Helper()
	var out []streamFrame
	r := bufio.NewReader(bytes.NewReader(raw))
	for {
		line, err := r.ReadBytes('\n')
		if err == io.EOF && len(line) == 0 {
			return out
		}
		if err != nil && err != io.EOF {
			t.Fatalf("read: %v", err)
		}
		var hdr map[string]any
		if jerr := json.Unmarshal(bytes.TrimRight(line, "\n"), &hdr); jerr != nil {
			t.Fatalf("bad header %q: %v", line, jerr)
		}
		f := streamFrame{hdr: hdr}
		if n, ok := hdr["chunk"].(float64); ok {
			f.body = make([]byte, int(n))
			if _, err := io.ReadFull(r, f.body); err != nil {
				t.Fatalf("short chunk: %v", err)
			}
		}
		out = append(out, f)
	}
}

// captureStdout swaps the worker's stdout writer for a buffer for the duration of the test.
func captureStdout(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := stdoutBuf
	stdoutBuf = bufio.NewWriter(&buf)
	t.Cleanup(func() { stdoutBuf = old })
	return &buf
}

func boolPtr(b bool) *bool { return &b }

// gzipServer serves a large gzip body in several flushes; returns the plain (decoded) bytes.
func gzipHandler(t *testing.T) (http.HandlerFunc, []byte) {
	t.Helper()
	var plain bytes.Buffer
	for i := 0; i < 20000; i++ {
		plain.WriteString("cupnet streaming line " + strconv.Itoa(i) + "\n")
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(plain.Bytes())
	_ = zw.Close()
	wire := gz.Bytes()
	h := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		for off := 0; off < len(wire); off += 7000 {
			end := off + 7000
			if end > len(wire) {
				end = len(wire)
			}
			_, _ = w.Write(wire[off:end])
			fl.Flush()
		}
	}
	return h, plain.Bytes()
}

// assertDecodedStream checks head → chunks → end and that the reassembled body is the decoded
// plain text with Content-Encoding dropped (same contract as the buffered path).
func assertDecodedStream(t *testing.T, id string, raw []byte, want []byte) {
	t.Helper()
	frames := parseFrames(t, raw)
	if len(frames) < 3 {
		t.Fatalf("want head+chunks+end, got %d frames", len(frames))
	}
	head := frames[0].hdr
	if head["stream"] != "head" || head["statusCode"].(float64) != 200 {
		t.Fatalf("bad head frame: %v", head)
	}
	if h, _ := head["headers"].(map[string]any); h["Content-Encoding"] != nil || h["Content-Length"] != nil {
		t.Fatalf("decoded stream must drop Content-Encoding/Content-Length, got %v", head["headers"])
	}
	var got bytes.Buffer
	for _, f := range frames[1 : len(frames)-1] {
		if f.hdr["id"] != id {
			t.Fatalf("chunk for wrong id: %v", f.hdr)
		}
		got.Write(f.body)
	}
	last := frames[len(frames)-1].hdr
	if last["stream"] != "end" || last["error"] != nil {
		t.Fatalf("bad end frame: %v", last)
	}
	if !bytes.Equal(got.Bytes(), want) {
		t.Fatalf("streamed body differs from decoded upstream: got %d bytes want %d", got.Len(), len(want))
	}
}

func TestHandleHTTPStreamHTTP1DecodesBody(t *testing.T) {
	h, plain := gzipHandler(t)
	srv := httptest.NewServer(h)
	defer srv.Close()

	out := captureStdout(t)
	handleHTTPStream(&incomingLine{
		ID: "s1", Method: "GET", URL: srv.URL + "/big",
		Headers:          map[string]string{"Accept-Encoding": "gzip, deflate, br, zstd"},
		DisableRedirects: boolPtr(true), Stream: boolPtr(true),
	})
	_ = stdoutBuf.Flush()
	assertDecodedStream(t, "s1", out.Bytes(), plain)
}

func TestHandleHTTPStreamHTTP2DecodesBody(t *testing.T) {
	// Over HTTP/2 fhttp leaves the body encoded (h2 transport has DisableCompression), so the
	// stream path must decode it itself — this is the case buffered ReadBody used to cover.
	h, plain := gzipHandler(t)
	srv := httptest.NewUnstartedServer(h)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()

	out := captureStdout(t)
	handleHTTPStream(&incomingLine{
		ID: "s3", Method: "GET", URL: srv.URL + "/big",
		Headers:          map[string]string{"Accept-Encoding": "gzip, deflate, br, zstd"},
		DisableRedirects: boolPtr(true), Stream: boolPtr(true),
	})
	_ = stdoutBuf.Flush()
	frames := parseFrames(t, out.Bytes())
	if len(frames) > 0 && frames[0].hdr["error"] != nil {
		t.Skipf("local TLS/h2 test server unreachable for the Chrome-shaped client: %v", frames[0].hdr["error"])
	}
	assertDecodedStream(t, "s3", out.Bytes(), plain)
}

func TestHandleHTTPStreamCancelStopsDownload(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("first"))
		w.(http.Flusher).Flush()
		select { // hold the body open until the test is done
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	out := captureStdout(t)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		handleHTTPStream(&incomingLine{
			ID: "s2", Method: "GET", URL: srv.URL + "/hang",
			DisableRedirects: boolPtr(true), Stream: boolPtr(true),
		})
	}()

	deadline := time.Now().Add(10 * time.Second)
	for {
		streamsMu.Lock()
		_, live := streams["s2"]
		streamsMu.Unlock()
		if live {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stream never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	handleStreamCtl("s2", "cancel")

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancel did not stop the stream")
	}
	_ = stdoutBuf.Flush()
	frames := parseFrames(t, out.Bytes())
	last := frames[len(frames)-1].hdr
	if last["stream"] != "end" || last["error"] != errStreamCancelled.Error() {
		t.Fatalf("want end with cancel error, got %v", last)
	}
}

func TestStreamCtlPauseBlocksUntilResume(t *testing.T) {
	c := newStreamCtl(func() {})
	c.setPaused(true)
	resumed := make(chan bool, 1)
	go func() { resumed <- c.waitWhilePaused() }()
	select {
	case <-resumed:
		t.Fatal("waitWhilePaused returned while paused")
	case <-time.After(50 * time.Millisecond):
	}
	c.setPaused(false)
	select {
	case ok := <-resumed:
		if !ok {
			t.Fatal("resume reported stopped")
		}
	case <-time.After(time.Second):
		t.Fatal("resume did not wake the reader")
	}
}

func TestLongStreamReleasesPoolSlot(t *testing.T) {
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "1")
	t.Setenv("CUPNET_STREAM_SLOT_RELEASE_MS", "100")
	closeAllPoolClients()
	defer closeAllPoolClients()

	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("chunk"))
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()

	captureStdout(t)
	done := make(chan struct{})
	go func() {
		handleHTTPStream(&incomingLine{ID: "long", Method: "GET", URL: srv.URL + "/media",
			DisableRedirects: boolPtr(true), Stream: boolPtr(true)})
		close(done)
	}()

	// Wait until the stream holds the only slot (its head has been sent).
	deadline := time.Now().Add(10 * time.Second)
	for {
		streamsMu.Lock()
		_, live := streams["long"]
		streamsMu.Unlock()
		if live {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stream never started")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// With a budget of 1, a second borrow on the same pool key must still get through once the
	// long stream has handed its slot back (after CUPNET_STREAM_SLOT_RELEASE_MS).
	started := time.Now()
	got := make(chan error, 1)
	go func() {
		s, key, err := borrowSessionFor(nil, nil, nil, nil, srv.URL+"/other", func() (*azuretls.Session, error) {
			return createPooledSession(nil, nil, nil)
		})
		if err == nil {
			releaseSession(key, s)
		}
		got <- err
	}()
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("borrow failed: %v", err)
		}
		if waited := time.Since(started); waited < 50*time.Millisecond {
			t.Fatalf("borrow did not wait for the slot (%v) — the stream was not holding it", waited)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a long stream kept the only pool slot: second request starved")
	}

	close(release)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("stream did not finish")
	}
	key := poolKey(nil, nil, nil, nil)
	poolsMu.Lock()
	inUse := 0
	if p := pools[key]; p != nil {
		inUse = p.inUse
	}
	poolsMu.Unlock()
	if inUse != 0 {
		t.Fatalf("pool accounting drifted: inUse=%d after all requests finished", inUse)
	}
}
