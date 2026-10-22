package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
)

const (
	borrowAbort = "cupnet.worker.borrow_abort"
	idleTTL     = 25 * time.Second
)

type clientPool struct {
	idle    []*azuretls.Session
	waiters []chan any // receives *azuretls.Session or borrowAbort string
	inUse   int
}

var (
	poolsMu          sync.Mutex
	pools            = make(map[string]*clientPool)
	poolLRU          []string
	poolLastActivity = make(map[string]time.Time)
)

func envInt(name string, def int, min, max int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// Max concurrent upstream requests per pool (browser::proxy::ja3::tab::origin). Chrome fans out dozens of
// asset requests in parallel; the old default of 4 throttled a whole page to 4 in-flight fetches at a time.
// Raised to 12 after measuring ~2x faster page loads (bbc.com/news loadEvent 11.3s→5.5s). The budget is
// per origin (like Chrome's per-host connection limit), so slow third-party hosts cannot starve the page's
// own requests. Override with CUPNET_WORKER_FFI_CONCURRENCY.
func workerFfiConcurrency() int {
	return envInt("CUPNET_WORKER_FFI_CONCURRENCY", 12, 1, 32)
}

// Max pools kept (one per browser/proxy/ja3/tab/origin). A news page alone touches 100+ origins, so this
// is a ceiling on idle pools, not on concurrency; idle pools are also dropped after idleTTL.
func workerClientCacheMax() int {
	return envInt("CUPNET_WORKER_CLIENT_CACHE_MAX", 512, 1, 4096)
}

func poolJa3Segment(ja3 *string) string {
	if ja3 == nil {
		return "t"
	}
	s := strings.TrimSpace(*ja3)
	if s != "" {
		return "j:" + s
	}
	return "t"
}

func poolKey(browser, proxy, ja3 *string, tabID *string) string {
	prof := "chrome"
	if browser != nil && strings.TrimSpace(*browser) != "" {
		prof = strings.TrimSpace(*browser)
	}
	px := ""
	if proxy != nil {
		px = *proxy
	}
	tabSeg := "tab:__shared__"
	if tabID != nil && strings.TrimSpace(*tabID) != "" {
		tabSeg = "tab:" + strings.TrimSpace(*tabID)
	}
	return fmt.Sprintf("%s::%s::%s::%s", prof, px, poolJa3Segment(ja3), tabSeg)
}

// poolOrigin is the scheme://host[:port] a request goes to ("" when the URL does not parse).
func poolOrigin(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

func poolKeyFor(browser, proxy, ja3 *string, tabID *string, rawURL string) string {
	key := poolKey(browser, proxy, ja3, tabID)
	if o := poolOrigin(rawURL); o != "" {
		key += "::o:" + o
	}
	return key
}

func touchPoolKey(key string) {
	poolsMu.Lock()
	defer poolsMu.Unlock()
	for i, k := range poolLRU {
		if k == key {
			poolLRU = append(poolLRU[:i], poolLRU[i+1:]...)
			break
		}
	}
	poolLRU = append(poolLRU, key)
	poolLastActivity[key] = time.Now()
}

func evictPoolsIfNeeded() {
	poolsMu.Lock()
	defer poolsMu.Unlock()
	max := workerClientCacheMax()
	for len(poolLRU) > max {
		evictKey := poolLRU[0]
		pool := pools[evictKey]
		if pool != nil && pool.inUse == 0 && len(pool.waiters) == 0 {
			for _, c := range pool.idle {
				if c != nil {
					c.Close()
				}
			}
			pool.idle = pool.idle[:0]
			delete(pools, evictKey)
			delete(poolLastActivity, evictKey)
			poolLRU = poolLRU[1:]
		} else {
			break
		}
	}
}

func evictIdleClients() {
	poolsMu.Lock()
	defer poolsMu.Unlock()
	now := time.Now()
	for key, pool := range pools {
		if pool.inUse > 0 || len(pool.waiters) > 0 {
			continue
		}
		last := poolLastActivity[key]
		if now.Sub(last) < idleTTL {
			continue
		}
		for _, c := range pool.idle {
			if c != nil {
				c.Close()
			}
		}
		pool.idle = pool.idle[:0]
		delete(pools, key)
		delete(poolLastActivity, key)
		for i, k := range poolLRU {
			if k == key {
				poolLRU = append(poolLRU[:i], poolLRU[i+1:]...)
				break
			}
		}
	}
}

func borrowSession(browser, proxy, ja3 *string, tabID *string, factory func() (*azuretls.Session, error)) (*azuretls.Session, string, error) {
	return borrowSessionFor(browser, proxy, ja3, tabID, "", factory)
}

// borrowSessionFor borrows from the pool of the request's origin (see workerFfiConcurrency).
func borrowSessionFor(browser, proxy, ja3 *string, tabID *string, rawURL string, factory func() (*azuretls.Session, error)) (*azuretls.Session, string, error) {
	return borrowByKey(poolKeyFor(browser, proxy, ja3, tabID, rawURL), factory)
}

// borrowByKey borrows a session from the pool `key` (see requestPoolKey), creating one with factory
// while the pool is under its concurrency budget.
func borrowByKey(key string, factory func() (*azuretls.Session, error)) (*azuretls.Session, string, error) {
	max := workerFfiConcurrency()
	touchPoolKey(key)
	evictPoolsIfNeeded()

	for {
		poolsMu.Lock()
		pool := pools[key]
		if pool == nil {
			pool = &clientPool{}
			pools[key] = pool
		}

		if len(pool.idle) > 0 {
			s := pool.idle[len(pool.idle)-1]
			pool.idle = pool.idle[:len(pool.idle)-1]
			pool.inUse++
			poolsMu.Unlock()
			return s, key, nil
		}
		if pool.inUse < max {
			pool.inUse++
			poolsMu.Unlock()
			s, err := factory()
			if err != nil {
				poolsMu.Lock()
				p := pools[key]
				if p != nil {
					p.inUse--
				}
				poolsMu.Unlock()
				return nil, key, err
			}
			return s, key, nil
		}

		ch := make(chan any, 1)
		pool.waiters = append(pool.waiters, ch)
		poolsMu.Unlock()

		v := <-ch
		if s, ok := v.(*azuretls.Session); ok {
			// Transferred from another holder; inUse already accounts for this slot (see releaseSession).
			return s, key, nil
		}
		if v == borrowAbort {
			return nil, key, fmt.Errorf("worker clearing")
		}
	}
}

func releaseSession(key string, sess *azuretls.Session) {
	if sess == nil {
		return
	}
	poolsMu.Lock()
	pool := pools[key]
	if pool == nil {
		poolsMu.Unlock()
		sess.Close()
		return
	}
	if len(pool.waiters) > 0 {
		ch := pool.waiters[0]
		pool.waiters = pool.waiters[1:]
		poolsMu.Unlock()
		ch <- sess
		return
	}
	pool.inUse--
	pool.idle = append(pool.idle, sess)
	poolsMu.Unlock()
}

// borrowRetry wakes a waiter so it re-checks the pool (a slot was freed without handing it a session).
const borrowRetry = "cupnet.worker.borrow_retry"

// releasePoolSlot gives up a borrowed slot while the caller keeps using its session outside the
// pool's concurrency budget (a long streamed body). The session must later come back through
// reinsertFreshSession (which re-counts it) or be closed.
func releasePoolSlot(key string) {
	poolsMu.Lock()
	pool := pools[key]
	if pool == nil {
		poolsMu.Unlock()
		return
	}
	pool.inUse--
	var ch chan any
	if len(pool.waiters) > 0 {
		ch = pool.waiters[0]
		pool.waiters = pool.waiters[1:]
	}
	poolsMu.Unlock()
	if ch != nil {
		ch <- borrowRetry
	}
}

// reinsertFreshSession returns an out-of-pool session (created during a conn-error
// fresh-session retry) to the pool. The original borrowed slot was already released
// (session closed + inUse--) before this replacement was created, so account for it as
// checked-out first; otherwise releaseSession's decrement (or waiter hand-off) makes
// inUse drift below the true count, leaking the concurrency cap under upstream flakiness.
func reinsertFreshSession(key string, sess *azuretls.Session) {
	if sess == nil {
		return
	}
	poolsMu.Lock()
	if pool := pools[key]; pool != nil {
		pool.inUse++
	}
	poolsMu.Unlock()
	releaseSession(key, sess)
}

func closeAllPoolClients() {
	poolsMu.Lock()
	defer poolsMu.Unlock()
	for _, pool := range pools {
		for _, ch := range pool.waiters {
			ch <- borrowAbort
		}
		pool.waiters = pool.waiters[:0]
		for _, c := range pool.idle {
			if c != nil {
				c.Close()
			}
		}
		pool.idle = pool.idle[:0]
		pool.inUse = 0
	}
	pools = make(map[string]*clientPool)
	poolLRU = poolLRU[:0]
	poolLastActivity = make(map[string]time.Time)
}
