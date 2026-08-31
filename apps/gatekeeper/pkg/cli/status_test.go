package cli_test

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

func liveSnapshot() status.Snapshot {
	denied := admittedReport()
	denied.Endpoint = "qwen25-72b"
	denied.Hostname = "qwen25-72b.tee.swarm.cloud"
	denied.Admitted = false
	denied.Pinned = false
	denied.EvidenceDigest = pinB
	denied.Policies = []status.PolicyResult{{Package: "gatekeeper.default", Allow: false}}

	return status.Snapshot{
		At: fixedNow,
		Endpoints: []status.Endpoint{
			{
				Name: "llama-33-70b", Listen: "127.0.0.1:8443",
				Upstream: "https://llama-33-70b.tee.swarm.cloud", FailMode: "closed",
				Health: status.Confidential, LastAttestAt: fixedNow.Add(-90 * time.Second),
				NextAttestAt:      fixedNow.Add(3 * time.Minute),
				RequestsPerSecond: 4.25, BytesIn: 51_200, BytesOut: 1_048_576,
				Report: admittedReport(),
			},
			{
				Name: "qwen25-72b", Listen: "127.0.0.1:8444",
				Upstream: "https://qwen25-72b.tee.swarm.cloud", FailMode: "open",
				Health: status.NonConfidential, Reason: "the published evidenceDigest is not pinned",
				LastAttestAt:      fixedNow.Add(-20 * time.Second),
				RequestsPerSecond: 0.5, BytesIn: 2_048, BytesOut: 8_192,
				Report: denied, PublishedDigest: pinB,
			},
			{
				Name: "mistral-large", Listen: "127.0.0.1:8445",
				Upstream: "https://mistral-large.tee.swarm.cloud", FailMode: "closed",
				Health: status.Stopped, Reason: "listener stopped",
			},
		},
	}
}

func TestStatusListsEveryEndpoint(t *testing.T) {
	h := configured(t)
	h.env.Supervisor = &fakeSupervisor{snapshot: liveSnapshot()}

	golden(t, "status", h.mustRun("status").stdout)
	golden(t, "status-endpoint", h.mustRun("status", "--endpoint", "llama-33-70b").stdout)
}

func TestStatusFlagsFailOpenTrafficWithoutAVerdict(t *testing.T) {
	h := configured(t)
	h.env.Supervisor = &fakeSupervisor{snapshot: liveSnapshot()}

	got := h.mustRun("status")
	// The one thing a glance at this table must not miss.
	if !strings.Contains(got.stdout, "proxying WITHOUT a valid verdict") {
		t.Errorf("stdout = %q, want the fail-open endpoint called out", got.stdout)
	}
}

func TestStatusSaysWhyItCannotReachAGatekeeper(t *testing.T) {
	// `status` reports on a gatekeeper running somewhere else, and the admin
	// socket is the only way to reach one. Both ways of not having it are told
	// apart, because the fix is different: add the section, or start the proxy.
	t.Run("no admin socket is configured", func(t *testing.T) {
		h := configured(t)
		got := h.run("status")
		if got.code != cli.ExitUnavailable {
			t.Errorf("exit = %d, want %d (stderr: %s)", got.code, cli.ExitUnavailable, got.stderr)
		}
		if !strings.Contains(got.stderr, "admin socket") {
			t.Errorf("stderr = %q, want it to name what is missing", got.stderr)
		}
	})

	t.Run("nothing is listening on it", func(t *testing.T) {
		h := configured(t)
		socket := filepath.Join(h.dir, "gatekeeper.sock")
		h.appendConfig("\nadmin:\n  listen: unix:" + socket + "\n")

		got := h.run("status")
		if got.code != cli.ExitUnavailable {
			t.Errorf("exit = %d, want %d (stderr: %s)", got.code, cli.ExitUnavailable, got.stderr)
		}
		if !strings.Contains(got.stderr, "is `gatekeeper run` up?") {
			t.Errorf("stderr = %q, want it to point at the thing that is not running", got.stderr)
		}
	})
}

func TestStatusUnknownEndpointIsAUsageError(t *testing.T) {
	h := configured(t)
	h.env.Supervisor = &fakeSupervisor{snapshot: liveSnapshot()}
	if got := h.run("status", "--endpoint", "nope"); got.code != cli.ExitUsage {
		t.Errorf("exit = %d, want %d", got.code, cli.ExitUsage)
	}
}
