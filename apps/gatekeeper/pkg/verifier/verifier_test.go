package verifier_test

import (
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/verifier"
)

const pinnedDigest = "sha256/SwSl8nkqLsNHn9rsW7Dfek9mGTeDePm8MsHPQ3Z-490"

// configWith builds a config trusting the test root, with one endpoint pinned
// to the given digests.
func configWith(t *testing.T, ca *testCA, pins []string, policies string) *config.Config {
	t.Helper()
	var b strings.Builder
	b.WriteString("version: 1\ntrustedRoots:\n  - name: swarm-cloud-test\n    pem: |\n")
	for _, line := range strings.Split(strings.TrimRight(ca.rootPEM, "\n"), "\n") {
		b.WriteString("      " + line + "\n")
	}
	b.WriteString(policies)
	b.WriteString("endpoints:\n  - name: llama-33-70b\n    listen: 127.0.0.1:8443\n" +
		"    upstream: https://llama-33-70b.tee.swarm.cloud\n    trustedEvidence:\n")
	for _, pin := range pins {
		b.WriteString("      - " + pin + "\n")
	}
	if len(pins) == 0 {
		b.WriteString("      []\n")
	}

	cfg, err := config.Parse(strings.NewReader(b.String()), t.TempDir()+"/config.yaml")
	if err != nil {
		t.Fatalf("parsing the config: %v", err)
	}
	if err := cfg.ValidateEditable(); err != nil {
		t.Fatalf("the test config is malformed: %v", err)
	}
	return cfg
}

func newVerifier(t *testing.T, cfg *config.Config, fetch attestation.Fetcher) *verifier.Verifier {
	t.Helper()
	v, err := verifier.New(t.Context(), cfg)
	if err != nil {
		t.Fatalf("building the verifier: %v", err)
	}
	return v.WithFetcher(fetch)
}

func TestVerifyAdmitsAPinnedDeployment(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(document, ca.leafFingerprint()))

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !report.Verified || !report.Admitted {
		t.Fatalf("verified=%v admitted=%v (%s): want both", report.Verified, report.Admitted, report.Denied())
	}

	// The report is the whole answer, not just the verdict.
	if report.Root != "swarm-cloud-test" {
		t.Errorf("root = %q, want the trusted root's name", report.Root)
	}
	if report.EvidenceDigest != pinnedDigest || !report.Pinned {
		t.Errorf("digest = %q pinned = %v, want the pinned digest recognised", report.EvidenceDigest, report.Pinned)
	}
	if report.ObservedTLSFingerprint != ca.leafFingerprint() {
		t.Errorf("observed leaf = %q, want the one the fetch presented", report.ObservedTLSFingerprint)
	}
	if len(report.Chain) != 2 || !report.Chain[1].Root {
		t.Errorf("chain = %+v, want leaf then root", report.Chain)
	}
	if report.Chain[0].Subject != "CN=llama-33-70b.tee.swarm.cloud" {
		t.Errorf("leaf subject = %q", report.Chain[0].Subject)
	}
	if report.QuoteFormat != "intel-tdx-quote-v5" {
		t.Errorf("quote format = %q, want the bundle's", report.QuoteFormat)
	}
	if len(report.Images) != 1 || report.Images[0] != "ghcr.io/super-protocol/vllm@sha256:aaaa" {
		t.Errorf("images = %v, want the snapshot's", report.Images)
	}
	if len(report.Policies) != 1 || !report.Policies[0].Allow {
		t.Errorf("policies = %+v, want the built-in policy allowing", report.Policies)
	}
	if report.UntrustedRoot != "" {
		t.Errorf("untrusted root = %q, want none — the chain matched", report.UntrustedRoot)
	}
}

func TestVerifyDeniesAnUnpinnedDeployment(t *testing.T) {
	ca := newTestCA(t)
	published := trust.Sum([]byte("some other deployment")).String()
	document := ca.bundle(t, bundleOptions{EvidenceDigest: published})
	v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(document, ca.leafFingerprint()))

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatal(err)
	}
	// Verified and admitted are different questions: the cryptography held, the
	// deployment is simply not one this endpoint accepts.
	if !report.Verified || report.Admitted {
		t.Fatalf("verified=%v admitted=%v, want verified but denied", report.Verified, report.Admitted)
	}
	if report.Pinned {
		t.Error("an unpinned digest was reported as pinned")
	}
	if report.EvidenceDigest != published {
		t.Errorf("digest = %q, want what the endpoint published — that is what gets pinned", report.EvidenceDigest)
	}
	if report.Stage != "policy" {
		t.Errorf("stage = %q, want the denial attributed to the policy layer", report.Stage)
	}
}

