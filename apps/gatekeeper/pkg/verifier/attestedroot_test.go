package verifier_test

import (
	"context"
	"crypto/x509"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/verifier"
)

const attestedMeasurement = "842c5f2eb016c04fa61e0ac3d0ff48bae16b4c08c61d80cdfdaf332a9b3625c2"

// stubAttestedRoots stands in for the hardware check, which needs a real report
// and a firmware download. What is exercised here is the pipeline around it:
// when it runs, what it is given, and what the verdict does with its answer.
type stubAttestedRoots struct {
	result *attestedroot.Result
	err    error
	// seen records the certificates it was asked about, so a test can prove the
	// check never ran.
	seen []*x509.Certificate
}

func (s *stubAttestedRoots) Verify(_ context.Context, cert *x509.Certificate) (*attestedroot.Result, error) {
	s.seen = append(s.seen, cert)
	return s.result, s.err
}

func attestedOK() *attestedroot.Result {
	measurement := make([]byte, 32)
	for i := range measurement {
		measurement[i] = 0x11
	}
	result := &attestedroot.Result{
		Attested:          true,
		EvidenceTypeName:  "AMD SEV-SNP (QEMU)",
		NetworkType:       attestedroot.NetworkUntrusted,
		ReportIntegrity:   true,
		CPUGeneration:     "Genoa",
		KeyBinding:        true,
		InRegistry:        true,
		MeasurementSource: attestedroot.SourceRegistry,
		SecurityFields:    attestedroot.SecurityFields{SnpFirmwareTCB: 27, ReportVersion: 5},
	}
	result.Measurement = mustMeasurement(attestedMeasurement)
	return result
}

func mustMeasurement(hexValue string) []byte {
	out := make([]byte, len(hexValue)/2)
	for i := range out {
		var b byte
		for j := 0; j < 2; j++ {
			c := hexValue[i*2+j]
			switch {
			case c >= '0' && c <= '9':
				b = b<<4 | (c - '0')
			case c >= 'a' && c <= 'f':
				b = b<<4 | (c - 'a' + 10)
			}
		}
		out[i] = b
	}
	return out
}

// rootlessConfig is what a user who never ran `trust roots add` has: one
// endpoint with its pin, and nothing in the manual trust store.
func rootlessConfig(t *testing.T, extra string) *config.Config {
	t.Helper()
	return rootlessConfigIn(t, t.TempDir(), extra)
}

