package qiyun

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestTLSRequiresTrustedCA(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	writeCA := func(cert *x509.Certificate) {
		t.Helper()
		if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Invalid trust material must fail before dialing.
	if err := os.WriteFile(ca, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := tlsClient(Config{CAFile: ca}, false); err == nil {
		t.Fatal("accepted invalid CA")
	}
	writeCA(server.Certificate())
	client, err := tlsClient(Config{CAFile: ca}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = request(context.Background(), client, "GET", server.URL, nil, nil); err != nil {
		t.Fatal(err)
	}
	untrusted, err := tlsClient(Config{CAFile: ca}, false)
	if err != nil {
		t.Fatal(err)
	}
	untrusted.Transport.(*http.Transport).TLSClientConfig.RootCAs = x509.NewCertPool()
	if request(context.Background(), untrusted, "GET", server.URL, nil, nil) == nil {
		t.Fatal("untrusted server certificate accepted")
	}
	if err = httpsURL("http://localhost:4311"); err == nil {
		t.Fatal("accepted HTTP")
	}
	if err = httpsURL("https://user:secret@host"); err == nil {
		t.Fatal("accepted URL credentials")
	}
}
func TestReadOnlyCollectDoesNotAdvertiseRestart(t *testing.T) {
	c := Config{HostID: "test", Name: "Test", DockerContainers: []string{"never-contact"}, DockerSocket: "/does-not-exist", DockerRestartAllowlist: []string{"never-contact"}}
	s, err := Collect(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Services) != 0 {
		t.Fatal("direct Docker collection bypassed helper")
	}
}
func TestConfigRejectsExtraFieldsAndUnlistedRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cases := []string{`{"hostId":"h","name":"h","stateDir":"` + filepath.ToSlash(dir) + `","shell":"/bin/sh"}`, `{"hostId":"h","name":"h","stateDir":"` + filepath.ToSlash(dir) + `","systemdRestartAllowlist":["ssh.service"]}`}
	for _, body := range cases {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path); err == nil {
			t.Fatal("unsafe configuration accepted")
		}
	}
}
