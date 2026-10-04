package qiyun

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type fakeBackend struct {
	calls    int
	revision string
	allowed  bool
	fail     bool
}

func (f *fakeBackend) Current(context.Context, string) (Service, string, error) {
	return Service{ID: "host:docker:web", Kind: "docker", Revision: f.revision, RestartAllowed: f.allowed, Status: "healthy"}, "container-id", nil
}
func (f *fakeBackend) Restart(context.Context, Service, string) error {
	f.calls++
	f.revision = revision("after")
	if f.fail {
		return errors.New("lost response")
	}
	return nil
}
func signed(t *testing.T, key ed25519.PrivateKey, j Job) SignedJob {
	t.Helper()
	b, e := json.Marshal(j)
	if e != nil {
		t.Fatal(e)
	}
	return SignedJob{Payload: base64.StdEncoding.EncodeToString(b), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, b))}
}
func setup(t *testing.T) (*Engine, *fakeBackend, ed25519.PrivateKey, Job) {
	t.Helper()
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	backend := &fakeBackend{revision: revision("before"), allowed: true}
	engine := &Engine{HostID: "host", Key: pub, Dir: t.TempDir(), Backend: backend}
	return engine, backend, key, Job{ID: "job-1", TaskID: "task-1", HostID: "host", ServiceID: "host:docker:web", Action: "service.restart", ExpectedRevision: backend.revision, ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}
}
func TestRestartAndDuplicateReceipt(t *testing.T) {
	e, b, key, j := setup(t)
	s := signed(t, key, j)
	first := e.Execute(context.Background(), s)
	second := e.Execute(context.Background(), s)
	if first.Status != "succeeded" || second != first || b.calls != 1 {
		t.Fatalf("result=%+v replay=%+v calls=%d", first, second, b.calls)
	}
}
func TestUnauthorizedAndDriftNeverExecute(t *testing.T) {
	for _, test := range []string{"signature", "host", "expired", "drift", "allowlist", "unknown-field", "action"} {
		t.Run(test, func(t *testing.T) {
			e, b, key, j := setup(t)
			switch test {
			case "host":
				j.HostID = "other"
			case "expired":
				j.ExpiresAt = time.Now().Add(-time.Minute).Format(time.RFC3339Nano)
			case "drift":
				j.ExpectedRevision = revision("changed")
			case "allowlist":
				b.allowed = false
			case "action":
				j.Action = "shell.exec"
			}
			s := signed(t, key, j)
			if test == "signature" {
				s.Signature = base64.StdEncoding.EncodeToString(make([]byte, 64))
			}
			if test == "unknown-field" {
				raw, _ := base64.StdEncoding.DecodeString(s.Payload)
				raw = append(raw[:len(raw)-1], []byte(`,"command":"id"}`)...)
				s.Payload = base64.StdEncoding.EncodeToString(raw)
				s.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(key, raw))
			}
			r := e.Execute(context.Background(), s)
			if r.Status != "failed" || b.calls != 0 {
				t.Fatalf("unsafe execution: %+v calls=%d", r, b.calls)
			}
		})
	}
}
func TestCrashRecoveryDoesNotRepeat(t *testing.T) {
	e, b, key, j := setup(t)
	s := signed(t, key, j)
	_, hash, err := VerifySigned(s, e.Key, e.HostID)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.save(j.ID, receipt{Hash: hash, State: "running", Result: JobResult{JobID: j.ID, Status: "unknown"}}); err != nil {
		t.Fatal(err)
	}
	if err = e.Recover(); err != nil {
		t.Fatal(err)
	}
	r := e.Execute(context.Background(), s)
	if r.Status != "unknown" || b.calls != 0 {
		t.Fatalf("replayed interrupted operation: %+v", r)
	}
}
func TestExpiredAuthorizationCanReconcileCompletedReceipt(t *testing.T) {
	e, b, key, j := setup(t)
	j.ExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	s := signed(t, key, j)
	_, hash, err := VerifySigned(s, e.Key, e.HostID)
	if err != nil {
		t.Fatal("expired signature cannot be reconciled", err)
	}
	done := JobResult{JobID: j.ID, Status: "succeeded", Detail: "previously verified", Revision: revision("after")}
	if err = e.save(j.ID, receipt{Hash: hash, State: "done", Result: done}); err != nil {
		t.Fatal(err)
	}
	if got := e.Execute(context.Background(), s); got != done || b.calls != 0 {
		t.Fatalf("expired replay changed result: %+v calls=%d", got, b.calls)
	}
}
func TestExpiredInterruptedReceiptRemainsUnknown(t *testing.T) {
	e, b, key, j := setup(t)
	j.ExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	s := signed(t, key, j)
	_, hash, err := VerifySigned(s, e.Key, e.HostID)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.save(j.ID, receipt{Hash: hash, State: "running", Result: JobResult{JobID: j.ID, Status: "unknown"}}); err != nil {
		t.Fatal(err)
	}
	if err = e.Recover(); err != nil {
		t.Fatal(err)
	}
	if got := e.Execute(context.Background(), s); got.Status != "unknown" || b.calls != 0 {
		t.Fatalf("expired interrupted job repeated: %+v calls=%d", got, b.calls)
	}
}
func TestLostRestartResponseIsUnknownAndNotRetried(t *testing.T) {
	e, b, key, j := setup(t)
	b.fail = true
	s := signed(t, key, j)
	r := e.Execute(context.Background(), s)
	_ = e.Execute(context.Background(), s)
	if r.Status != "unknown" || b.calls != 1 {
		t.Fatalf("%+v calls=%d", r, b.calls)
	}
}
func TestReuseIDWithDifferentAuthorizationDenied(t *testing.T) {
	e, b, key, j := setup(t)
	e.Execute(context.Background(), signed(t, key, j))
	j.TaskID = "another"
	r := e.Execute(context.Background(), signed(t, key, j))
	if r.Status != "failed" || b.calls != 1 {
		t.Fatalf("%+v calls=%d", r, b.calls)
	}
}
func TestCorruptReceiptFailsClosed(t *testing.T) {
	e, b, key, j := setup(t)
	if err := os.WriteFile(e.path(j.ID), []byte("{corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	r := e.Execute(context.Background(), signed(t, key, j))
	if r.Status != "unknown" || b.calls != 0 {
		t.Fatal(r)
	}
	if e.Recover() == nil {
		t.Fatal("corrupt receipt was ignored")
	}
}
func TestRedactionAndLogLimits(t *testing.T) {
	input := "2026-10-04T00:00:00Z Authorization: Bearer abc.secret\npassword=hunter2 token=supersecret\n-----BEGIN PRIVATE KEY-----\nprivate-data\n-----END PRIVATE KEY-----\n"
	for i := 0; i < 120; i++ {
		input += "token=sensitive " + strings.Repeat("x", 2500) + "\n"
	}
	logs := parseLogs([]byte(input))
	if len(logs) != 100 {
		t.Fatal(len(logs))
	}
	for _, line := range logs {
		if strings.Contains(line.Message, "sensitive") || len(line.Message) > 2003 {
			t.Fatal("log boundary failure")
		}
	}
	r := redact("Authorization: Bearer abc.secret password=hunter2 token=supersecret")
	if strings.Contains(r, "abc.secret") || strings.Contains(r, "hunter2") || strings.Contains(r, "supersecret") {
		t.Fatal(r)
	}
}
func TestRevisionStable(t *testing.T) {
	a := revision("container-id", "image", "started")
	if a != revision("container-id", "image", "started") || a == revision("container-id", "image", "new-start") {
		t.Fatal("unstable revision")
	}
}
