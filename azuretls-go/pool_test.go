package main

import (
	"strings"
	"testing"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
)

func TestPoolJa3Segment(t *testing.T) {
	if got := poolJa3Segment(nil); got != "t" {
		t.Fatalf("nil ja3: got %q", got)
	}
	empty := ""
	if got := poolJa3Segment(&empty); got != "t" {
		t.Fatalf("empty ja3: got %q", got)
	}
	s := "771,4865-4867-..."
	if got := poolJa3Segment(&s); got != "j:"+s {
		t.Fatalf("non-empty ja3: got %q", got)
	}
}

func TestPoolKey(t *testing.T) {
	b := "chrome"
	px := "http://127.0.0.1:8080"
	ja := "771,x"
	tab := "tab_1"
	got := poolKey(&b, &px, &ja, &tab)
	want := "chrome::http://127.0.0.1:8080::j:771,x::tab:tab_1"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}

	got = poolKey(nil, nil, nil, nil)
	want = "chrome::::t::tab:__shared__"
	if got != want {
		t.Fatalf("defaults: got %q want %q", got, want)
	}
}

func TestWorkerFfiConcurrencyEnv(t *testing.T) {
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "12")
	if got := workerFfiConcurrency(); got != 12 {
		t.Fatalf("got %d want 12", got)
	}
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "")
	if got := workerFfiConcurrency(); got != 4 {
		t.Fatalf("default: got %d want 4", got)
	}
}

func TestWorkerClientCacheMaxEnv(t *testing.T) {
	t.Setenv("CUPNET_WORKER_CLIENT_CACHE_MAX", "99")
	if got := workerClientCacheMax(); got != 99 {
		t.Fatalf("got %d want 99", got)
	}
}

func testFactory() func() (*azuretls.Session, error) {
	return func() (*azuretls.Session, error) {
		return azuretls.NewSession(), nil
	}
}

func TestBorrowReleaseCycle(t *testing.T) {
	closeAllPoolClients()
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "4")
	b := "chrome"
	tid := "tab-cycle"
	s1, key, err := borrowSession(&b, nil, nil, &tid, testFactory())
	if err != nil {
		t.Fatal(err)
	}
	releaseSession(key, s1)
	s2, key2, err := borrowSession(&b, nil, nil, &tid, testFactory())
	if err != nil {
		t.Fatal(err)
	}
	if key != key2 {
		t.Fatalf("pool key mismatch")
	}
	if s1 != s2 {
		t.Fatal("expected same pooled session (LIFO idle)")
	}
	releaseSession(key2, s2)
}

func TestBorrowConcurrencyLimit(t *testing.T) {
	closeAllPoolClients()
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "2")
	b := "chrome"
	tid := "tab-conc"
	tab := &tid
	s1, key, err := borrowSession(&b, nil, nil, tab, testFactory())
	if err != nil {
		t.Fatal(err)
	}
	s2, _, err := borrowSession(&b, nil, nil, tab, testFactory())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var s3 *azuretls.Session
	var err3 error
	go func() {
		s3, _, err3 = borrowSession(&b, nil, nil, tab, testFactory())
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("third borrow should block when pool is at capacity")
	case <-time.After(80 * time.Millisecond):
	}
	releaseSession(key, s1)
	<-done
	if err3 != nil {
		t.Fatal(err3)
	}
	if s3 == nil {
		t.Fatal("expected session from waiter")
	}
	releaseSession(key, s2)
	releaseSession(key, s3)
}

func TestBorrowAbortOnClearing(t *testing.T) {
	closeAllPoolClients()
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "1")
	b := "chrome"
	tid := "tab-abort"
	tab := &tid
	s1, key, err := borrowSession(&b, nil, nil, tab, testFactory())
	if err != nil {
		t.Fatal(err)
	}
	errCh := make(chan error, 1)
	go func() {
		_, _, err2 := borrowSession(&b, nil, nil, tab, testFactory())
		errCh <- err2
	}()
	time.Sleep(80 * time.Millisecond)
	closeAllPoolClients()
	err2 := <-errCh
	if err2 == nil || !strings.Contains(err2.Error(), "worker clearing") {
		t.Fatalf("expected worker clearing error, got %v", err2)
	}
	releaseSession(key, s1)
}

