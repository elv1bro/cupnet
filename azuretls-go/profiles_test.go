package main

import (
	"strings"
	"testing"

	azuretls "github.com/Noooste/azuretls-client"
)

func TestSessionBrowserName(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", azuretls.Chrome},
		{"chrome", "chrome"},
		{"chrome_120", azuretls.Chrome},
		{"firefox", "firefox"},
		{"FirefoxNightly", azuretls.Firefox},
		{"safari", "safari"},
		{"edge", "edge"},
		{"opera", "opera"},
		{"ios", "ios"},
	}
	for _, tc := range cases {
		if got := sessionBrowserName(tc.in); got != tc.want {
			t.Errorf("%q: got %q want %q", tc.in, got, tc.want)
		}
	}
}

func TestHTTP2FingerprintForBrowser(t *testing.T) {
	chromeH2 := browserProfiles["chrome"].HTTP2
	if chromeH2 == "" {
		t.Fatal("chrome http2 empty")
	}
	if got := http2FingerprintForBrowser(""); got != chromeH2 {
		t.Fatalf("empty: got %q", got)
	}
	if got := http2FingerprintForBrowser("chrome"); got != chromeH2 {
		t.Fatalf("chrome: got %q", got)
	}
	if got := http2FingerprintForBrowser("chrome_99"); got != chromeH2 {
		t.Fatalf("chrome_99: got %q", got)
	}
	ff := browserProfiles["firefox"].HTTP2
	if got := http2FingerprintForBrowser("firefox"); got != ff {
		t.Fatalf("firefox: got %q want %q", got, ff)
	}
}

func TestDefaultUserAgentForBrowser(t *testing.T) {
	ua := defaultUserAgentForBrowser("chrome")
	if !strings.Contains(ua, "Chrome") {
		t.Fatalf("expected Chrome UA, got %q", ua)
	}
	if got := defaultUserAgentForBrowser("unknown_browser_xyz"); got != browserProfiles["chrome"].UserAgent {
		t.Fatalf("unknown should fall back to chrome UA")
	}
}

func TestNavigatorForJa3(t *testing.T) {
	if got := navigatorForJa3("firefox"); got != azuretls.Firefox {
		t.Fatalf("got %q", got)
	}
	if got := navigatorForJa3("chrome"); got != azuretls.Chrome {
		t.Fatalf("got %q", got)
	}
}

func TestAllBrowserProfilesHaveRequiredFields(t *testing.T) {
	for name, p := range browserProfiles {
		if strings.TrimSpace(p.Browser) == "" || strings.TrimSpace(p.UserAgent) == "" ||
			strings.TrimSpace(p.HTTP2) == "" || strings.TrimSpace(p.Desc) == "" {
			t.Fatalf("profile %q has empty required field: %#v", name, p)
		}
	}
}

func TestHTTP2FingerprintAllBrowsers(t *testing.T) {
	cases := []string{
		"chrome", "firefox", "safari", "ios", "edge", "opera",
		"chrome_120", "safari_18", "ios_17", "firefox_138", "edge_133",
	}
	for _, c := range cases {
		h := http2FingerprintForBrowser(c)
		if h == "" {
			t.Fatalf("empty http2 for %q", c)
		}
	}
}

func TestNavigatorForJa3AllBrowsers(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"chrome", azuretls.Chrome},
		{"chrome_120", azuretls.Chrome},
		{"firefox", azuretls.Firefox},
		{"safari", azuretls.Safari},
		{"safari_18", azuretls.Safari},
		{"ios", azuretls.Ios},
		{"ios_17", azuretls.Ios},
		{"edge", azuretls.Edge},
		{"opera", azuretls.Opera},
	}
	for _, tc := range cases {
		if got := navigatorForJa3(tc.in); got != tc.want {
			t.Errorf("%q: got %q want %q", tc.in, got, tc.want)
		}
	}
}