// rootlessConfigIn is [rootlessConfig] anchored at a directory, for the cases
// that also write a policy file next to the config.
func rootlessConfigIn(t *testing.T, dir, extra string) *config.Config {
	t.Helper()
	document := "version: 1\ntrustedRoots: []\n" + extra +
		"endpoints:\n  - name: llama-33-70b\n    listen: 127.0.0.1:8443\n" +
		"    upstream: https://llama-33-70b.tee.swarm.cloud\n    trustedEvidence:\n      - " + pinnedDigest + "\n"
	cfg, err := config.Parse(strings.NewReader(document), dir+"/config.yaml")
	if err != nil {
		t.Fatalf("parsing the config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("a config with no manual roots should be runnable: %v", err)
	}
	return cfg
}

// TestAttestedRootAdmitsAnUnlistedCloud is the whole point of the feature: a
// deployment whose certificate authority nobody pinned is admitted, because the
// authority proved what it is.
func TestAttestedRootAdmitsAnUnlistedCloud(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	attested := &stubAttestedRoots{result: attestedOK()}

	v := newVerifier(t, rootlessConfig(t, ""), ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(attested)

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !report.Verified || !report.Admitted {
		t.Fatalf("verified=%v admitted=%v (%s): want both", report.Verified, report.Admitted, report.Denied())
	}
	if !report.RootAttested {
		t.Error("rootAttested = false, want the verdict to say the root came from the second anchor")
	}
	if want := "attested:" + attestedMeasurement; report.Root != want {
		t.Errorf("root = %q, want %q", report.Root, want)
	}
	if report.AttestedRoot == nil || !report.AttestedRoot.Attested {
		t.Fatalf("attestedRoot = %+v, want the evidence behind the decision", report.AttestedRoot)
	}
	if got, want := report.AttestedRoot.Measurement, attestedMeasurement; got != want {
		t.Errorf("measurement = %q, want %q", got, want)
	}
	// The affordance to add the root by hand is for roots that are *not*
	// trusted; offering it here would invite pinning what is already accepted.
	if report.UntrustedRoot != "" {
		t.Errorf("untrustedRoot = %q, want it cleared once the root was accepted", report.UntrustedRoot)
	}
	if len(attested.seen) != 1 {
		t.Fatalf("the attested-root check ran %d times, want once", len(attested.seen))
	}
	if got := attested.seen[0].Subject.CommonName; got != "swarm-cloud-test-root" {
		t.Errorf("the check was asked about %q, want the chain's terminal root", got)
	}
}

// TestManualRootsTakePrecedence keeps the anchors ordered: a listed root is
// used as such, and the hardware check never runs.
func TestManualRootsTakePrecedence(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	attested := &stubAttestedRoots{result: attestedOK()}

	v := newVerifier(t, configWith(t, ca, []string{pinnedDigest}, ""), ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(attested)

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !report.Admitted {
		t.Fatalf("not admitted: %s", report.Denied())
	}
	if report.Root != "swarm-cloud-test" || report.RootAttested {
		t.Errorf("root = %q attested = %v, want the manually listed root", report.Root, report.RootAttested)
	}
	if len(attested.seen) != 0 {
		t.Error("the attested-root check ran for a root the user had already listed")
	}
}

// TestAttestedRootFailureFallsThrough covers the failure modes that must all
// land on today's untrusted-root denial, with the reason carried through.
func TestAttestedRootFailureFallsThrough(t *testing.T) {
	notInRegistry := attestedOK()
	notInRegistry.Attested, notInRegistry.InRegistry = false, false
	notInRegistry.Reason = "measurement " + attestedMeasurement + " is not in the Super Protocol trusted registry"

	unreachable := attestedOK()
	unreachable.Attested = false
	unreachable.Reason = "the trusted registry could not be consulted: dial tcp: no route to host"

	for _, tc := range []struct {
		name     string
		attested *stubAttestedRoots
		want     string
	}{
		{
			name:     "the measurement is not one of Super Protocol's",
			attested: &stubAttestedRoots{result: notInRegistry},
			want:     "not in the Super Protocol trusted registry",
		},
		{
			name:     "the registry cannot be reached",
			attested: &stubAttestedRoots{result: unreachable},
			want:     "could not be consulted",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ca := newTestCA(t)
			document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
			v := newVerifier(t, rootlessConfig(t, ""), ca.fetcher(document, ca.leafFingerprint())).
				WithAttestedRoots(tc.attested)

			report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if report.Verified || report.Admitted {
				t.Fatal("a root that is not attested was accepted")
			}
			if report.Stage != "untrusted-root" {
				t.Errorf("stage = %q, want untrusted-root", report.Stage)
			}
			if !strings.Contains(report.Reason, tc.want) {
				t.Errorf("reason = %q, want it to carry %q", report.Reason, tc.want)
			}
			// The evidence is still on the report, so the operator can see how
			// far the check got.
			if report.AttestedRoot == nil || !report.AttestedRoot.ReportIntegrity {
				t.Errorf("attestedRoot = %+v, want the evidence behind the denial", report.AttestedRoot)
			}
			// A root that is not trusted is still one the user may choose to
			// add by hand.
			if report.UntrustedRoot == "" {
				t.Error("untrustedRoot is empty, so the dashboard cannot offer to add it")
			}
		})
	}
}

// TestAttestedRootNetworkTypePolicy covers the opt-in rule for the platform's
// trusted/untrusted network split. The default must not reject today's Swarm
// root, and the strict setting must.
func TestAttestedRootNetworkTypePolicy(t *testing.T) {
	for _, tc := range []struct {
		name    string
		extra   string
		admit   bool
		network attestedroot.NetworkType
	}{
		{name: "any accepts an untrusted-network root", extra: "", admit: true, network: attestedroot.NetworkUntrusted},
		{
			name:    "trusted rejects it",
			extra:   "attestedRoots:\n  requireNetworkType: trusted\n",
			admit:   false,
			network: attestedroot.NetworkUntrusted,
		},
		{
			name:    "trusted accepts a trusted-network root",
			extra:   "attestedRoots:\n  requireNetworkType: trusted\n",
			admit:   true,
			network: attestedroot.NetworkTrusted,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ca := newTestCA(t)
			document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
			result := attestedOK()
			result.NetworkType = tc.network

			v := newVerifier(t, rootlessConfig(t, tc.extra), ca.fetcher(document, ca.leafFingerprint())).
				WithAttestedRoots(&stubAttestedRoots{result: result})

			report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if report.Admitted != tc.admit {
				t.Fatalf("admitted = %v, want %v (%s)", report.Admitted, tc.admit, report.Denied())
			}
			if !tc.admit && !strings.Contains(report.Reason, "requireNetworkType") {
				t.Errorf("reason = %q, want it to name the setting that rejected the root", report.Reason)
			}
		})
	}
}

// TestAttestedRootsOffKeepsTodaysBehaviour is the escape hatch: turning the
// anchor off leaves exactly the manual store.
func TestAttestedRootsOffKeepsTodaysBehaviour(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})

	cfg := rootlessConfig(t, "")
	v, err := verifier.New(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	report, err := v.WithFetcher(ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(nil).
		Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if report.Verified {
		t.Fatal("a root nothing vouches for was accepted")
	}
	if report.Stage != "untrusted-root" || report.AttestedRoot != nil {
		t.Errorf("stage = %q attestedRoot = %+v, want a plain untrusted-root denial",
			report.Stage, report.AttestedRoot)
	}
}

// TestPolicyInputCarriesTheAttestedRoot is what lets an operator write "only
// clouds whose TEE has ciphertext hiding on" — the flags have to reach Rego.
func TestPolicyInputCarriesTheAttestedRoot(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})

	policy := `policies:
  - name: require-no-debug
    file: ./no-debug.rego
`
	dir := t.TempDir()
	writeFile(t, dir+"/no-debug.rego", `package gatekeeper.nodebug

default allow := false

allow if {
	input.attestation.rootAttestation.attested == true
	input.attestation.rootAttestation.inRegistry == true
	input.attestation.rootAttestation.teeFlags.debugAllowed == false
	input.attestation.rootAttestation.evidenceType == "AMD SEV-SNP (QEMU)"
}
`)

	cfg := rootlessConfigIn(t, dir, policy)
	v := newVerifier(t, cfg, ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(&stubAttestedRoots{result: attestedOK()})

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !report.Admitted {
		t.Fatalf("a policy over the attested root denied a root that satisfies it: %s", report.Denied())
	}
}

