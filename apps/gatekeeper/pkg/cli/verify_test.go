package cli_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// admittedReport is what a healthy endpoint's verification looks like.
func admittedReport() *status.Report {
	return &status.Report{
		Endpoint:               "llama-33-70b",
		Hostname:               "llama-33-70b.tee.swarm.cloud",
		Port:                   443,
		CheckedAt:              fixedNow.Add(-30 * time.Second),
		Verified:               true,
		Admitted:               true,
		Pinned:                 true,
		Root:                   "swarm-cloud-prod",
		RootFingerprint:        "sha256/4rDDqk4QaXWLKrWi1GJt1yqZaFoZmQGxU6HcvHAGdKQ",
		ObservedTLSFingerprint: "sha256/4fSxZzcnad7Qy_256p4Hlw7zm-jHTEhgjN31bRF-di0",
		CertFingerprint:        "sha256/4fSxZzcnad7Qy_256p4Hlw7zm-jHTEhgjN31bRF-di0",
		Kind:                   "DeploymentEvidence",
		IssuedAt:               fixedNow.Add(-4 * time.Minute),
		EvidenceDigest:         pinA,
		QuoteFormat:            "intel-tdx-quote-v5",
		Images: []string{
			"ghcr.io/super-protocol/sidecar@sha256:bbbb",
			"ghcr.io/super-protocol/vllm@sha256:aaaa",
		},
		Chain: []status.Certificate{
			{Subject: "CN=llama-33-70b.tee.swarm.cloud", Fingerprint: "sha256/4fSxZzcnad7Qy_256p4Hlw7zm-jHTEhgjN31bRF-di0",
				NotAfter: fixedNow.Add(60 * 24 * time.Hour)},
			{Subject: "CN=swarm-cloud-prod-root", Fingerprint: "sha256/4rDDqk4QaXWLKrWi1GJt1yqZaFoZmQGxU6HcvHAGdKQ",
				NotAfter: fixedNow.Add(4000 * 24 * time.Hour), Root: true},
		},
		Policies: []status.PolicyResult{{Package: "gatekeeper.default", Allow: true}},
	}
}

func TestVerifyPrintsTheWholeReport(t *testing.T) {
	h := configured(t)
	h.env.Verifier = &fakeVerifier{report: admittedReport()}

	got := h.mustRun("verify", "llama-33-70b")
	golden(t, "verify-admitted", got.stdout)

	golden(t, "verify-admitted-json", h.mustRun("verify", "llama-33-70b", "--json").stdout)
}

func TestVerifyResolvesAConfiguredEndpointToItsUpstream(t *testing.T) {
	h := configured(t)
	verifier := &fakeVerifier{report: admittedReport()}
	h.env.Verifier = verifier

	h.mustRun("verify", "llama-33-70b")
	if len(verifier.requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(verifier.requests))
	}
	// The argument is a name, not an address: what gets fetched is the
	// endpoint's upstream, and the verdict is about that endpoint's pins.
	want := status.VerifyRequest{Hostname: "llama-33-70b.tee.swarm.cloud", Port: 443, Endpoint: "llama-33-70b"}
	if verifier.requests[0] != want {
		t.Errorf("request = %+v, want %+v", verifier.requests[0], want)
	}
}

func TestVerifyExitsThreeWhenDenied(t *testing.T) {
	h := configured(t)
	denied := admittedReport()
	denied.Admitted = false
	denied.Pinned = false
	denied.Policies = []status.PolicyResult{{Package: "gatekeeper.default", Allow: false}}
	h.env.Verifier = &fakeVerifier{report: denied}

	got := h.run("verify", "llama-33-70b")
	if got.code != cli.ExitDenied {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitDenied)
	}
	// The report is the output; there is nothing to add underneath it.
	if got.stderr != "" {
		t.Errorf("stderr = %q, want nothing after a full report", got.stderr)
	}
	golden(t, "verify-denied", got.stdout)
}

func TestVerifyReportsAFailedStage(t *testing.T) {
	h := configured(t)
	h.env.Verifier = &fakeVerifier{report: &status.Report{
		Endpoint:        "llama-33-70b",
		Hostname:        "llama-33-70b.tee.swarm.cloud",
		Port:            443,
		CheckedAt:       fixedNow,
		Stage:           "untrusted-root",
		Reason:          "the chain terminates in sha256/xxxx, which is not a trusted root",
		RootFingerprint: "sha256/xxxx",
	}}

	got := h.run("verify", "llama-33-70b")
	if got.code != cli.ExitDenied {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitDenied)
	}
	golden(t, "verify-untrusted-root", got.stdout)
}

func TestVerifyBuildsItsVerifierFromTheConfiguration(t *testing.T) {
	h := configured(t)
	h.write("broken.rego", "package broken\n\nthis is not rego\n")
	withPolicy(h, "broken", "./broken.rego")

	// No verifier is injected, so the command builds the real one — which
	// compiles the policy set, and fails here rather than on the first request.
	got := h.run("verify", "llama-33-70b")
	if got.code != cli.ExitConfig {
		t.Fatalf("exit = %d, want %d (stderr: %s)", got.code, cli.ExitConfig, got.stderr)
	}
	if !strings.Contains(got.stderr, "broken.rego") {
		t.Errorf("stderr = %q, want the offending policy named", got.stderr)
	}
}

