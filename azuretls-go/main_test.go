package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestTrimNewline(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"abc\r\n", "abc"},
		{"abc", "abc"},
		{"\n", ""},
		{"x\n\n", "x"},
	}
	for _, tc := range cases {
		got := string(trimNewline([]byte(tc.in)))
		if got != tc.want {
			t.Fatalf("trimNewline(%q) = %q want %q", tc.in, got, tc.want)
		}
	}
}

func TestSendLine(t *testing.T) {
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	old := stdoutBuf
	stdoutBuf = w
	defer func() { stdoutBuf = old }()

	sendLine(map[string]any{"id": "t1", "ok": true})
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if !strings.HasSuffix(out, "\n") {
		t.Fatalf("expected newline-terminated line, got %q", out)
	}
	line := strings.TrimSuffix(out, "\n")
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatal(err)
	}
	if m["id"] != "t1" || m["ok"] != true {
		t.Fatalf("payload: %#v", m)
	}
}
