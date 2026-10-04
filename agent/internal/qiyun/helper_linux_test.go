//go:build linux

package qiyun

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPeerUIDAcceptedAndRejected(t *testing.T) {
	for _, allowed := range []bool{true, false} {
		t.Run(map[bool]string{true: "correct", false: "wrong"}[allowed], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "helper.sock")
			ln, e := net.Listen("unix", path)
			if e != nil {
				t.Fatal(e)
			}
			defer ln.Close()
			uid := uint32(os.Getuid())
			if !allowed {
				uid++
			}
			peers := peerListener{Listener: ln, uid: uid}
			accepted := make(chan bool, 1)
			go func() {
				c, e := peers.Accept()
				if e == nil {
					c.Close()
					accepted <- true
				} else {
					accepted <- false
				}
			}()
			c, e := net.Dial("unix", path)
			if e != nil {
				t.Fatal(e)
			}
			defer c.Close()
			if allowed {
				select {
				case ok := <-accepted:
					if !ok {
						t.Fatal("matching UID rejected")
					}
				case <-time.After(time.Second):
					t.Fatal("accept timed out")
				}
			} else {
				_ = c.SetReadDeadline(time.Now().Add(time.Second))
				_, e = c.Read(make([]byte, 1))
				if e == nil {
					t.Fatal("wrong UID connection remained open")
				}
				select {
				case ok := <-accepted:
					if ok {
						t.Fatal("wrong UID accepted")
					}
				default:
				}
			}
		})
	}
}
func TestStateLockExcludesOtherExecutor(t *testing.T) {
	dir := t.TempDir()
	release, e := lockState(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer release()
	second, e := lockState(dir)
	if e == nil {
		second()
		t.Fatal("duplicate executor acquired lock")
	}
}
