package qiyun

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func PublicKey(path string) (ed25519.PublicKey, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, errors.New("missing signing public key PEM")
	}
	v, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return nil, e
	}
	key, ok := v.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("signing key must be Ed25519")
	}
	return key, nil
}

// Signature validation intentionally permits expired payloads for receipt reconciliation.
// Only Engine.Execute may start effects, after it checks expiry on a NEW receipt.
func VerifySigned(s SignedJob, key ed25519.PublicKey, hostID string) (Job, string, error) {
	var j Job
	if len(s.Payload) > 16384 || len(s.Signature) > 256 {
		return j, "", errors.New("signed job exceeds size limit")
	}
	b, e := base64.StdEncoding.Strict().DecodeString(s.Payload)
	if e != nil {
		return j, "", errors.New("invalid job encoding")
	}
	sig, e := base64.StdEncoding.Strict().DecodeString(s.Signature)
	if e != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, b, sig) {
		return j, "", errors.New("invalid job signature")
	}
	if e = decodeStrict(b, &j); e != nil {
		return j, "", errors.New("invalid job schema")
	}
	if j.HostID != hostID || j.Action != "service.restart" || !namePattern.MatchString(j.ID) || !namePattern.MatchString(j.TaskID) || j.ServiceID == "" || len(j.ServiceID) > 400 || len(j.ExpectedRevision) != 64 {
		return j, "", errors.New("invalid job scope or fields")
	}
	if _, e = hex.DecodeString(j.ExpectedRevision); e != nil {
		return j, "", errors.New("invalid revision")
	}
	if _, e = time.Parse(time.RFC3339Nano, j.ExpiresAt); e != nil {
		return j, "", errors.New("invalid expiry")
	}
	hash := sha256.Sum256(b)
	return j, hex.EncodeToString(hash[:]), nil
}

type receipt struct {
	Hash   string    `json:"hash"`
	State  string    `json:"state"`
	Result JobResult `json:"result"`
}

// Sync file and directory before side effects; a running receipt is ambiguous after a crash.
func atomicWrite(path string, b []byte, mode os.FileMode) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".qiyun-")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, path); e != nil {
		return e
	}
	return syncDirectory(filepath.Dir(path))
}

type JobBackend interface {
	Current(context.Context, string) (Service, string, error)
	Restart(context.Context, Service, string) error
}

func (c *Collector) Current(ctx context.Context, id string) (Service, string, error) {
	return c.find(ctx, id)
}
func (c *Collector) Restart(ctx context.Context, s Service, target string) error {
	if s.Kind == "docker" {
		_, e := c.docker(ctx, "POST", "/containers/"+target+"/restart?t=10")
		return e
	}
	_, e := command(ctx, "/usr/bin/systemctl", "restart", "--", target)
	return e
}

type Engine struct {
	HostID  string
	Key     ed25519.PublicKey
	Dir     string
	Backend JobBackend
	mu      sync.Mutex
}

func (e *Engine) path(id string) string { return filepath.Join(e.Dir, revision(id)+".json") }
func (e *Engine) save(id string, r receipt) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return atomicWrite(e.path(id), b, 0600)
}
func (e *Engine) Recover() error {
	if err := os.MkdirAll(e.Dir, 0700); err != nil {
		return err
	}
	files, err := os.ReadDir(e.Dir)
	if err != nil {
		return err
	}
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(e.Dir, f.Name()))
		if err != nil {
			return err
		}
		var r receipt
		if err = decodeStrict(b, &r); err != nil {
			return errors.New("corrupt receipt: operator reconciliation required")
		}
		if r.State == "running" {
			r.State = "done"
			r.Result.Status = "unknown"
			r.Result.Detail = "Helper restarted during execution; reconcile service state before issuing a new job"
			if err = e.save(r.Result.JobID, r); err != nil {
				return err
			}
		}
	}
	return nil
}
func (e *Engine) Execute(ctx context.Context, signed SignedJob) JobResult {
	e.mu.Lock()
	defer e.mu.Unlock() // Serializes checks and writes across all local resources.
	j, hash, err := VerifySigned(signed, e.Key, e.HostID)
	if err != nil {
		return JobResult{Status: "failed", Detail: err.Error()}
	}
	result := JobResult{JobID: j.ID, Status: "failed"}
	b, err := os.ReadFile(e.path(j.ID))
	if err == nil {
		var old receipt
		if decodeStrict(b, &old) != nil {
			result.Status = "unknown"
			result.Detail = "Invalid durable receipt; reconciliation required"
			return result
		}
		if old.Hash != hash {
			result.Detail = "Job identifier reused with a different payload"
			return result
		}
		return old.Result
	}
	if !os.IsNotExist(err) {
		result.Status = "unknown"
		result.Detail = "Cannot read execution receipt"
		return result
	}
	expiry, _ := time.Parse(time.RFC3339Nano, j.ExpiresAt)
	if !time.Now().Before(expiry) {
		result.Detail = "Job authorization expired"
		return result
	}
	before, target, err := e.Backend.Current(ctx, j.ServiceID)
	if err != nil {
		result.Detail = "Service unavailable or outside local restart allowlist"
		return result
	}
	if !before.RestartAllowed {
		result.Detail = "Local restart policy denied this service"
		return result
	}
	if before.Revision != j.ExpectedRevision {
		result.Detail = "Service revision drifted; prepare a new approval"
		return result
	}
	if ctx.Err() != nil || !time.Now().Before(expiry) {
		result.Detail = "Job expired or cancelled during precondition check; no action performed"
		return result
	}
	result.Status = "unknown"
	result.Detail = "Execution started; outcome not yet confirmed"
	r := receipt{Hash: hash, State: "running", Result: result}
	if err = e.save(j.ID, r); err != nil {
		result.Detail = "Could not persist execution receipt; no action performed"
		return result
	}
	if ctx.Err() != nil || !time.Now().Before(expiry) {
		result.Status = "failed"
		result.Detail = "Authorization expired before execution; no action performed"
	} else if err = e.Backend.Restart(ctx, before, target); err != nil {
		result.Detail = "Restart returned an error or timed out; outcome requires reconciliation"
	} else {
		deadline := time.Now().Add(20 * time.Second)
		result.Status = "failed"
		result.Detail = "Restart accepted but health verification did not succeed"
		for {
			after, _, checkErr := e.Backend.Current(ctx, j.ServiceID)
			if checkErr == nil {
				result.Revision = after.Revision
				if after.Status == "healthy" && after.Revision != before.Revision {
					result.Status = "succeeded"
					result.Detail = "Restart completed and service reports healthy"
					break
				}
			}
			if time.Now().After(deadline) || ctx.Err() != nil {
				if checkErr != nil || ctx.Err() != nil {
					result.Status = "unknown"
					result.Detail = "Restart accepted; verification unavailable"
				}
				break
			}
			select {
			case <-ctx.Done():
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
	r.State = "done"
	r.Result = result
	if err = e.save(j.ID, r); err != nil {
		return JobResult{JobID: j.ID, Status: "unknown", Detail: "Action may have completed, but final receipt could not be persisted"}
	}
	return result
}
