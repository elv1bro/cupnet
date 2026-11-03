package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
	http "github.com/Noooste/fhttp"
)

// Streaming responses — used when the MITM sets `"stream": true` on a request (Node side:
// CUPNET_MITM_STREAM=1). Instead of reading the whole body and sending it base64-encoded in one
// NDJSON line, the worker forwards the upstream body as it arrives. Frames on stdout, each written
// atomically under outMu so frames of concurrent streams interleave but never tear:
//
//	{"id":ID,"stream":"head","statusCode":N,"headers":{...}}\n
//	{"id":ID,"chunk":N}\n<N raw bytes>
//	{"id":ID,"stream":"end"}\n                 (or with "error":"..." when the body failed)
//
// The body is decoded exactly like the buffered path (gzip/br/deflate/zstd → plain, Content-Encoding
// dropped); see decodedStreamBody. Node strips Content-Length and sends chunked to the browser.
// When the request fails before headers arrive, a normal (buffered) response line is sent instead,
// so Node must accept either a stream head or a full response for a stream request.
//
// Control lines on stdin: {"id":"__stream_ctl__","target":ID,"op":"cancel"|"pause"|"resume"}.
// "pause"/"resume" give per-stream backpressure (a slow browser socket must not grow Node's memory);
// "cancel" stops the upstream download when the browser goes away.

const streamChunkSize = 64 * 1024

var errStreamCancelled = errors.New("stream cancelled")
var errStreamIdle = errors.New("stream idle timeout")

// streamIdleTimeoutMs bounds upstream inactivity while reading a streamed body (the whole transfer
// may take longer — e.g. a large download — as long as bytes keep arriving). Paused time is excluded.
func streamIdleTimeoutMs() int {
	return envInt("CUPNET_STREAM_IDLE_TIMEOUT_MS", 60000, 1000, 600000)
}

type streamCtl struct {
	cancel   context.CancelFunc
	mu       sync.Mutex
	cond     *sync.Cond
	paused   bool
	done     bool
	timedOut bool
}

func newStreamCtl(cancel context.CancelFunc) *streamCtl {
	c := &streamCtl{cancel: cancel}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *streamCtl) setPaused(p bool) {
	c.mu.Lock()
	c.paused = p
	c.mu.Unlock()
	c.cond.Broadcast()
}

// stop cancels the upstream request and releases a paused reader.
func (c *streamCtl) stop() {
	c.mu.Lock()
	c.done = true
	c.paused = false
	c.mu.Unlock()
	c.cond.Broadcast()
	c.cancel()
}

func (c *streamCtl) idleFired() {
	c.mu.Lock()
	c.timedOut = true
	c.mu.Unlock()
	c.cancel()
}

// waitWhilePaused blocks while the stream is paused; false means the stream was stopped.
func (c *streamCtl) waitWhilePaused() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for c.paused && !c.done {
		c.cond.Wait()
	}
	return !c.done
}

func (c *streamCtl) state() (done, timedOut bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.done, c.timedOut
}

var (
	streamsMu sync.Mutex
	streams   = map[string]*streamCtl{}
)

func registerStream(id string, c *streamCtl) {
	streamsMu.Lock()
	streams[id] = c
	streamsMu.Unlock()
}

func unregisterStream(id string) {
	streamsMu.Lock()
	delete(streams, id)
	streamsMu.Unlock()
}

// handleStreamCtl applies a control op to a live stream; unknown ids are ignored (already finished).
func handleStreamCtl(target, op string) {
	streamsMu.Lock()
	c := streams[target]
	streamsMu.Unlock()
	if c == nil {
		return
	}
	switch op {
	case "cancel":
		c.stop()
	case "pause":
		c.setPaused(true)
	case "resume":
		c.setPaused(false)
	}
}