func TestVerifyReportsTheFailingStage(t *testing.T) {
	ca := newTestCA(t)
	other := newForeignCA(t)

	cases := []struct {
		name      string
		document  []byte
		observed  string
		wantStage string
		wantChain bool
	}{
		{
			name:      "a chain that ends somewhere untrusted",
			document:  ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest, Chain: []string{other.leafPEM, other.rootPEM}}),
			observed:  ca.leafFingerprint(),
			wantStage: "untrusted-root",
			wantChain: true,
		},
		{
			name:      "a broken signature",
			document:  ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest, BreakSignature: true}),
			observed:  ca.leafFingerprint(),
			wantStage: "jws",
			wantChain: true,
		},
		{
			name:      "a stale bundle",
			document:  ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest, IssuedAt: time.Now().Add(-72 * time.Hour)}),
			observed:  ca.leafFingerprint(),
			wantStage: "jws",
			wantChain: true,
		},
		{
			name:      "a certificate nobody served",
			document:  ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest}),
			observed:  trust.Sum([]byte("a different leaf")).String(),
			wantStage: "tls-fingerprint",
			wantChain: true,
		},
		{
			name:      "a bundle for another host",
			document:  ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest, Hostname: "elsewhere.example"}),
			observed:  ca.leafFingerprint(),
			wantStage: "fetch",
			wantChain: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(c.document, c.observed))
			report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
			if err != nil {
				t.Fatal(err)
			}
			if report.Verified || report.Admitted {
				t.Fatalf("verified=%v admitted=%v, want a denial", report.Verified, report.Admitted)
			}
			if report.Stage != c.wantStage {
				t.Errorf("stage = %q, want %q (reason: %s)", report.Stage, c.wantStage, report.Reason)
			}
			if len(report.Policies) != 0 {
				t.Error("policies were evaluated on unverified evidence")
			}
			// The chain is shown even when the bundle was rejected: that is
			// exactly the one an operator needs to look at.
			if c.wantChain && len(report.Chain) == 0 {
				t.Error("the report carries no chain to look at")
			}
		})
	}
}

func TestVerifyOffersTheUntrustedRootToAdd(t *testing.T) {
	ca := newTestCA(t)
	other := newForeignCA(t)
	document := ca.bundle(t, bundleOptions{
		EvidenceDigest: pinnedDigest,
		Chain:          []string{other.leafPEM, other.rootPEM},
	})
	v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(document, ca.leafFingerprint()))

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatal(err)
	}
	// This is what the dashboard's "add this root" key needs; without the PEM
	// the offer cannot be honoured.
	if report.UntrustedRoot == "" || report.UntrustedRootPEM == "" {
		t.Fatalf("untrusted root = %q, pem length %d; want both", report.UntrustedRoot, len(report.UntrustedRootPEM))
	}
	if !strings.Contains(report.UntrustedRootPEM, "BEGIN CERTIFICATE") {
		t.Error("the offered root is not a PEM certificate")
	}
	if _, err := trust.ParseDigest(report.UntrustedRoot); err != nil {
		t.Errorf("the offered fingerprint is not a digest: %v", err)
	}
}

func TestVerifyAnUnconfiguredHostCanNeverBeAdmitted(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{
		Hostname: "unknown.tee.swarm.cloud", EvidenceDigest: pinnedDigest,
	})
	v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(document, ca.leafFingerprint()))

	report, err := v.Verify(t.Context(), status.VerifyRequest{Hostname: "unknown.tee.swarm.cloud"})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Verified {
		t.Fatalf("verification failed at %s: %s", report.Stage, report.Reason)
	}
	// It has no pins, so the built-in policy has nothing to match against.
	if report.Admitted {
		t.Error("a host with no configured pins was admitted")
	}
	if len(report.Warnings) == 0 || !strings.Contains(report.Warnings[0], "not a configured endpoint") {
		t.Errorf("warnings = %v, want the reason spelled out", report.Warnings)
	}
}

func TestVerifyRunsUserPolicies(t *testing.T) {
	ca := newTestCA(t)
	dir := t.TempDir()
	policyPath := dir + "/images.rego"
	writeFile(t, policyPath, `package images

import rego.v1

default allow := false

allow if {
	every image in input.evidence.containerImages {
		startswith(image, "registry.internal/")
	}
}
`)
	cfg := configWith(t, ca, []string{pinnedDigest}, "policies:\n  - name: images\n    file: "+policyPath+"\n")
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	v := newVerifier(t, cfg, ca.fetcher(document, ca.leafFingerprint()))

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatal(err)
	}
	// A user policy narrows trust: the pin matches, the images do not.
	if report.Admitted {
		t.Error("a user policy's denial did not reach the verdict")
	}
	if len(report.Policies) != 2 {
		t.Fatalf("policies = %+v, want both packages reported", report.Policies)
	}
	if !report.Policies[0].Allow || report.Policies[1].Allow {
		t.Errorf("policies = %+v, want the built-in allowing and the user policy denying", report.Policies)
	}
	if !strings.Contains(report.Denied(), "images") {
		t.Errorf("Denied() = %q, want it to name the policy that said no", report.Denied())
	}
}