// attestedByOperatorPin is what the check returns for the case SUP-139 exists
// for: the hardware held up, the registry has no signature for this image, and
// the operator pinned the measurement themselves.
func attestedByOperatorPin() *attestedroot.Result {
	result := attestedOK()
	result.InRegistry = false
	result.MeasurementSource = attestedroot.SourceOperatorPinned
	return result
}

// TestReportNamesTheAnchorThatAdmittedTheRoot is the reporting half of SUP-139:
// "attested" is no longer one claim, so every surface has to say which of the
// two it means.
func TestReportNamesTheAnchorThatAdmittedTheRoot(t *testing.T) {
	for _, tc := range []struct {
		name       string
		result     *attestedroot.Result
		wantSource string
		wantLabel  string
	}{
		{
			name:       "signed by Super Protocol",
			result:     attestedOK(),
			wantSource: "registry",
			wantLabel:  "attested (registry)",
		},
		{
			name:       "pinned by this operator",
			result:     attestedByOperatorPin(),
			wantSource: "operator-pinned",
			wantLabel:  "attested (operator-pinned)",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ca := newTestCA(t)
			document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
			v := newVerifier(t, rootlessConfig(t, ""), ca.fetcher(document, ca.leafFingerprint())).
				WithAttestedRoots(&stubAttestedRoots{result: tc.result})

			report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if !report.Admitted {
				t.Fatalf("not admitted: %s", report.Denied())
			}
			if got := report.AttestedRoot.MeasurementSource; got != tc.wantSource {
				t.Errorf("measurementSource = %q, want %q", got, tc.wantSource)
			}
			if got := report.AttestedRoot.SourceLabel(); got != tc.wantLabel {
				t.Errorf("SourceLabel() = %q, want %q", got, tc.wantLabel)
			}
			if got, want := report.AttestedRoot.InRegistry, tc.wantSource == "registry"; got != want {
				t.Errorf("inRegistry = %v, want %v", got, want)
			}
		})
	}
}

