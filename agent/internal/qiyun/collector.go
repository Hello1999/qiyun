package qiyun

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

func stamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func revision(parts ...string) string {
	s := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(s[:])
}

type Collector struct {
	Config Config
	Docker *http.Client
}

func NewCollector(c Config) *Collector {
	return &Collector{Config: c, Docker: &http.Client{Timeout: 12 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", c.DockerSocket)
	}}}}
}

type dockerContainer struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Image  string `json:"Image"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		Health     *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
}

func (c *Collector) docker(ctx context.Context, method, path string) ([]byte, error) {
	if c.Config.DockerSocket == "" {
		return nil, errors.New("docker collection disabled")
	}
	req, e := http.NewRequestWithContext(ctx, method, "http://docker"+path, nil)
	if e != nil {
		return nil, e
	}
	res, e := c.Docker.Do(req)
	if e != nil {
		return nil, errors.New("docker socket unavailable")
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 1024*1024+1))
	if e != nil {
		return nil, e
	}
	if len(b) > 1024*1024 {
		return nil, errors.New("docker response exceeded limit")
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("docker returned HTTP %d", res.StatusCode)
	}
	return b, nil
}
func (c *Collector) inspect(ctx context.Context, name string) (dockerContainer, error) {
	var v dockerContainer
	b, e := c.docker(ctx, "GET", "/containers/"+url.PathEscape(name)+"/json")
	if e != nil {
		return v, e
	}
	e = json.Unmarshal(b, &v)
	if e == nil && (v.ID == "" || v.State.StartedAt == "") {
		e = errors.New("invalid docker inspection")
	}
	return v, e
}
func (c *Collector) serviceID(kind, name string) string {
	return c.Config.HostID + ":" + kind + ":" + name
}
func (c *Collector) base(kind, name string) Service {
	return Service{ID: c.serviceID(kind, name), HostID: c.Config.HostID, Name: name, Kind: kind, Category: "application", Status: "unknown", State: "unavailable", Description: "", UpdatedAt: stamp(), Revision: revision("unavailable", kind, name)}
}
func (c *Collector) dockerService(ctx context.Context, name string) (Service, string, error) {
	s := c.base("docker", name)
	v, e := c.inspect(ctx, name)
	if e != nil {
		s.Description = "Docker state unavailable"
		return s, "", e
	}
	// Explicit names and label-discovered resources both stay scoped on every read.
	if !contains(c.Config.DockerContainers, name) && (!c.Config.DiscoverManaged || v.Config.Labels["qiyun.managed"] != "true") {
		return s, "", errors.New("container outside read scope")
	}
	s.State = v.State.Status
	s.Image = v.Config.Image
	s.Status = "critical"
	if v.State.Running {
		s.Status = "healthy"
	}
	if v.State.Health != nil {
		switch v.State.Health.Status {
		case "unhealthy":
			s.Status = "critical"
		case "starting":
			s.Status = "warning"
		}
	}
	s.Revision = revision(v.ID, v.Image, v.State.StartedAt, v.State.FinishedAt, v.State.Status)
	s.RestartAllowed = contains(c.Config.DockerRestartAllowlist, name)
	s.Description = "Docker container"
	return s, v.ID, nil
}

type cappedBuffer struct {
	b   bytes.Buffer
	max int
}

func (w *cappedBuffer) Write(b []byte) (int, error) {
	n := len(b)
	remaining := w.max - w.b.Len()
	if remaining > 0 {
		if len(b) > remaining {
			b = b[:remaining]
		}
		_, _ = w.b.Write(b)
	}
	return n, nil
}
func command(ctx context.Context, path string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "SYSTEMD_PAGER=cat"}
	out := &cappedBuffer{max: 128 * 1024}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	err := cmd.Run()
	return out.b.Bytes(), err
}
func (c *Collector) systemdService(ctx context.Context, name string) (Service, error) {
	s := c.base("systemd", name)
	if !contains(c.Config.SystemdUnits, name) {
		return s, errors.New("systemd outside read scope")
	}
	b, e := command(ctx, "/usr/bin/systemctl", "show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState,ActiveEnterTimestampMonotonic,InactiveEnterTimestampMonotonic,ExecMainStartTimestampMonotonic", "--", name)
	if e != nil {
		s.Description = "systemd state unavailable"
		return s, e
	}
	props := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if ok {
			props[k] = v
		}
	}
	if props["LoadState"] != "loaded" || props["ActiveState"] == "" {
		return s, errors.New("systemd unit not loaded")
	}
	s.State = props["ActiveState"] + "/" + props["SubState"]
	s.Status = "warning"
	if props["ActiveState"] == "active" {
		s.Status = "healthy"
	}
	if props["ActiveState"] == "failed" {
		s.Status = "critical"
	}
	s.Revision = revision(name, props["ActiveState"], props["SubState"], props["ActiveEnterTimestampMonotonic"], props["InactiveEnterTimestampMonotonic"], props["ExecMainStartTimestampMonotonic"])
	s.RestartAllowed = contains(c.Config.SystemdRestartAllowlist, name)
	s.Description = "Registered systemd service"
	return s, nil
}
func (c *Collector) find(ctx context.Context, id string) (Service, string, error) {
	for _, n := range c.Config.DockerRestartAllowlist {
		if c.serviceID("docker", n) == id {
			return c.dockerService(ctx, n)
		}
	}
	for _, n := range c.Config.SystemdRestartAllowlist {
		if c.serviceID("systemd", n) == id {
			s, e := c.systemdService(ctx, n)
			return s, n, e
		}
	}
	return Service{}, "", errors.New("service restart is outside local allowlist")
}
func (c *Collector) Services(ctx context.Context) ServiceSnapshot {
	result := ServiceSnapshot{Services: []Service{}, Logs: map[string][]LogLine{}}
	names := append([]string{}, c.Config.DockerContainers...)
	if c.Config.DiscoverManaged {
		b, e := c.docker(ctx, "GET", "/containers/json?all=1&filters="+url.QueryEscape(`{"label":["qiyun.managed=true"]}`))
		if e == nil {
			var listed []struct {
				Names []string `json:"Names"`
			}
			if json.Unmarshal(b, &listed) == nil {
				for _, v := range listed {
					if len(v.Names) > 0 {
						n := strings.TrimPrefix(v.Names[0], "/")
						if dockerNamePattern.MatchString(n) && len(c.serviceID("docker", n)) <= 160 && !contains(names, n) && len(names) < 100-len(c.Config.SystemdUnits) {
							names = append(names, n)
						}
					}
				}
			}
		}
	}
	sort.Strings(names)
	limit := 100 - len(c.Config.SystemdUnits)
	if len(names) > limit {
		names = names[:limit]
	}
	for _, n := range names {
		s, id, e := c.dockerService(ctx, n)
		result.Services = append(result.Services, s)
		result.Logs[s.ID] = unavailableLogs()
		if e == nil {
			b, e := c.docker(ctx, "GET", "/containers/"+id+"/logs?stdout=1&stderr=1&tail=100&timestamps=1")
			if e == nil {
				result.Logs[s.ID] = parseLogs(demuxDocker(b))
			}
		}
	}
	for _, n := range c.Config.SystemdUnits {
		s, e := c.systemdService(ctx, n)
		result.Services = append(result.Services, s)
		result.Logs[s.ID] = unavailableLogs()
		if e == nil {
			b, e := command(ctx, "/usr/bin/journalctl", "--no-pager", "--output=short-iso", "--lines=100", "--unit="+n)
			if e == nil {
				result.Logs[s.ID] = parseLogs(b)
			}
		}
	}
	return result
}
func unavailableLogs() []LogLine {
	return []LogLine{{Timestamp: stamp(), Level: "warn", Message: "[Qiyun collection] Logs unavailable: target, permission, timeout or output limit prevented this read."}}
}
func demuxDocker(b []byte) []byte {
	var out []byte
	for len(b) >= 8 && b[0] <= 2 && b[1] == 0 && b[2] == 0 && b[3] == 0 {
		n := int(b[4])<<24 | int(b[5])<<16 | int(b[6])<<8 | int(b[7])
		if n < 0 || n > len(b)-8 {
			return out
		}
		out = append(out, b[8:8+n]...)
		b = b[8+n:]
	}
	if len(out) > 0 {
		return out
	}
	return b
}

var secrets = regexp.MustCompile(`(?i)(authorization\s*[:=]\s*(?:bearer\s+|basic\s+)?|(?:password|passwd|token|api[_-]?key|secret|cookie)\s*["']?\s*[:=]\s*["']?)[^\s,"';]+`)
var bearer = regexp.MustCompile(`(?i)\bBearer\s+[a-z0-9._~+/=-]+`)
var urlCredentials = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@`)
var quotedSecrets = regexp.MustCompile(`(?i)((?:authorization|password|passwd|token|api[_-]?key|secret|cookie)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*')`)
var cookieHeader = regexp.MustCompile(`(?i)((?:cookie|set-cookie)\s*:\s*)[^\r\n]*`)