// writeFrame writes a header line plus an optional raw payload as one atomic unit on stdout.
func writeFrame(header []byte, payload []byte) {
	outMu.Lock()
	defer outMu.Unlock()
	if _, err := stdoutBuf.Write(header); err != nil {
		fmt.Fprintf(os.Stderr, "[azuretls-go] stream write: %v\n", err)
		return
	}
	if err := stdoutBuf.WriteByte('\n'); err != nil {
		return
	}
	if len(payload) > 0 {
		if _, err := stdoutBuf.Write(payload); err != nil {
			fmt.Fprintf(os.Stderr, "[azuretls-go] stream write: %v\n", err)
			return
		}
	}
	if err := stdoutBuf.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "[azuretls-go] stream flush: %v\n", err)
	}
}

func writeJSONFrame(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[azuretls-go] stream encode: %v\n", err)
		return
	}
	writeFrame(b, nil)
}

// discardSession drops a session suspected broken (mirrors the conn-error path in handleHTTPRequest).
func discardSession(pkey string, sess *azuretls.Session) {
	if sess == nil {
		return
	}
	sess.Close()
	poolsMu.Lock()
	if p := pools[pkey]; p != nil {
		p.inUse--
	}
	poolsMu.Unlock()
}

// streamSlotReleaseMs: after this long a streamed body stops counting against the pool's
// concurrency budget (CUPNET_WORKER_FFI_CONCURRENCY). A long download or media stream would otherwise
// hold one of the tab's slots for its whole lifetime and starve the tab's other requests.
func streamSlotReleaseMs() int {
	return envInt("CUPNET_STREAM_SLOT_RELEASE_MS", 3000, 50, 600000)
}

// poolSlot tracks whether a streaming request still holds its pool slot.
type poolSlot struct {
	mu   sync.Mutex
	key  string
	held bool
}

// release gives the slot back early (idempotent); the session keeps streaming outside the budget.
func (s *poolSlot) release() {
	s.mu.Lock()
	if !s.held {
		s.mu.Unlock()
		return
	}
	s.held = false
	s.mu.Unlock()
	releasePoolSlot(s.key)
}

// take reports whether the slot is still held, and consumes it either way.
func (s *poolSlot) take() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	held := s.held
	s.held = false
	return held
}

// decodedStreamBody returns the response body decoded the same way the buffered path does it
// (azuretls ReadBody → DecodeResponseBody). fhttp already decodes HTTP/1.1 bodies itself and drops
// Content-Encoding; over HTTP/2 the body is still encoded and the header is kept, so decode here
// (streaming readers) and drop the header. An unknown encoding is passed through with its header
// intact so the browser can still handle it.
func decodedStreamBody(resp *azuretls.Response) io.ReadCloser {
	if resp.RawBody == nil {
		return nil
	}
	ce := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding")))
	switch ce {
	case "gzip", "br", "deflate", "zstd":
		resp.Header.Del("Content-Encoding")
		resp.Header.Del("Content-Length")
		return http.DecompressBodyByType(resp.RawBody, ce)
	}
	return resp.RawBody
}

// pumpBody copies body to stdout as chunk frames until EOF, cancel, idle timeout or read error.
func pumpBody(ctl *streamCtl, body io.Reader, idJSON []byte) error {
	if body == nil {
		return nil
	}
	idle := time.Duration(streamIdleTimeoutMs()) * time.Millisecond
	timer := time.AfterFunc(idle, ctl.idleFired)
	timer.Stop()
	defer timer.Stop()

	prefix := append(append([]byte(`{"id":`), idJSON...), []byte(`,"chunk":`)...)
	buf := make([]byte, streamChunkSize)
	for {
		if !ctl.waitWhilePaused() {
			return errStreamCancelled
		}
		timer.Reset(idle)
		n, err := body.Read(buf)
		timer.Stop()
		if n > 0 {
			hdr := append(append([]byte(nil), prefix...), strconv.Itoa(n)...)
			hdr = append(hdr, '}')
			writeFrame(hdr, buf[:n])
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			if done, timedOut := ctl.state(); done {
				return errStreamCancelled
			} else if timedOut {
				return errStreamIdle
			}
			return err
		}
	}
}

