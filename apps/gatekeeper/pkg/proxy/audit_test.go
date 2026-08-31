package proxy_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/proxy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// readAudit parses the audit log the config pointed at.
func readAudit(t *testing.T, dir string) []proxy.AuditEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "audit.jsonl"))
	if err != nil {
		t.Fatalf("reading the audit log: %v", err)
	}
	var out []proxy.AuditEntry
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var entry proxy.AuditEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("audit line is not JSON (%v): %s", err, line)
		}
		out = append(out, entry)
	}
	return out
}

func TestAuditLogRecordsVerdictsAndNeverBodies(t *testing.T) {
	pki := newPKI(t)
	published := digestOf("audited deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: published,
	}))
	dir := t.TempDir()
	cfg := writeConfig(t, dir, configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{digestOf("not what it publishes")},
			reattestInterval: "1h", verdictCacheTTL: "1h",
		}},
		auditFile: "audit.jsonl",
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "router", status.Broken)

	// A request with a body that must not appear anywhere in the log, and a
	// query string that must not either.
	secret := "the-user-s-prompt-and-api-key"
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		"http://"+cfg.Endpoints[0].Listen+"/v1/chat/completions?api_key="+secret,
		strings.NewReader(`{"messages":[{"role":"user","content":"`+secret+`"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := localClient().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp := collect(t, raw); resp.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (%s)", resp.status, resp.body)
	}

	entries := readAudit(t, dir)
	var verdicts, blocks int
	for _, entry := range entries {
		switch entry.Event {
		case proxy.AuditVerdict:
			verdicts++
			if entry.Admitted || entry.Stage != "policy" {
				t.Errorf("verdict entry = %+v, want the policy denial", entry)
			}
			if entry.EvidenceDigest != published {
				t.Errorf("evidenceDigest = %q, want what the upstream published", entry.EvidenceDigest)
			}
			if entry.ObservedTLSFingerprint == "" {
				t.Error("the verdict entry does not record the channel it was bound to")
			}
		case proxy.AuditBlocked:
			blocks++
			if entry.Method != http.MethodPost || entry.Path != "/v1/chat/completions" {
				t.Errorf("blocked entry = %+v, want the refused request identified", entry)
			}
			if entry.Status != http.StatusServiceUnavailable || entry.FailMode != "closed" {
				t.Errorf("blocked entry = %+v, want the 503 and the fail mode", entry)
			}
		}
	}
	if verdicts != 1 || blocks != 1 {
		t.Errorf("audit log has %d verdicts and %d blocks, want 1 and 1", verdicts, blocks)
	}

	logged, err := os.ReadFile(filepath.Join(dir, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	// The one thing this file must never contain.
	if strings.Contains(string(logged), secret) {
		t.Fatal("the audit log contains request content — it must record neither bodies nor query strings")
	}
}

func TestAuditLogRecordsUnverifiedTrafficUnderFailOpen(t *testing.T) {
	pki := newPKI(t)
	digest := digestOf("fail-open deployment")
	upstream := newUpstream(t, pki.foreignLeaf.cert, buildBundle(t, bundleSpec{
		signer: pki.foreignLeaf, rootPEM: pki.foreignRootPEM, digest: digest,
	}))
	dir := t.TempDir()
	cfg := writeConfig(t, dir, configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{digest}, failMode: "open",
		}},
		auditFile: "audit.jsonl",
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "router", status.NonConfidential)
	_ = get(t, cfg.Endpoints[0].Listen, "/v1/models", nil).body

	var found bool
	for _, entry := range readAudit(t, dir) {
		if entry.Event != proxy.AuditUnverified {
			continue
		}
		found = true
		// This is the entry an incident review is looking for: traffic flowed,
		// and nothing vouched for where it went.
		if entry.Admitted || entry.Stage != "untrusted-root" || entry.FailMode != "open" {
			t.Errorf("entry = %+v, want an unverified forward naming the stage and the fail mode", entry)
		}
		if entry.Path != "/v1/models" {
			t.Errorf("path = %q, want the forwarded request identified", entry.Path)
		}
	}
	if !found {
		t.Error("nothing recorded that a request was forwarded without a verdict")
	}
}

func TestNoAuditSectionWritesNoFile(t *testing.T) {
	_, _, cfg := admitted(t)
	_ = get(t, cfg.Endpoints[0].Listen, "/v1/models", nil).body

	entries, err := filepath.Glob(filepath.Join(filepath.Dir(cfg.Path), "*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("an audit log was written without an `audit:` section: %v", entries)
	}
}
