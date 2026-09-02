package cli_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
)

// TestPinlessEndpointFollowsTheWarningsOwnScript walks the sequence
// `gatekeeper init` and `endpoint add` both print, end to end against a live
// endpoint, with nothing injected: fresh config → trusted root → pin-less
// endpoint → `trust add --from-upstream` → `verify` admits.
//
// It exists because that sequence used to be impossible to follow. `endpoint
// add` writes an endpoint with no pins and tells you to run
// `endpoint trust add --from-upstream`; loading the file then failed on
// "at least one pinned evidenceDigest is required", including for the very
// command that would have added one. Only `run` may insist the file is
// complete, so every step below has to work on a config that is not.
func TestPinlessEndpointFollowsTheWarningsOwnScript(t *testing.T) {
	digest := testDigest("deployment A")
	host := newEvidenceHost(t, digest)

	h := newHarness(t)
	// The bundle is signed against the real clock, so the report is rendered
	// against it too rather than against the golden-file clock.
	h.env.Now = time.Now

	h.mustRun("init")
	h.mustRun("trust", "roots", "add", "swarm-cloud-test", "--pem-file", h.write("root.pem", host.RootPEM))

	added := h.mustRun("endpoint", "add", "router", "--listen", "127.0.0.1:8443", "--upstream", host.Upstream())
	if !strings.Contains(added.stderr, "endpoint trust add router --from-upstream") {
		t.Fatalf("stderr = %q, want the warning that names the next command", added.stderr)
	}

	// Everything that only reads or inspects has to work on the file that
	// warning just produced — this is the catch-22 itself.
	for _, args := range [][]string{
		{"endpoint", "list"},
		{"endpoint", "trust", "list", "router"},
		{"policy", "list"},
		{"endpoint", "discover", "router"},
	} {
		if got := h.run(args...); got.code != cli.ExitOK {
			t.Errorf("gatekeeper %s: exit %d, want 0\nstderr: %s", strings.Join(args, " "), got.code, got.stderr)
		}
	}

	// `config validate` is the one command whose job is to report the config as
	// unfinished, so it reads the file and says so rather than failing to load.
	notReady := h.run("config", "validate")
	if notReady.code != cli.ExitConfig {
		t.Fatalf("config validate exit = %d, want %d", notReady.code, cli.ExitConfig)
	}
	if !strings.Contains(notReady.stdout, "not ready to run") {
		t.Errorf("stdout = %q, want the config reported as unfinished", notReady.stdout)
	}

	// Verified but not admitted: the endpoint checks out cryptographically and
	// there is nothing pinned to admit it. That is the state the pin fixes, and
	// the digest to pin is right there in the report.
	before := h.run("verify", "router")
	if before.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d, want %d\nstdout: %s\nstderr: %s",
			before.code, cli.ExitDenied, before.stdout, before.stderr)
	}
	if !strings.Contains(before.stdout, digest) {
		t.Errorf("stdout = %q, want the published digest", before.stdout)
	}

	pinned := h.mustRun("endpoint", "trust", "add", "router", "--from-upstream", "--yes")
	if !strings.Contains(pinned.stdout, digest) {
		t.Errorf("stdout = %q, want the pinned digest", pinned.stdout)
	}
	if !strings.Contains(h.config(), digest) {
		t.Error("the published digest did not reach the config file")
	}

	after := h.mustRun("verify", "router")
	if !strings.Contains(after.stdout, "ADMITTED") {
		t.Errorf("stdout = %q, want the endpoint admitted once its digest is pinned", after.stdout)
	}

	// And the file is now complete, which is what `run` needs.
	h.mustRun("config", "validate")
}

// TestPinlessEndpointVerifiesTheLiveChannelBinding is the same live path,
// asserting that the verdict came from the real pipeline rather than from a
// bundle taken at its word: the digest is pinned, the deployment then changes,
// and the very next check refuses it.
func TestPinlessEndpointVerifiesTheLiveChannelBinding(t *testing.T) {
	host := newEvidenceHost(t, testDigest("deployment A"))

	h := newHarness(t)
	h.env.Now = time.Now
	h.mustRun("init")
	h.mustRun("trust", "roots", "add", "swarm-cloud-test", "--pem-file", h.write("root.pem", host.RootPEM))
	h.mustRun("endpoint", "add", "router", "--listen", "127.0.0.1:8443", "--upstream", host.Upstream())
	h.mustRun("endpoint", "trust", "add", "router", "--from-upstream", "--yes")

	report := h.mustRun("verify", "router", "--json")
	for _, want := range []string{`"verified": true`, `"admitted": true`, `"pinned": true`} {
		if !strings.Contains(report.stdout, want) {
			t.Errorf("report does not contain %s:\n%s", want, report.stdout)
		}
	}
	// The binding is the one this process observed on its own handshake, not
	// one the endpoint asserted about itself.
	if !strings.Contains(report.stdout, `"observedTlsFingerprint"`) {
		t.Errorf("report carries no observed fingerprint:\n%s", report.stdout)
	}

	host.Publish(testDigest("deployment B"))
	rotated := h.run("verify", "router")
	if rotated.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d after a redeployment, want %d\nstdout: %s", rotated.code, cli.ExitDenied, rotated.stdout)
	}
}

// TestPolicyTestRunsAgainstAPinlessConfig covers the offline half of the same
// rule: checking what your policies would say is a thing to do *before* the
// first pin exists, so it must not require one.
func TestPolicyTestRunsAgainstAPinlessConfig(t *testing.T) {
	h := newHarness(t)
	h.mustRun("init")
	h.mustRun("trust", "roots", "add", "swarm-cloud-prod", "--pem-file", h.write("root.pem", rootPEM(t)))
	h.mustRun("endpoint", "add", "llama-33-70b",
		"--listen", "127.0.0.1:8443", "--upstream", "https://llama-33-70b.tee.swarm.cloud")
	bundle := h.write("bundle.json", bundleJSON(t, "llama-33-70b.tee.swarm.cloud", pinA, rootPEM(t)))

	// It loads, evaluates, and denies for the right reason — nothing is pinned,
	// which is the answer, not an obstacle to reaching one.
	got := h.run("policy", "test", bundle)
	if got.code != cli.ExitDenied {
		t.Fatalf("exit = %d, want %d\nstdout: %s\nstderr: %s", got.code, cli.ExitDenied, got.stdout, got.stderr)
	}
	if strings.Contains(got.stderr, "trustedEvidence") {
		t.Errorf("stderr = %q, want the command to run rather than refuse the config", got.stderr)
	}
}

// TestEndpointCommandsResolveTheUpstreamPort guards the detail that makes the
// live test above meaningful: a configured endpoint is verified at its own
// upstream's port, not at 443.
func TestEndpointCommandsResolveTheUpstreamPort(t *testing.T) {
	host := newEvidenceHost(t, testDigest("deployment A"))

	h := newHarness(t)
	h.env.Now = time.Now
	h.mustRun("init")
	h.mustRun("trust", "roots", "add", "swarm-cloud-test", "--pem-file", h.write("root.pem", host.RootPEM))
	h.mustRun("endpoint", "add", "router", "--listen", "127.0.0.1:8443", "--upstream", host.Upstream())

	got := h.mustRun("endpoint", "discover", "router", "--json")
	if !strings.Contains(got.stdout, fmt.Sprintf(`"port": %d`, portOf(t, host.Upstream()))) {
		t.Errorf("report does not name the upstream's port:\n%s", got.stdout)
	}
}
