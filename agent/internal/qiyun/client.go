package qiyun

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func tlsClient(c Config, identity bool) (*http.Client, error) {
	b, e := os.ReadFile(c.CAFile)
	if e != nil {
		return nil, e
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(b) {
		return nil, errors.New("invalid CA file")
	}
	tc := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}
	if identity {
		cert, e := tls.LoadX509KeyPair(c.CertificateFile, c.PrivateKeyFile)
		if e != nil {
			return nil, e
		}
		tc.Certificates = []tls.Certificate{cert}
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: tc}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects disabled") }}, nil
}
func request(ctx context.Context, client *http.Client, method, url string, input, output interface{}) error {
	var body io.Reader
	if input != nil {
		b, e := json.Marshal(input)
		if e != nil {
			return e
		}
		body = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, url, body)
	if e != nil {
		return e
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, e := client.Do(req)
	if e != nil {
		return errors.New("connection or TLS verification failed")
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024+1))
	if e != nil {
		return e
	}
	if len(b) > 4*1024*1024 {
		return errors.New("response exceeded limit")
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("server returned HTTP %d", res.StatusCode)
	}
	if output != nil {
		return decodeStrict(b, output)
	}
	return nil
}
func Enroll(ctx context.Context, c Config, tokenFile string) error {
	if e := httpsURL(c.EnrollmentURL); e != nil {
		return e
	}
	client, e := tlsClient(c, false)
	if e != nil {
		return e
	}
	if _, e = os.Stat(c.CertificateFile); e == nil {
		return errors.New("certificate already exists; refusing to replace identity")
	}
	var token string
	if tokenFile != "" {
		b, e := os.ReadFile(tokenFile)
		if e != nil {
			return e
		}
		if len(b) > 4096 {
			return errors.New("token file too large")
		}
		token = strings.TrimSpace(string(b))
	} else {
		fmt.Fprint(os.Stderr, "Pairing token (stdin; use --token-file for non-interactive enrollment): ")
		sc := bufio.NewScanner(io.LimitReader(os.Stdin, 4097))
		if !sc.Scan() {
			return errors.New("pairing token required")
		}
		token = strings.TrimSpace(sc.Text())
	}
	if token == "" || len(token) > 4096 {
		return errors.New("invalid pairing token")
	}
	var key *rsa.PrivateKey
	b, e := os.ReadFile(c.PrivateKeyFile)
	if e == nil {
		block, _ := pem.Decode(b)
		if block == nil {
			return errors.New("invalid existing private key")
		}
		v, e := x509.ParsePKCS8PrivateKey(block.Bytes)
		if e != nil {
			return e
		}
		var ok bool
		key, ok = v.(*rsa.PrivateKey)
		if !ok {
			return errors.New("existing key must be RSA")
		}
	} else if os.IsNotExist(e) {
		key, e = rsa.GenerateKey(rand.Reader, 2048)
		if e != nil {
			return e
		}
		der, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			return e
		}
		if e = atomicWrite(c.PrivateKeyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); e != nil {
			return e
		}
	} else {
		return e
	}
	csr, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: c.HostID}}, key)
	if e != nil {
		return e
	}
	in := struct {
		Token  string `json:"token"`
		CSR    string `json:"csr"`
		HostID string `json:"hostId"`
	}{token, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr})), c.HostID}
	var out struct {
		Certificate      string `json:"certificate"`
		CACertificate    string `json:"caCertificate"`
		SigningPublicKey string `json:"signingPublicKey"`
		HostID           string `json:"hostId"`
	}
	if e = request(ctx, client, "POST", strings.TrimRight(c.EnrollmentURL, "/")+"/api/agent/register", in, &out); e != nil {
		return e
	}
	if out.HostID != c.HostID {
		return errors.New("enrollment identity mismatch")
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	pair, e := tls.X509KeyPair([]byte(out.Certificate), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	if e != nil {
		return errors.New("enrollment certificate does not match private key")
	}
	leaf, e := x509.ParseCertificate(pair.Certificate[0])
	if e != nil {
		return e
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(out.CACertificate)) {
		return errors.New("invalid enrollment CA")
	}
	if _, e = leaf.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); e != nil {
		return e
	}
	if leaf.Subject.CommonName != c.HostID {
		return errors.New("certificate host identity mismatch")
	}
	block, _ := pem.Decode([]byte(out.SigningPublicKey))
	if block == nil {
		return errors.New("invalid signing key")
	}
	v, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return e
	}
	if _, ok := v.(ed25519.PublicKey); !ok {
		return errors.New("enrollment signing key must be Ed25519")
	}
	if e = atomicWrite(c.SigningPublicKeyFile, []byte(out.SigningPublicKey), 0600); e != nil {
		return e
	}
	if _, e = PublicKey(c.SigningPublicKeyFile); e != nil {
		return e
	}
	if e = atomicWrite(c.CAFile, []byte(out.CACertificate), 0600); e != nil {
		return e
	}
	return atomicWrite(c.CertificateFile, []byte(out.Certificate), 0600)
}
func helperClient(socket string) *http.Client {
	return &http.Client{Timeout: 55 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}}
}
func Collect(ctx context.Context, c Config) (Snapshot, error) {
	snap := Snapshot{Host: hostMetrics(c), Services: []Service{}, Logs: map[string][]LogLine{}}
	if c.HelperSocket != "" {
		var services ServiceSnapshot
		e := request(ctx, helperClient(c.HelperSocket), "GET", "http://helper/services", nil, &services)
		if e != nil {
			return snap, errors.New("privileged collector unavailable")
		}
		snap.Services = services.Services
		snap.Logs = services.Logs
		return snap, nil
	}
	// Without helper only registered systemd reads are attempted; never open Docker socket.
	local := c
	local.DockerSocket = ""
	local.DockerContainers = nil
	local.DiscoverManaged = false
	local.SystemdRestartAllowlist = nil
	services := NewCollector(local).Services(ctx)
	snap.Services = services.Services
	snap.Logs = services.Logs
	return snap, nil
}