// TestAPolicyCanRefuseAnOperatorPinnedRoot is the reason the distinction is in
// the Rego input at all: a stricter deployment writes one rule and gets back
// exactly the old guarantee, while a stand that needs the escape hatch keeps it.
func TestAPolicyCanRefuseAnOperatorPinnedRoot(t *testing.T) {
	const module = `package gatekeeper.registryonly

default allow := false

allow if input.attestation.rootAttestation.measurementSource == "registry"
`
	for _, tc := range []struct {
		name   string
		result *attestedroot.Result
		admit  bool
	}{
		{name: "a registry-signed root passes", result: attestedOK(), admit: true},
		{name: "an operator-pinned root does not", result: attestedByOperatorPin(), admit: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ca := newTestCA(t)
			document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
			dir := t.TempDir()
			writeFile(t, dir+"/registry-only.rego", module)

			cfg := rootlessConfigIn(t, dir, "policies:\n  - name: registry-only\n    file: ./registry-only.rego\n")
			v := newVerifier(t, cfg, ca.fetcher(document, ca.leafFingerprint())).
				WithAttestedRoots(&stubAttestedRoots{result: tc.result})

			report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if report.Admitted != tc.admit {
				t.Fatalf("admitted = %v, want %v (%s)", report.Admitted, tc.admit, report.Denied())
			}
			// Either way the root itself was accepted by the pipeline: the
			// policy is narrowing a verified verdict, not standing in for it.
			if !report.Verified {
				t.Errorf("verified = false, want the attested root to have passed the pipeline")
			}
		})
	}
}

// TestRequireNetworkTypeStillRefusesAPinnedRoot is the guarantee that pinning
// replaces exactly one leg: `requireNetworkType: trusted` refuses today's
// `untrusted` Swarm root whether the measurement is signed or pinned.
func TestRequireNetworkTypeStillRefusesAPinnedRoot(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	result := attestedByOperatorPin()
	result.NetworkType = attestedroot.NetworkUntrusted

	cfg := rootlessConfig(t, "attestedRoots:\n  requireNetworkType: trusted\n")
	v := newVerifier(t, cfg, ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(&stubAttestedRoots{result: result})

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if report.Verified || report.Admitted {
		t.Fatalf("a pin overrode requireNetworkType: %+v", report.AttestedRoot)
	}
	if !strings.Contains(report.Reason, "requireNetworkType") {
		t.Errorf("reason = %q, want it to name the setting that refused the root", report.Reason)
	}
}

// TestTheRegistryDenialNamesTheFix is the message Denis has now hit three times.
// A denial that only says "not in the registry" leaves the operator to discover
// the escape hatch; this one hands them both commands.
func TestTheRegistryDenialNamesTheFix(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})

	unvouched := attestedOK()
	unvouched.Attested, unvouched.InRegistry = false, false
	unvouched.MeasurementSource = ""
	unvouched.Reason = "measurement " + attestedMeasurement +
		" is not in the Super Protocol trusted registry, and it is not listed in attestedRoots.trustedMeasurements"

	v := newVerifier(t, rootlessConfig(t, ""), ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(&stubAttestedRoots{result: unvouched})

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if report.Verified {
		t.Fatal("a root nothing vouches for was accepted")
	}
	for _, want := range []string{
		"gatekeeper trust measurements add --from-upstream llama-33-70b",
		"gatekeeper trust roots add",
	} {
		if !strings.Contains(report.Reason, want) {
			t.Errorf("reason does not offer %q:\n%s", want, report.Reason)
		}
	}
}

// TestADenialNoPinCanClearDoesNotOfferOne keeps the advice honest: a report that
// failed its key binding never derived a measurement, so telling the operator to
// pin one would send them after a fix that cannot work.
func TestADenialNoPinCanClearDoesNotOfferOne(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})

	unbound := attestedOK()
	unbound.Attested, unbound.KeyBinding = false, false
	unbound.MeasurementSource = ""
	unbound.Measurement = nil
	unbound.Reason = "the report's reportData does not commit to this certificate's public key"

	v := newVerifier(t, rootlessConfig(t, ""), ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(&stubAttestedRoots{result: unbound})

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if strings.Contains(report.Reason, "trust measurements add") {
		t.Errorf("reason offers a pin for a denial pinning cannot clear:\n%s", report.Reason)
	}
}
