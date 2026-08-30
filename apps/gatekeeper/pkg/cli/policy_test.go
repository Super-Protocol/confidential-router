package cli_test

import (
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
)

const imagePolicy = `package images

import rego.v1

default allow := false

allow if {
	every image in input.evidence.containerImages {
		startswith(image, "ghcr.io/super-protocol/")
	}
}
`

func TestPolicyListShowsWhatWouldBeEvaluated(t *testing.T) {
	h := configured(t)
	golden(t, "policy-list", h.mustRun("policy", "list").stdout)
}

func TestPolicyListCompilesUserPolicies(t *testing.T) {
	h := configured(t)
	h.write("images.rego", imagePolicy)
	withPolicy(h, "images-from-our-registry", "./images.rego")

	got := h.mustRun("policy", "list")
	if !strings.Contains(got.stdout, "images-from-our-registry") {
		t.Errorf("stdout = %q, want the user policy listed", got.stdout)
	}

	// The generated trust module is what every policy reads; being able to see
	// it is the difference between debugging a policy and guessing.
	shown := h.mustRun("policy", "list", "--show-trust-module")
	if !strings.Contains(shown.stdout, "package gatekeeper.trust") {
		t.Errorf("stdout = %q, want the generated module", shown.stdout)
	}
}

func TestPolicyListRejectsABrokenPolicyAtLoad(t *testing.T) {
	h := configured(t)
	h.write("broken.rego", "package broken\n\nthis is not rego\n")
	withPolicy(h, "broken", "./broken.rego")

	got := h.run("policy", "list")
	if got.code != cli.ExitConfig {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitConfig)
	}
	if !strings.Contains(got.stderr, "broken.rego") {
		t.Errorf("stderr = %q, want the offending file named", got.stderr)
	}
}

func TestPolicyTestIsHonestAboutAPolicyOnlyRun(t *testing.T) {
	h := configured(t)
	bundle := h.write("bundle.json", bundleJSON(t, "llama-33-70b.tee.swarm.cloud", pinA, rootPEM(t)))

	// The digest is pinned, so the policies allow — and the command still says
	// the bundle was not admitted, because nothing was cryptographically
	// verified.
	got := h.mustRun("policy", "test", bundle)
	golden(t, "policy-test-allow", strings.ReplaceAll(got.stdout, bundle, "$TMP/bundle.json"))
	if !strings.Contains(got.stdout, "Admitted: no") {
		t.Errorf("stdout = %q, want an honest Admitted line", got.stdout)
	}
}

func TestPolicyTestExitsThreeOnDeny(t *testing.T) {
	h := configured(t)
	bundle := h.write("bundle.json", bundleJSON(t, "llama-33-70b.tee.swarm.cloud", pinB, rootPEM(t)))

	got := h.run("policy", "test", bundle)
	if got.code != cli.ExitDenied {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitDenied)
	}
	golden(t, "policy-test-deny", strings.ReplaceAll(got.stdout, bundle, "$TMP/bundle.json"))
}

func TestPolicyTestRunsUserPoliciesToo(t *testing.T) {
	h := configured(t)
	h.write("images.rego", strings.Replace(imagePolicy, "ghcr.io/super-protocol/", "example.com/", 1))
	withPolicy(h, "images-from-our-registry", "./images.rego")
	bundle := h.write("bundle.json", bundleJSON(t, "llama-33-70b.tee.swarm.cloud", pinA, rootPEM(t)))

	got := h.run("policy", "test", bundle)
	if got.code != cli.ExitDenied {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitDenied)
	}
	// Every package is evaluated, not just up to the first deny: an operator
	// debugging a rejection wants the whole picture.
	if !strings.Contains(got.stdout, "gatekeeper.default") || !strings.Contains(got.stdout, "images") {
		t.Errorf("stdout = %q, want both packages reported", got.stdout)
	}
}

func TestPolicyTestShowsTheInputDocument(t *testing.T) {
	h := configured(t)
	bundle := h.write("bundle.json", bundleJSON(t, "llama-33-70b.tee.swarm.cloud", pinA, rootPEM(t)))

	got := h.mustRun("policy", "test", bundle, "--show-input")
	for _, want := range []string{`"evidenceDigestHex"`, `"containerImages"`, `"channelBinding": "observed"`} {
		if !strings.Contains(got.stdout, want) {
			t.Errorf("stdout does not contain %s:\n%s", want, got.stdout)
		}
	}
}

// withPolicy appends a policies[] entry to the harness config.
func withPolicy(h *harness, name, file string) {
	h.t.Helper()
	updated := strings.Replace(h.config(), "\ndefaults:\n",
		"\npolicies:\n  - name: "+name+"\n    file: "+file+"\ndefaults:\n", 1)
	h.write("config.yaml", updated)
}