type pending struct {
	Signed SignedJob  `json:"signed"`
	Result *JobResult `json:"result,omitempty"`
}

func Run(ctx context.Context, c Config) error {
	if runtime.GOOS != "linux" {
		return errors.New("network Agent is Linux-only")
	}
	if os.Geteuid() == 0 {
		return errors.New("run the network Agent as a dedicated non-root user")
	}
	if e := httpsURL(c.ControlURL); e != nil {
		return e
	}
	client, e := tlsClient(c, true)
	if e != nil {
		return e
	}
	key, e := PublicKey(c.SigningPublicKeyFile)
	if e != nil {
		return e
	}
	inbox := filepath.Join(c.StateDir, "inbox")
	if e = os.MkdirAll(inbox, 0700); e != nil {
		return e
	}
	release, e := lockState(c.StateDir)
	if e != nil {
		return e
	}
	defer release()
	ticker := time.NewTicker(time.Duration(c.PollSeconds) * time.Second)
	defer ticker.Stop()
	cycle := func() {
		snap, e := Collect(ctx, c)
		if e == nil {
			if e = request(ctx, client, "POST", strings.TrimRight(c.ControlURL, "/")+"/api/agent/snapshot", snap, nil); e != nil {
				fmt.Fprintln(os.Stderr, "snapshot delivery failed")
			}
		} else {
			fmt.Fprintln(os.Stderr, "collection failed; snapshot withheld to preserve last known service state")
		}
		var batch struct {
			Jobs []SignedJob `json:"jobs"`
		}
		if e = request(ctx, client, "GET", strings.TrimRight(c.ControlURL, "/")+"/api/agent/jobs", nil, &batch); e == nil {
			for _, signed := range batch.Jobs {
				j, _, e := VerifySigned(signed, key, c.HostID)
				if e != nil {
					fmt.Fprintln(os.Stderr, "rejected invalid signed job")
					continue
				}
				path := filepath.Join(inbox, revision(j.ID)+".json")
				if _, e = os.Stat(path); os.IsNotExist(e) {
					b, _ := json.Marshal(pending{Signed: signed})
					if e = atomicWrite(path, b, 0600); e != nil {
						fmt.Fprintln(os.Stderr, "cannot persist job; execution skipped")
					}
				}
			}
		}
		files, e := os.ReadDir(inbox)
		if e != nil {
			return
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
				continue
			}
			path := filepath.Join(inbox, f.Name())
			b, e := os.ReadFile(path)
			if e != nil {
				continue
			}
			var p pending
			if decodeStrict(b, &p) != nil {
				fmt.Fprintln(os.Stderr, "invalid inbox entry; reconciliation required")
				continue
			}
			j, _, e := VerifySigned(p.Signed, key, c.HostID)
			if e != nil {
				continue
			}
			if p.Result == nil {
				var result JobResult
				if c.HelperSocket == "" {
					result = JobResult{JobID: j.ID, Status: "failed", Detail: "Read-only agent: privileged helper is not configured"}
				} else {
					if e = request(ctx, helperClient(c.HelperSocket), "POST", "http://helper/restart", p.Signed, &result); e != nil {
						fmt.Fprintln(os.Stderr, "helper unavailable; job retained for receipt reconciliation")
						continue
					}
				}
				if result.JobID != j.ID {
					fmt.Fprintln(os.Stderr, "helper result identity mismatch")
					continue
				}
				p.Result = &result
				b, _ = json.Marshal(p)
				if atomicWrite(path, b, 0600) != nil {
					continue
				}
			}
			if request(ctx, client, "POST", strings.TrimRight(c.ControlURL, "/")+"/api/agent/results", p.Result, nil) == nil {
				if os.Remove(path) == nil {
					_ = syncDirectory(inbox)
				}
			}
		}
	}
	for {
		cycle()
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