func TestNewRejectsAnUncompilablePolicy(t *testing.T) {
	ca := newTestCA(t)
	dir := t.TempDir()
	path := dir + "/broken.rego"
	writeFile(t, path, "package broken\n\nthis is not rego\n")

	// Compile problems are fatal here rather than on the first request.
	_, err := verifier.New(t.Context(), configWith(t, ca, []string{pinnedDigest},
		"policies:\n  - name: broken\n    file: "+path+"\n"))
	if err == nil {
		t.Fatal("an uncompilable policy was accepted")
	}
}

func TestVerifyJudgesAnotherHostByAnEndpointsPins(t *testing.T) {
	ca := newTestCA(t)
	// A staging host publishing what production is about to run: fetched from
	// there, judged by the production endpoint's pins.
	document := ca.bundle(t, bundleOptions{
		Hostname: "staging.tee.swarm.cloud", EvidenceDigest: pinnedDigest,
	})
	v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(document, ca.leafFingerprint()))

	report, err := v.Verify(t.Context(), status.VerifyRequest{
		Hostname: "staging.tee.swarm.cloud", Endpoint: "llama-33-70b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Hostname != "staging.tee.swarm.cloud" {
		t.Fatalf("hostname = %q, want the host that was asked for", report.Hostname)
	}
	if !report.Verified || !report.Pinned || !report.Admitted {
		t.Errorf("verified=%v pinned=%v admitted=%v (%s); want the endpoint's pins to have applied",
			report.Verified, report.Pinned, report.Admitted, report.Denied())
	}
}

func TestVerifyOnlyOffersARootFromAValidatedChain(t *testing.T) {
	ca := newTestCA(t)
	other := newForeignCA(t)

	// A chain whose links do not verify: the "root" at the end of the array is
	// whatever the server chose to put there. Offering it as a trust anchor
	// would let one keystroke trust an attacker's CA for every endpoint, so the
	// report must not carry it however the chain is spelled.
	cases := map[string][]string{
		"a chain that does not link":     {ca.leafPEM, other.rootPEM},
		"an end-entity posing as a root": {ca.leafPEM, ca.leafPEM},
		"a single unrelated certificate": {other.leafPEM},
	}
	for name, chain := range cases {
		t.Run(name, func(t *testing.T) {
			document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest, Chain: chain})
			v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(document, ca.leafFingerprint()))

			report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
			if err != nil {
				t.Fatal(err)
			}
			if report.Verified {
				t.Fatalf("a malformed chain was accepted (stage %q)", report.Stage)
			}
			if report.Stage == "untrusted-root" {
				t.Fatalf("stage = untrusted-root; this chain should not have got that far")
			}
			if report.UntrustedRootPEM != "" || report.UntrustedRoot != "" {
				t.Errorf("the report offers a certificate from a chain that never validated: %q",
					report.UntrustedRoot)
			}
			// The chain is still shown — that is what the operator has to read.
			if len(report.Chain) == 0 {
				t.Error("the report carries no chain to look at")
			}
		})
	}
}

func TestVerifyDeniesAPayloadWithNothingToPin(t *testing.T) {
	ca := newTestCA(t)
	// A deployment bundle that publishes no evidenceDigest: sound
	// cryptographically, impossible to pin.
	document := ca.bundle(t, bundleOptions{EvidenceDigest: ""})
	v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(document, ca.leafFingerprint()))

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("a bundle with nothing to pin came back as an error rather than a denial: %v", err)
	}
	if !report.Verified || report.Admitted {
		t.Fatalf("verified=%v admitted=%v, want verified but denied", report.Verified, report.Admitted)
	}
	if report.Stage != "policy" || !strings.Contains(report.Reason, "evidenceDigest") {
		t.Errorf("stage = %q reason = %q, want the denial explained", report.Stage, report.Reason)
	}
	// The whole point: the report survives, so `verify` still prints the chain,
	// the root and the fingerprints.
	if report.Root == "" || len(report.Chain) == 0 {
		t.Error("the report was thrown away instead of being reported")
	}
}
