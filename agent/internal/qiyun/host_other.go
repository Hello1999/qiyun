//go:build !linux

package qiyun

import "runtime"

func hostMetrics(c Config) Host {
	return Host{ID: c.HostID, Name: c.Name, Address: "local", OS: runtime.GOOS, Arch: runtime.GOARCH, Status: "online", LastSeen: stamp(), Labels: []string{}, History: []float64{}}
}
func syncDirectory(path string) error { return nil }
