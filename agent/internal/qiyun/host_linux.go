//go:build linux

package qiyun

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

var cpuState struct {
	sync.Mutex
	total, idle uint64
}

func hostMetrics(c Config) Host {
	h := Host{ID: c.HostID, Name: c.Name, Address: "local", OS: "Linux", Arch: runtime.GOARCH, Status: "online", LastSeen: stamp(), Labels: []string{}, History: []float64{}}
	if hostname, e := os.Hostname(); e == nil && hostname != "" {
		h.Address = hostname
	}
	if b, e := os.ReadFile("/etc/os-release"); e == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "PRETTY_NAME=") {
				h.OS = strings.Trim(strings.TrimPrefix(l, "PRETTY_NAME="), "\"")
			}
		}
	}
	if b, e := os.ReadFile("/proc/uptime"); e == nil {
		f := strings.Fields(string(b))
		if len(f) > 0 {
			h.Uptime, _ = strconv.ParseFloat(f[0], 64)
		}
	}
	if b, e := os.ReadFile("/proc/meminfo"); e == nil {
		m := map[string]float64{}
		for _, l := range strings.Split(string(b), "\n") {
			f := strings.Fields(l)
			if len(f) >= 2 {
				m[strings.TrimSuffix(f[0], ":")], _ = strconv.ParseFloat(f[1], 64)
			}
		}
		if m["MemTotal"] > 0 {
			v := 100 * (m["MemTotal"] - m["MemAvailable"]) / m["MemTotal"]
			h.Memory = &v
		}
	}
	var fs syscall.Statfs_t
	if syscall.Statfs("/", &fs) == nil && fs.Blocks > 0 {
		v := 100 * float64(fs.Blocks-fs.Bfree) / float64(fs.Blocks)
		h.Disk = &v
	}
	if b, e := os.ReadFile("/proc/stat"); e == nil {
		line := strings.SplitN(string(b), "\n", 2)[0]
		f := strings.Fields(line)
		if len(f) >= 5 {
			var total, idle uint64
			for i, s := range f[1:] {
				if i >= 8 {
					break
				}
				v, _ := strconv.ParseUint(s, 10, 64)
				total += v
				if i == 3 || i == 4 {
					idle += v
				}
			}
			cpuState.Lock()
			if total > cpuState.total && cpuState.total > 0 && idle >= cpuState.idle {
				v := 100 * (1 - float64(idle-cpuState.idle)/float64(total-cpuState.total))
				h.CPU = &v
			}
			cpuState.total = total
			cpuState.idle = idle
			cpuState.Unlock()
		}
	}
	return h
}
func syncDirectory(path string) error {
	d, e := os.Open(path)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
