package main

import (
	"strings"

	azuretls "github.com/Noooste/azuretls-client"
)

// BrowserProfile mirrors azure-tls-worker.js BROWSER_PROFILES (JSON for __get_profiles__).
type BrowserProfile struct {
	Browser   string `json:"browser"`
	UserAgent string `json:"userAgent"`
	HTTP2     string `json:"http2"`
	Desc      string `json:"desc"`
}

var browserProfiles = map[string]BrowserProfile{
	"chrome": {
		Browser:   "chrome",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
		HTTP2:     "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
		Desc:      "Chrome 133 (Windows)",
	},
	"firefox": {
		Browser:   "firefox",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
		HTTP2:     "1:65536;4:131072;5:16384|65536|0|m,p,s,a",
		Desc:      "Firefox 138 (Windows)",
	},
	"safari": {
		Browser:   "safari",
		UserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
		HTTP2:     "1:65536;4:4194304;6:65535|10485760|0|m,s,a,p",
		Desc:      "Safari 18 (macOS)",
	},
	"ios": {
		Browser:   "ios",
		UserAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
		HTTP2:     "1:65536;4:4194304;6:65535|10485760|0|m,s,a,p",
		Desc:      "iOS 18 (Mobile Safari)",
	},
	"edge": {
		Browser:   "edge",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
		HTTP2:     "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
		Desc:      "Edge 133 (Windows)",
	},
	"opera": {
		Browser:   "opera",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 OPR/119.0.0.0",
		HTTP2:     "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
		Desc:      "Opera 119 (Windows)",
	},
}

// sessionBrowserName maps UI names (e.g. chrome_120) to azuretls Session.Browser preset.
func sessionBrowserName(browser string) string {
	b := browser
	if b == "" {
		b = "chrome"
	}
	if _, ok := browserProfiles[b]; ok {
		return b
	}
	s := strings.ToLower(b)
	if strings.HasPrefix(s, "chrome") {
		return azuretls.Chrome
	}
	if strings.HasPrefix(s, "firefox") {
		return azuretls.Firefox
	}
	if strings.HasPrefix(s, "safari") {
		return azuretls.Safari
	}
	if strings.HasPrefix(s, "edge") {
		return azuretls.Edge
	}
	if strings.HasPrefix(s, "opera") {
		return azuretls.Opera
	}
	if strings.HasPrefix(s, "ios") {
		return azuretls.Ios
	}
	return azuretls.Chrome
}

func http2FingerprintForBrowser(browser string) string {
	b := browser
	if b == "" {
		b = "chrome"
	}
	if p, ok := browserProfiles[b]; ok && p.HTTP2 != "" {
		return p.HTTP2
	}
	s := strings.ToLower(b)
	switch {
	case strings.HasPrefix(s, "chrome"):
		return browserProfiles["chrome"].HTTP2
	case strings.HasPrefix(s, "firefox"):
		return browserProfiles["firefox"].HTTP2
	case strings.HasPrefix(s, "safari"):
		return browserProfiles["safari"].HTTP2
	case strings.HasPrefix(s, "edge"):
		return browserProfiles["edge"].HTTP2
	case strings.HasPrefix(s, "opera"):
		return browserProfiles["opera"].HTTP2
	case strings.HasPrefix(s, "ios"):
		return browserProfiles["ios"].HTTP2
	default:
		return browserProfiles["chrome"].HTTP2
	}
}

// navigatorForJa3 is the second argument to ApplyJa3 (TLS profile context).
func navigatorForJa3(browser string) string {
	b := sessionBrowserName(browser)
	switch b {
	case azuretls.Firefox:
		return azuretls.Firefox
	case azuretls.Safari:
		return azuretls.Safari
	case azuretls.Ios:
		return azuretls.Ios
	case azuretls.Edge:
		return azuretls.Edge
	case azuretls.Opera:
		return azuretls.Opera
	default:
		return azuretls.Chrome
	}
}

func defaultUserAgentForBrowser(browser string) string {
	b := browser
	if b == "" {
		b = "chrome"
	}
	if p, ok := browserProfiles[b]; ok {
		return p.UserAgent
	}
	return browserProfiles["chrome"].UserAgent
}
