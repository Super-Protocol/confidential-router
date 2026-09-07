package cli_test

import (
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// pinA and pinB are stable evidenceDigest values.
var (
	pinA = trust.Sum([]byte("deployment A")).String()
	pinB = trust.Sum([]byte("deployment B")).String()
)

// configured builds a harness whose config is complete: one root, one pinned
// endpoint. It is the starting point for everything that is not about building
// a config up from nothing.
func configured(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	h.mustRun("init")
	h.mustRun("trust", "roots", "add", "swarm-cloud-prod", "--pem-file", h.write("root.pem", rootPEM(t)))
	h.mustRun("endpoint", "add", "llama-33-70b",
		"--listen", "127.0.0.1:8443", "--upstream", "https://llama-33-70b.tee.swarm.cloud",
		"--trust", pinA)
	return h
}

func TestBuildingAConfigUpFromNothing(t *testing.T) {
	h := configured(t)

	// Each command edits the file in place, so the comments the starter config
	// shipped with have to still be there at the end.
	if !strings.Contains(h.config(), "# Confidential Router — gatekeeper configuration.") {
		t.Error("editing the config dropped its comments")
	}
	golden(t, "config-after-build", h.scrub(h.config()))

	if got := h.mustRun("config", "validate"); !strings.Contains(got.stdout, "valid and ready to run") {
		t.Errorf("config validate = %q, want a ready configuration", got.stdout)
	}
	golden(t, "trust-roots-list", h.mustRun("trust", "roots", "list").stdout)
	golden(t, "endpoint-list", h.mustRun("endpoint", "list").stdout)
	golden(t, "endpoint-list-json", h.mustRun("endpoint", "list", "--json").stdout)
}

func TestAddingAnAlreadyTrustedRootIsANoOp(t *testing.T) {
	h := configured(t)
	// Roots are identified by fingerprint, not by the name someone gave them.
	got := h.mustRun("trust", "roots", "add", "a-different-name", "--pem-file", h.write("again.pem", rootPEM(t)))
	if !strings.Contains(got.stdout, `Already trusted as "swarm-cloud-prod"`) {
		t.Errorf("stdout = %q, want it to name the existing root", got.stdout)
	}
	if strings.Count(h.config(), "BEGIN CERTIFICATE") != 1 {
		t.Error("the certificate was written twice")
	}
}

func TestRemovingTheLastRootWarns(t *testing.T) {
	h := configured(t)
	got := h.mustRun("trust", "roots", "rm", "swarm-cloud-prod")
	if !strings.Contains(got.stderr, "no trusted roots remain") {
		t.Errorf("stderr = %q, want a warning that the manual list is now empty", got.stderr)
	}
	if !strings.Contains(got.stderr, "attestedRoots") {
		t.Errorf("stderr = %q, want it to say what is left: the attested-root anchor", got.stderr)
	}
	// A rootless config still runs, because the attested-root anchor can supply
	// one. That is the point of the second anchor, and it is why removing the
	// last root is no longer a config error.
	if code := h.run("config", "validate").code; code != cli.ExitOK {
		t.Errorf("config validate exit = %d, want %d", code, cli.ExitOK)
	}
	if code := h.run("trust", "roots", "list").code; code != cli.ExitOK {
		t.Errorf("trust roots list exit = %d; a rootless config must still be readable", code)
	}
}

func TestRemovingSomethingThatIsNotThere(t *testing.T) {
	h := configured(t)
	for _, args := range [][]string{
		{"trust", "roots", "rm", "nope"},
		{"endpoint", "rm", "nope"},
		{"endpoint", "trust", "rm", "llama-33-70b", pinB},
	} {
		got := h.run(args...)
		if got.code != cli.ExitError {
			t.Errorf("%v: exit = %d, want %d", args, got.code, cli.ExitError)
		}
	}
}

func TestPinsAreNormalisedAndMatchedAcrossSpellings(t *testing.T) {
	h := configured(t)
	digest, err := trust.ParseDigest(pinB)
	if err != nil {
		t.Fatal(err)
	}

	// Pinned as hex; the file records the canonical form.
	h.mustRun("endpoint", "trust", "add", "llama-33-70b", digest.Hex())
	if !strings.Contains(h.config(), pinB) {
		t.Error("the hex pin was not normalised on the way into the file")
	}

	// Adding the same digest again, spelled differently, changes nothing.
	got := h.mustRun("endpoint", "trust", "add", "llama-33-70b", "sha256:"+digest.Hex())
	if !strings.Contains(got.stdout, "already pinned") {
		t.Errorf("stdout = %q, want the duplicate to be recognised", got.stdout)
	}
	golden(t, "endpoint-trust-list", h.mustRun("endpoint", "trust", "list", "llama-33-70b").stdout)

	// And it can be removed by any spelling too.
	h.mustRun("endpoint", "trust", "rm", "llama-33-70b", digest.Hex())
	if strings.Contains(h.config(), pinB) {
		t.Error("the pin survived its removal")
	}
}

func TestUnpinningEverythingWarnsInsteadOfFailing(t *testing.T) {
	h := configured(t)
	got := h.mustRun("endpoint", "trust", "rm", "llama-33-70b", pinA)
	if !strings.Contains(got.stderr, "no pins left") {
		t.Errorf("stderr = %q, want a warning that the endpoint can no longer admit traffic", got.stderr)
	}
	if code := h.run("config", "validate").code; code != cli.ExitConfig {
		t.Error("a config with an unpinned endpoint should not be reported as ready")
	}
}

func TestAddingAnEndpointWithoutPinsWarns(t *testing.T) {
	h := newHarness(t)
	h.mustRun("init")
	h.mustRun("trust", "roots", "add", "prod", "--pem-file", h.write("root.pem", rootPEM(t)))

	got := h.mustRun("endpoint", "add", "qwen25-72b",
		"--listen", "127.0.0.1:8444", "--upstream", "https://qwen25-72b.tee.swarm.cloud")
	if !strings.Contains(got.stderr, "cannot admit traffic yet") {
		t.Errorf("stderr = %q, want a warning about the missing pin", got.stderr)
	}
}

func TestMalformedInputIsAUsageError(t *testing.T) {
	h := configured(t)
	cases := [][]string{
		{"endpoint", "add", "x", "--listen", "127.0.0.1:9000", "--upstream", "https://x.example", "--trust", "nonsense"},
		{"endpoint", "trust", "add", "llama-33-70b", "nonsense"},
		{"endpoint", "trust", "add", "llama-33-70b"},
		{"endpoint", "trust", "add", "llama-33-70b", pinB, "--from-upstream"},
		{"endpoint", "trust", "list", "nope"},
		{"verify"},
	}
	for _, args := range cases {
		if got := h.run(args...); got.code != cli.ExitUsage {
			t.Errorf("%v: exit = %d, want %d (stderr: %s)", args, got.code, cli.ExitUsage, got.stderr)
		}
	}
}

func TestDuplicateEndpointIsRejected(t *testing.T) {
	h := configured(t)
	got := h.run("endpoint", "add", "llama-33-70b",
		"--listen", "127.0.0.1:9999", "--upstream", "https://other.example", "--trust", pinB)
	if got.code == cli.ExitOK {
		t.Fatal("adding a duplicate endpoint succeeded")
	}
	if !strings.Contains(got.stderr, "already exists") {
		t.Errorf("stderr = %q, want it to say the name is taken", got.stderr)
	}
	// A rejected edit must not reach the file.
	if strings.Contains(h.config(), "127.0.0.1:9999") {
		t.Error("the rejected endpoint was written anyway")
	}
}
