package qiyun

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
)

// Helper configuration must be administrator-owned. Agent configuration cannot expand it.
type Config struct {
	HostID                  string   `json:"hostId"`
	Name                    string   `json:"name"`
	ControlURL              string   `json:"controlUrl"`
	EnrollmentURL           string   `json:"enrollmentUrl"`
	CAFile                  string   `json:"caFile"`
	CertificateFile         string   `json:"certificateFile"`
	PrivateKeyFile          string   `json:"privateKeyFile"`
	SigningPublicKeyFile    string   `json:"signingPublicKeyFile"`
	StateDir                string   `json:"stateDir"`
	HelperSocket            string   `json:"helperSocket"`
	AgentUID                uint32   `json:"agentUid"`
	AgentGID                int      `json:"agentGid"`
	DockerSocket            string   `json:"dockerSocket"`
	DockerContainers        []string `json:"dockerContainers"`
	DiscoverManaged         bool     `json:"discoverManaged"`
	DockerRestartAllowlist  []string `json:"dockerRestartAllowlist"`
	SystemdUnits            []string `json:"systemdUnits"`
	SystemdRestartAllowlist []string `json:"systemdRestartAllowlist"`
	PollSeconds             int      `json:"pollSeconds"`
}

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,159}$`)
var hostIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var dockerNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

func LoadConfig(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if len(b) > 65536 {
		return c, errors.New("configuration too large")
	}
	if err = decodeStrict(b, &c); err != nil {
		return c, err
	}
	if !hostIDPattern.MatchString(c.HostID) || c.Name == "" {
		return c, errors.New("valid hostId (1..80 characters) and name required")
	}
	if len(c.DockerContainers)+len(c.SystemdUnits) > 100 || len(c.DockerRestartAllowlist)+len(c.SystemdRestartAllowlist) > 100 {
		return c, errors.New("maximum 100 registered services per host")
	}
	for _, v := range append(append([]string{}, c.DockerContainers...), c.DockerRestartAllowlist...) {
		if !dockerNamePattern.MatchString(v) || len(c.HostID)+len(v)+8 > 160 {
			return c, fmt.Errorf("invalid or overly long container name: %q", v)
		}
	}
	for _, v := range append(append([]string{}, c.SystemdUnits...), c.SystemdRestartAllowlist...) {
		if !namePattern.MatchString(v) || !regexp.MustCompile(`\.service$`).MatchString(v) || len(c.HostID)+len(v)+9 > 160 {
			return c, fmt.Errorf("invalid or overly long systemd service: %q", v)
		}
	}
	for _, list := range [][]string{c.DockerContainers, c.DockerRestartAllowlist, c.SystemdUnits, c.SystemdRestartAllowlist} {
		seen := map[string]bool{}
		for _, v := range list {
			if seen[v] {
				return c, errors.New("duplicate resource in allowlist")
			}
			seen[v] = true
		}
	}
	for _, v := range c.SystemdRestartAllowlist {
		if !contains(c.SystemdUnits, v) {
			return c, errors.New("systemd restart must also be in read allowlist")
		}
	}
	for _, v := range c.DockerRestartAllowlist {
		if !contains(c.DockerContainers, v) {
			return c, errors.New("docker restart must also be explicitly in read allowlist")
		}
	}
	for _, p := range []string{c.StateDir, c.HelperSocket, c.CAFile, c.CertificateFile, c.PrivateKeyFile, c.SigningPublicKeyFile, c.DockerSocket} {
		if p != "" && !filepath.IsAbs(p) {
			return c, errors.New("all configured file paths must be absolute")
		}
	}
	if c.StateDir == "" {
		return c, errors.New("stateDir required")
	}
	if c.PollSeconds == 0 {
		c.PollSeconds = 10
	}
	if c.PollSeconds < 2 || c.PollSeconds > 300 {
		return c, errors.New("pollSeconds must be 2..300")
	}
	return c, nil
}
func decodeStrict(b []byte, v interface{}) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if err := d.Decode(new(interface{})); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}
func httpsURL(s string) error {
	u, e := url.Parse(s)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("URL must be https without credentials, query or fragment")
	}
	return nil
}
func contains(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}