func TestEvictIdleClients(t *testing.T) {
	closeAllPoolClients()
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "4")
	b := "chrome"
	tid := "tab-idle"
	tab := &tid
	s1, key, err := borrowSession(&b, nil, nil, tab, testFactory())
	if err != nil {
		t.Fatal(err)
	}
	releaseSession(key, s1)
	poolsMu.Lock()
	poolLastActivity[key] = time.Now().Add(-30 * time.Second)
	poolsMu.Unlock()
	evictIdleClients()
	poolsMu.Lock()
	_, ok := pools[key]
	poolsMu.Unlock()
	if ok {
		t.Fatal("expected pool evicted after idle TTL")
	}
}

func TestEvictPoolsIfNeeded(t *testing.T) {
	closeAllPoolClients()
	t.Setenv("CUPNET_WORKER_CLIENT_CACHE_MAX", "2")
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "4")
	b := "chrome"
	t1, t2, t3 := "tab-e1", "tab-e2", "tab-e3"
	for _, tid := range []string{t1, t2, t3} {
		tab := tid
		s, key, err := borrowSession(&b, nil, nil, &tab, testFactory())
		if err != nil {
			t.Fatal(err)
		}
		releaseSession(key, s)
	}
	evictPoolsIfNeeded()
	k1 := poolKey(&b, nil, nil, &t1)
	poolsMu.Lock()
	_, has1 := pools[k1]
	n := len(pools)
	poolsMu.Unlock()
	if has1 {
		t.Fatal("oldest LRU pool should be evicted")
	}
	if n != 2 {
		t.Fatalf("expected 2 pools left, got %d", n)
	}
}

func TestTouchPoolKeyLRU(t *testing.T) {
	closeAllPoolClients()
	touchPoolKey("A")
	touchPoolKey("B")
	touchPoolKey("C")
	touchPoolKey("A")
	poolsMu.Lock()
	defer poolsMu.Unlock()
	if len(poolLRU) != 3 {
		t.Fatalf("LRU len %d", len(poolLRU))
	}
	if poolLRU[0] != "B" || poolLRU[1] != "C" || poolLRU[2] != "A" {
		t.Fatalf("LRU order: %v", poolLRU)
	}
}

func TestReleaseToWaiter(t *testing.T) {
	closeAllPoolClients()
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "1")
	b := "chrome"
	tid := "tab-wait"
	tab := &tid
	s1, key, err := borrowSession(&b, nil, nil, tab, testFactory())
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan *azuretls.Session, 1)
	go func() {
		s, _, err2 := borrowSession(&b, nil, nil, tab, testFactory())
		if err2 != nil {
			t.Error(err2)
		}
		got <- s
	}()
	time.Sleep(80 * time.Millisecond)
	releaseSession(key, s1)
	s2 := <-got
	if s2 != s1 {
		t.Fatal("waiter should receive released session")
	}
	releaseSession(key, s2)
}

func TestReleaseNilSession(t *testing.T) {
	closeAllPoolClients()
	releaseSession("any", nil)
}

func TestCloseAllPoolClients(t *testing.T) {
	closeAllPoolClients()
	t.Setenv("CUPNET_WORKER_FFI_CONCURRENCY", "2")
	b := "chrome"
	tid := "tab-close"
	s, key, err := borrowSession(&b, nil, nil, &tid, testFactory())
	if err != nil {
		t.Fatal(err)
	}
	releaseSession(key, s)
	closeAllPoolClients()
	poolsMu.Lock()
	n := len(pools)
	l := len(poolLRU)
	poolsMu.Unlock()
	if n != 0 || l != 0 {
		t.Fatalf("pools=%d lru=%d", n, l)
	}
}

