//go:build linux

package qiyun

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Every ancestor must resist replacement by the Agent user, including symlink targets.
func protectedPath(path string) error {
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return errors.New("protected path must be absolute")
	}
	for {
		s, e := os.Lstat(path)
		if e != nil {
			return e
		}
		st, ok := s.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || s.Mode().Perm()&0022 != 0 || s.Mode()&os.ModeSymlink != 0 {
			return errors.New("helper paths must be root-owned, non-symlink and not group/world writable")
		}
		if path == "/" {
			return nil
		}
		path = filepath.Dir(path)
	}
}
func lockState(dir string) (func(), error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("another process holds the state directory")
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}

type peerListener struct {
	net.Listener
	uid uint32
}

func (l peerListener) Accept() (net.Conn, error) {
	for {
		c, e := l.Listener.Accept()
		if e != nil {
			return nil, e
		}
		u, ok := c.(*net.UnixConn)
		if !ok {
			c.Close()
			continue
		}
		raw, e := u.SyscallConn()
		if e != nil {
			c.Close()
			continue
		}
		allowed := false
		e = raw.Control(func(fd uintptr) {
			cred, e := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
			allowed = e == nil && cred.Uid == l.uid
		})
		if e == nil && allowed {
			return c, nil
		}
		c.Close()
	}
}
func Helper(ctx context.Context, c Config, configPath string) error {
	if os.Geteuid() != 0 {
		return errors.New("helper requires root; run the network Agent as an unprivileged separate user")
	}
	if c.AgentUID == 0 {
		return errors.New("helper refuses a root Agent peer")
	}
	if c.HelperSocket == "" {
		return errors.New("helperSocket required")
	}
	if e := protectedPath(configPath); e != nil {
		return e
	}
	if e := protectedPath(c.SigningPublicKeyFile); e != nil {
		return e
	}
	key, e := PublicKey(c.SigningPublicKeyFile)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(c.StateDir, 0700); e != nil {
		return e
	}
	if e = protectedPath(c.StateDir); e != nil {
		return e
	}
	release, e := lockState(c.StateDir)
	if e != nil {
		return e
	}
	defer release()
	dir := filepath.Dir(c.HelperSocket)
	if e = os.MkdirAll(dir, 0750); e != nil {
		return e
	}
	if e = protectedPath(dir); e != nil {
		return e
	}
	if e = os.Chown(dir, 0, c.AgentGID); e != nil {
		return e
	}
	if e = os.Chmod(dir, 0750); e != nil {
		return e
	}
	if s, e := os.Lstat(c.HelperSocket); e == nil {
		if s.Mode()&os.ModeSocket == 0 {
			return errors.New("helper socket path is not a socket")
		}
		if e = os.Remove(c.HelperSocket); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	ln, e := net.Listen("unix", c.HelperSocket)
	if e != nil {
		return e
	}
	defer ln.Close()
	defer os.Remove(c.HelperSocket)
	if e = os.Chown(c.HelperSocket, 0, c.AgentGID); e != nil {
		return e
	}
	if e = os.Chmod(c.HelperSocket, 0660); e != nil {
		return e
	}
	collector := NewCollector(c)
	engine := &Engine{HostID: c.HostID, Key: key, Dir: filepath.Join(c.StateDir, "receipts"), Backend: collector}
	if e = engine.Recover(); e != nil {
		return e
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/services", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.RawQuery != "" {
			http.Error(w, "method not allowed", 405)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
		defer cancel()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(collector.Services(ctx))
	})
	mux.HandleFunc("/restart", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.Error(w, "method not allowed", 405)
			return
		}
		b, e := io.ReadAll(io.LimitReader(r.Body, 20001))
		if e != nil || len(b) > 20000 {
			http.Error(w, "invalid body", 400)
			return
		}
		var signed SignedJob
		if decodeStrict(b, &signed) != nil {
			http.Error(w, "invalid job envelope", 400)
			return
		}
		if _, _, e = VerifySigned(signed, key, c.HostID); e != nil {
			http.Error(w, "invalid authorization", 403)
			return
		}
		// Disconnect does not erase an accepted operation; its durable receipt remains authoritative.
		execution, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		res := engine.Execute(execution, signed)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 50 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 4096}
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 50*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		close(shutdownDone)
	}()
	e = server.Serve(peerListener{Listener: ln, uid: c.AgentUID})
	if errors.Is(e, http.ErrServerClosed) {
		<-shutdownDone
		return nil
	}
	return e
}
