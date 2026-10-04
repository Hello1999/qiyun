package qiyun

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestDockerScopedCollectionAndImmutableRestartTarget(t *testing.T) {
	restarted := ""
	started := "2026-10-04T00:00:00Z"
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.URL.Path == "/containers/json":
			if !strings.Contains(r.URL.Query().Get("filters"), "qiyun.managed=true") {
				t.Error("discovery omitted managed label filter")
			}
			_ = json.NewEncoder(w).Encode([]map[string]interface{}{{"Names": []string{"/labeled"}}})
		case strings.HasSuffix(r.URL.Path, "/json"):
			name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/containers/"), "/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"Id": "immutable-id-" + name, "Name": "/" + name, "Image": "sha256:image", "Config": map[string]interface{}{"Image": "fixture:v1", "Labels": map[string]string{"qiyun.managed": "true"}, "Env": []string{"SECRET=must-not-leak"}}, "State": map[string]interface{}{"Status": "running", "Running": true, "StartedAt": started, "FinishedAt": "0001-01-01T00:00:00Z"}})
		case strings.HasSuffix(r.URL.Path, "/logs"):
			_, _ = w.Write([]byte("2026-10-04T00:00:00Z token=redact-me\n"))
		case strings.HasSuffix(r.URL.Path, "/restart"):
			if r.Method != "POST" {
				t.Error("wrong restart method")
			}
			restarted = r.URL.Path
			started = "2026-10-04T00:01:00Z"
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected Docker endpoint %s", r.URL)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	c := NewCollector(Config{HostID: "host", DockerSocket: "fixture", DockerContainers: []string{"web"}, DockerRestartAllowlist: []string{"web"}, DiscoverManaged: true})
	c.Docker = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}}}
	snap := c.Services(context.Background())
	if len(snap.Services) != 2 {
		t.Fatal(snap.Services)
	}
	for _, service := range snap.Services {
		if service.Name == "labeled" && service.RestartAllowed {
			t.Fatal("label granted restart permission")
		}
		for _, line := range snap.Logs[service.ID] {
			if strings.Contains(line.Message, "redact-me") {
				t.Fatal("raw credential exposed")
			}
		}
	}
	if _, _, err := c.Current(context.Background(), "host:docker:labeled"); err == nil {
		t.Fatal("discovered service bypassed independent restart list")
	}
	before, target, err := c.Current(context.Background(), "host:docker:web")
	if err != nil {
		t.Fatal(err)
	}
	if target != "immutable-id-web" {
		t.Fatal(target)
	}
	if err = c.Restart(context.Background(), before, target); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	actual := restarted
	mu.Unlock()
	if actual != "/containers/immutable-id-web/restart" {
		t.Fatal(actual)
	}
	after, _, err := c.Current(context.Background(), before.ID)
	if err != nil || after.Revision == before.Revision {
		t.Fatal("restart revision did not change")
	}
}