// handleHTTPStream runs one upstream request and streams its body (see the file comment).
func handleHTTPStream(in *incomingLine) {
	id := in.ID
	if id == "" {
		sendLine(outgoingLine{ID: id, Error: "missing id"})
		return
	}
	isIdem := isIdempotentMethod(in.Method)
	factory := sessionFactoryFor(in)

	sess, pkey, err := borrowByKey(requestPoolKey(in), factory)
	if err != nil {
		sendLine(outgoingLine{ID: id, Headers: map[string]any{}, Error: err.Error()})
		return
	}
	if in.Ja3 != nil && strings.TrimSpace(*in.Ja3) != "" {
		nav := navigatorForJa3(derefString(in.Browser, "chrome"))
		if err := sess.ApplyJa3(strings.TrimSpace(*in.Ja3), nav); err != nil {
			fmt.Fprintf(os.Stderr, "[azuretls-go] ApplyJa3 (stream): %v\n", err)
		}
	}

	req, err := buildAzureRequest(in, false)
	if err != nil {
		releaseSession(pkey, sess)
		sendLine(outgoingLine{ID: id, Headers: map[string]any{}, Error: err.Error()})
		return
	}
	// IgnoreBody: azuretls leaves resp.RawBody open and applies no deadline context, so we own
	// the timeouts: one until headers arrive, then an idle timeout per read (pumpBody).
	req.IgnoreBody = true
	ctx, cancel := context.WithCancel(context.Background())
	req.SetContext(ctx)
	headerTimer := time.AfterFunc(req.TimeOut, cancel)

	resp, err := doRequest(sess, req)
	headerTimer.Stop()
	if err != nil {
		cancel()
		if isConnErr(err) && isIdem {
			// Same recovery as the buffered path (fresh session, then bare fallback) — reply buffered.
			discardSession(pkey, sess)
			sendLine(handleHTTPRequest(in))
			return
		}
		// Non-conn error here means the request failed before any body (often the header-phase
		// timeout, which cancelled the request mid-flight): the connection is suspect, so drop it
		// instead of returning it to the idle pool.
		discardSession(pkey, sess)
		sendLine(outgoingLine{ID: id, Headers: map[string]any{}, Error: err.Error()})
		return
	}

	ctl := newStreamCtl(cancel)
	registerStream(id, ctl)
	defer unregisterStream(id)

	body := decodedStreamBody(resp)
	writeJSONFrame(map[string]any{
		"id":         id,
		"stream":     "head",
		"statusCode": resp.StatusCode,
		"headers":    headersToMap(resp.Header),
	})

	idJSON, _ := json.Marshal(id)
	slot := &poolSlot{key: pkey, held: true}
	slotTimer := time.AfterFunc(time.Duration(streamSlotReleaseMs())*time.Millisecond, slot.release)
	streamErr := pumpBody(ctl, body, idJSON)
	slotTimer.Stop()
	if body != nil {
		_ = body.Close()
	}
	cancel()

	end := map[string]any{"id": id, "stream": "end"}
	if streamErr != nil {
		end["error"] = streamErr.Error()
	}
	writeJSONFrame(end)

	// A cancelled/idle stream just aborted one request; the session's transport discards the
	// broken connection itself, so the session stays reusable. Only real connection errors mark it bad.
	badConn := streamErr != nil && !errors.Is(streamErr, errStreamCancelled) && !errors.Is(streamErr, errStreamIdle) && isConnErr(streamErr)
	if slot.take() {
		if badConn {
			discardSession(pkey, sess)
		} else {
			releaseSession(pkey, sess)
		}
		return
	}
	// The slot was already given up: the session is outside the pool's accounting.
	if badConn {
		sess.Close()
	} else {
		reinsertFreshSession(pkey, sess)
	}
}
