package main

import (
	"context"
	"net"
	"strings"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
)

// connectToIP is the validated "connectTo" of a request ("" when unset or not an IP literal).
// A DNS override in dial mode: the URL keeps its hostname (SNI, Host and :authority stay real, HTTP/2
// still works) and only the TCP connection goes to this address.
func connectToIP(in *incomingLine) string {
	if in == nil || in.ConnectTo == nil {
		return ""
	}
	ip := net.ParseIP(strings.Trim(strings.TrimSpace(*in.ConnectTo), "[]"))
	if ip == nil {
		return ""
	}
	return ip.String()
}

// applyConnectTo makes every connection of the session dial `ip` instead of resolving the URL host. The
// upstream proxy, when set, is asked for ip:port (a custom Dial bypasses the session's ProxyDialer).
func applyConnectTo(s *azuretls.Session, ip string) {
	if s == nil || ip == "" {
		return
	}
	s.Dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		_, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		target := net.JoinHostPort(ip, port)
		if s.ProxyDialer != nil {
			return s.ProxyDialer.DialContext(ctx, s.UserAgent, network, target)
		}
		d := &net.Dialer{Timeout: s.TimeOut, KeepAlive: 30 * time.Second}
		return d.DialContext(ctx, network, target)
	}
}

// sessionFactoryFor creates sessions for this request's pool (connectTo applied).
func sessionFactoryFor(in *incomingLine) func() (*azuretls.Session, error) {
	ip := connectToIP(in)
	return func() (*azuretls.Session, error) {
		s, err := createPooledSession(in.Browser, in.Proxy, in.Ja3)
		if err != nil {
			return nil, err
		}
		applyConnectTo(s, ip)
		return s, nil
	}
}

// requestPoolKey is the pool of a request: its origin pool, split by connectTo so sessions dialing an
// overridden address are never reused for the real host (or another override).
func requestPoolKey(in *incomingLine) string {
	key := poolKeyFor(in.Browser, in.Proxy, in.Ja3, in.TabID, in.URL)
	if ip := connectToIP(in); ip != "" {
		key += "::c:" + ip
	}
	return key
}