func TestVerifierErrorsSurface(t *testing.T) {
	h := configured(t)
	h.env.Verifier = &fakeVerifier{err: errors.New("dial tcp: connection refused")}

	got := h.run("verify", "llama-33-70b")
	if got.code != cli.ExitError {
		t.Errorf("exit = %d, want %d", got.code, cli.ExitError)
	}
	if !strings.Contains(got.stderr, "connection refused") {
		t.Errorf("stderr = %q, want the underlying failure", got.stderr)
	}
}

func TestTrustAddFromUpstreamPinsWhatWasPublished(t *testing.T) {
	h := configured(t)
	report := admittedReport()
	report.EvidenceDigest = pinB
	report.Pinned = false
	h.env.Verifier = &fakeVerifier{report: report}

	got := h.mustRun("endpoint", "trust", "add", "llama-33-70b", "--from-upstream", "--yes")
	if !strings.Contains(got.stdout, pinBShown) {
		t.Errorf("stdout = %q, want the newly pinned digest in hex", got.stdout)
	}
	if !strings.Contains(h.config(), pinBShown) {
		t.Error("the published digest did not reach the config")
	}
	// The report is printed for review before anything is written.
	if !strings.Contains(got.stderr, "ADMITTED") {
		t.Errorf("stderr = %q, want the report that justified the pin", got.stderr)
	}
}

func TestTrustAddFromUpstreamRefusesAnUnverifiedEndpoint(t *testing.T) {
	h := configured(t)
	h.env.Verifier = &fakeVerifier{report: &status.Report{
		Endpoint: "llama-33-70b", Hostname: "llama-33-70b.tee.swarm.cloud",
		Stage: "jws", Reason: "signature does not verify", EvidenceDigest: pinB,
	}}

	got := h.run("endpoint", "trust", "add", "llama-33-70b", "--from-upstream", "--yes")
	if got.code != cli.ExitDenied {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitDenied)
	}
	// A digest from a bundle that failed the cryptographic stages is not
	// evidence of anything, so it must not be written.
	if strings.Contains(h.config(), pinBShown) {
		t.Error("a digest from an unverifiable bundle was pinned")
	}
}

func TestTrustAddFromUpstreamNeedsConfirmation(t *testing.T) {
	h := configured(t)
	report := admittedReport()
	report.EvidenceDigest = pinB
	h.env.Verifier = &fakeVerifier{report: report}

	// Without a terminal there is nobody to ask, so it refuses rather than
	// assuming yes.
	got := h.run("endpoint", "trust", "add", "llama-33-70b", "--from-upstream")
	if got.code != cli.ExitUsage {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitUsage)
	}
	if !strings.Contains(got.stderr, "--yes") {
		t.Errorf("stderr = %q, want it to name the flag that would work", got.stderr)
	}

	// With a terminal, the answer decides.
	h.env.IsTerminal = func() bool { return true }
	h.stdin.WriteString("n\n")
	if got := h.run("endpoint", "trust", "add", "llama-33-70b", "--from-upstream"); got.code == cli.ExitOK {
		t.Error("answering no still pinned the digest")
	}
	if strings.Contains(h.config(), pinBShown) {
		t.Error("answering no still wrote to the config")
	}

	h.stdin.Reset()
	h.stdin.WriteString("y\n")
	h.mustRun("endpoint", "trust", "add", "llama-33-70b", "--from-upstream")
	if !strings.Contains(h.config(), pinBShown) {
		t.Error("answering yes did not pin the digest")
	}
}

func TestVerifyRefusesToIgnoreTheEndpointFlag(t *testing.T) {
	h := configured(t)
	h.mustRun("endpoint", "add", "staging",
		"--listen", "127.0.0.1:8444", "--upstream", "https://staging.tee.swarm.cloud", "--trust", pinB)
	h.env.Verifier = &fakeVerifier{report: admittedReport()}

	// The positional argument is a configured endpoint, so --endpoint could
	// only be ignored — and ignoring it would answer the opposite question.
	got := h.run("verify", "llama-33-70b", "--endpoint", "staging")
	if got.code != cli.ExitUsage {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitUsage)
	}
	if !strings.Contains(got.stderr, "pass the hostname instead") {
		t.Errorf("stderr = %q, want it to say what would work", got.stderr)
	}

	// Spelled with a hostname it is exactly the right thing to ask for.
	verifier := &fakeVerifier{report: admittedReport()}
	h.env.Verifier = verifier
	h.mustRun("verify", "staging.tee.swarm.cloud", "--endpoint", "llama-33-70b")
	want := status.VerifyRequest{Hostname: "staging.tee.swarm.cloud", Endpoint: "llama-33-70b"}
	if len(verifier.requests) != 1 || verifier.requests[0] != want {
		t.Errorf("request = %+v, want %+v", verifier.requests, want)
	}
}
