package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
)

var (
	clearing       atomic.Bool
	httpInflight   atomic.Int64
	clearWaiters   []func()
	clearWaitersMu sync.Mutex
)

func waitIfClearing() {
	for clearing.Load() {
		done := make(chan struct{})
		clearWaitersMu.Lock()
		clearWaiters = append(clearWaiters, func() { close(done) })
		clearWaitersMu.Unlock()
		<-done
	}
}

func finishClearing() {
	clearing.Store(false)
	clearWaitersMu.Lock()
	waiters := clearWaiters
	clearWaiters = nil
	clearWaitersMu.Unlock()
	for _, fn := range waiters {
		fn()
	}
}

func waitZeroInflight() {
	for httpInflight.Load() > 0 {
		time.Sleep(50 * time.Millisecond)
	}
}

func startParentWatchdog() {
	if os.Getenv("CUPNET_WORKER_NO_WATCHDOG") == "1" {
		return
	}
	parentPid := os.Getppid()
	if parentPid <= 1 {
		return
	}
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			if os.Getppid() == 1 {
				os.Exit(0)
			}
			if err := syscall.Kill(parentPid, 0); err != nil {
				os.Exit(0)
			}
		}
	}()
}

func sendLine(v any) {
	outMu.Lock()
	defer outMu.Unlock()
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[azuretls-go] encode: %v\n", err)
		return
	}
	if _, err := stdoutBuf.Write(append(b, '\n')); err != nil {
		fmt.Fprintf(os.Stderr, "[azuretls-go] write: %v\n", err)
		return
	}
	if err := stdoutBuf.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "[azuretls-go] flush: %v\n", err)
	}
}

var (
	outMu    sync.Mutex
	stdoutBuf *bufio.Writer
)

func main() {
	stdoutBuf = bufio.NewWriter(os.Stdout)
	defer stdoutBuf.Flush()

	startParentWatchdog()

	sendLine(map[string]any{"id": "__init__", "status": "ready"})

	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for range t.C {
			evictIdleClients()
		}
	}()

	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		line = trimNewline(line)
		if len(line) == 0 {
			continue
		}

		var raw map[string]json.RawMessage
		if err := json.Unmarshal(line, &raw); err != nil {
			sendLine(map[string]any{"id": nil, "error": "Invalid JSON"})
			continue
		}
		idBytes, ok := raw["id"]
		if !ok {
			sendLine(map[string]any{"id": nil, "error": "missing id"})
			continue
		}
		var id string
		_ = json.Unmarshal(idBytes, &id)

		switch id {
		case "__clear_sessions__":
			clearing.Store(true)
			waitZeroInflight()
			closeAllPoolClients()
			finishClearing()
			sendLine(map[string]any{"id": "__clear_sessions__", "status": "ok", "cleared": true})
			continue
		case "__get_profiles__":
			prof := make(map[string]any)
			for k, v := range browserProfiles {
				prof[k] = map[string]string{
					"browser":   v.Browser,
					"userAgent": v.UserAgent,
					"http2":     v.HTTP2,
					"desc":      v.Desc,
				}
			}
			sendLine(map[string]any{"id": "__get_profiles__", "profiles": prof})
			continue
		}

		lineCopy := append([]byte(nil), line...)
		go func(payload []byte) {
			waitIfClearing()
			httpInflight.Add(1)
			defer httpInflight.Add(-1)

			var in incomingLine
			if err := json.Unmarshal(payload, &in); err != nil {
				sendLine(map[string]any{"id": id, "statusCode": 0, "bodyBase64": "", "headers": map[string]string{}, "error": err.Error()})
				return
			}
			out := handleHTTPRequest(&in)
			sendLine(out)
		}(lineCopy)
	}

	clearing.Store(true)
	waitZeroInflight()
	closeAllPoolClients()
	finishClearing()
	os.Exit(0)
}

func trimNewline(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// Ensure azuretls is referenced (browserProfiles uses presets via sessionBrowserName).
var _ = azuretls.Chrome
