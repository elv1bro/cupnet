//go:build !windows

package main

import "syscall"

func parentProcessAlive(pid int) bool {
	return syscall.Kill(pid, syscall.Signal(0)) == nil
}