func redact(s string) string {
	s = quotedSecrets.ReplaceAllString(s, "${1}[REDACTED]")
	s = cookieHeader.ReplaceAllString(s, "${1}[REDACTED]")
	s = secrets.ReplaceAllString(s, "${1}[REDACTED]")
	s = bearer.ReplaceAllString(s, "Bearer [REDACTED]")
	s = urlCredentials.ReplaceAllString(s, "${1}[REDACTED]@")
	if len(s) > 2000 {
		s = s[:2000] + "…"
	}
	return s
}
func parseLogs(b []byte) []LogLine {
	lines := []LogLine{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 4096), 128*1024)
	private := false
	for sc.Scan() {
		line := sc.Text()
		if strings.Contains(line, "-----BEGIN ") {
			private = true
		}
		if private {
			if strings.Contains(line, "-----END ") {
				private = false
			}
			continue
		}
		level := "info"
		low := strings.ToLower(line)
		if strings.Contains(low, "error") || strings.Contains(low, "fatal") {
			level = "error"
		} else if strings.Contains(low, "warn") {
			level = "warn"
		}
		ts := stamp()
		first, rest, ok := strings.Cut(line, " ")
		if ok {
			if _, e := time.Parse(time.RFC3339Nano, first); e == nil {
				ts = first
				line = rest
			}
		}
		lines = append(lines, LogLine{Timestamp: ts, Level: level, Message: redact(line)})
		if len(lines) > 100 {
			lines = lines[1:]
		}
	}
	return lines
}
