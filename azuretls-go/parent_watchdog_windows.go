//go:build windows

package main

import "golang.org/x/sys/windows"

func parentProcessAlive(pid int) bool {
	const processQueryLimitedInformation = 0x1000
	h, err := windows.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}
