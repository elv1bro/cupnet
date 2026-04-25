package main

import (
	"fmt"
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

func workerFfiConcurrency() int {
	return envInt("CUPNET_WORKER_FFI_CONCURRENCY", 4, 1, 32)
}

func workerClientCacheMax() int {
	return envInt("CUPNET_WORKER_CLIENT_CACHE_MAX", 20, 1, 256)
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
	key := poolKey(browser, proxy, ja3, tabID)
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
