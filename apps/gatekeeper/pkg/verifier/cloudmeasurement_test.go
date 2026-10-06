package verifier_test

import (
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// otherMeasurement is a well-formed mrEnclave that is never on the list.
const otherMeasurement = "bb6962eb20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab"

// measurementConfig is a `trust: cloud-measurement` deployment: no manual
// roots, the listed measurements given, and an endpoint with no pin at all.
func measurementConfig(t *testing.T, listed ...string) *config.Config {
	t.Helper()
	document := "version: 1\ntrustedRoots: []\nattestedRoots:\n  trustedMeasurements:\n"
	for _, m := range listed {
		document += "    - " + m + "\n"
	}
	document += "endpoints:\n  - name: llama-33-70b\n    listen: 127.0.0.1:8443\n" +
		"    upstream: https://llama-33-70b.tee.swarm.cloud\n    trust: cloud-measurement\n"
	cfg, err := config.Parse(strings.NewReader(document), t.TempDir()+"/config.yaml")
	if err != nil {
		t.Fatalf("parsing the config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("a cloud-measurement config should be runnable: %v", err)
	}
	return cfg
}

// The whole pipeline, with only the hardware signature stubbed: a deployment
// nobody pinned is admitted because its cloud's root CA attested to a
// measurement the operator listed.
func TestCloudMeasurementAdmitsAnUnpinnedDeployment(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	attested := &stubAttestedRoots{result: attestedOK()}

	v := newVerifier(t, measurementConfig(t, attestedMeasurement), ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(attested)

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !report.Verified || !report.Admitted {
		t.Fatalf("verified=%v admitted=%v (%s): want both", report.Verified, report.Admitted, report.Denied())
	}
	// Nothing was pinned, and the report must not pretend otherwise: `pinned`
	// is the digest question, and this endpoint does not ask it.
	if report.Pinned {
		t.Error("pinned = true on an endpoint that pins no digest")
	}
	if !report.ByMeasurement() || report.TrustMode != config.TrustCloudMeasurement {
		t.Errorf("trustMode = %q, want %q", report.TrustMode, config.TrustCloudMeasurement)
	}
	if !report.MeasurementTrusted {
		t.Error("measurementTrusted = false for a measurement on the list")
	}
}

// Ruling 2 on SUP-221, end to end: the list is the sole authority. The stub
// reports a registry-signed measurement — the strongest anchor there is — and
// the endpoint is still denied, because the operator did not list it.
func TestCloudMeasurementDeniesARegistrySignedCloudTheOperatorDidNotList(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	attested := &stubAttestedRoots{result: attestedOK()}

	// Listed: something else entirely. The attested root's own measurement is
	// `attestedMeasurement`, registry-signed per the stub.
	v := newVerifier(t, measurementConfig(t, otherMeasurement), ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(attested)

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !report.Verified {
		t.Fatalf("the bundle did not verify: %s", report.Denied())
	}
	if report.Admitted {
		t.Fatal("a registry-signed measurement the operator never listed was admitted")
	}
	if report.MeasurementTrusted {
		t.Error("measurementTrusted = true for a measurement that is not on the list")
	}
	if report.Stage != "policy" {
		t.Errorf("stage = %q, want the denial to come from the policy layer", report.Stage)
	}
	// The denial has to end in the fix, and it has to pre-empt the obvious
	// misreading — "but Super Protocol signed it".
	for _, want := range []string{
		attestedMeasurement,
		"not listed in attestedRoots.trustedMeasurements",
		"the list is the sole authority",
	} {
		if !strings.Contains(report.Reason, want) {
			t.Errorf("reason = %q\nwant it to mention %q", report.Reason, want)
		}
	}
	// The anchor is still reported: it is useful display state, it just does
	// not admit.
	if report.AttestedRoot == nil ||
		report.AttestedRoot.MeasurementSource != string(attestedroot.SourceRegistry) {
		t.Errorf("attestedRoot = %+v, want the registry signature still reported", report.AttestedRoot)
	}
}

// Without an attested root there is no measurement to compare, so the mode
// denies — and says which half is missing rather than leaving "the built-in pin
// policy denied" on an endpoint that pins nothing.
func TestCloudMeasurementDeniesWhenNoRootWasAttested(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	denied := attestedOK()
	denied.Attested = false
	denied.ReportIntegrity = false
	denied.Reason = "the hardware report's signature does not verify"

	v := newVerifier(t, measurementConfig(t, attestedMeasurement), ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(&stubAttestedRoots{result: denied})

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if report.Admitted {
		t.Fatal("admitted without an attested root")
	}
	// The chain terminates in a root nobody listed and the attested path
	// refused it, so this is denied before the policy ever runs — and the
	// reason names the hardware failure.
	if !strings.Contains(report.Reason, denied.Reason) {
		t.Errorf("reason = %q, want it to name the attested-root failure", report.Reason)
	}
}

// The configuration that most easily looks like it should work and does not: a
// cloud-measurement endpoint whose root the operator *also* listed under
// `trustedRoots`. The manual list wins, so the attested path never runs and
// there is no measurement to compare — and the denial has to say that rather
// than leave "the built-in pin policy denied" on an endpoint with no pins.
func TestCloudMeasurementDeniesARootTakenFromTheManualList(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})

	listed := "version: 1\ntrustedRoots:\n  - name: swarm-cloud-test\n    pem: |\n"
	for _, line := range strings.Split(strings.TrimRight(ca.rootPEM, "\n"), "\n") {
		listed += "      " + line + "\n"
	}
	listed += "attestedRoots:\n  trustedMeasurements:\n    - " + attestedMeasurement + "\n" +
		"endpoints:\n  - name: llama-33-70b\n    listen: 127.0.0.1:8443\n" +
		"    upstream: https://llama-33-70b.tee.swarm.cloud\n    trust: cloud-measurement\n"
	cfg, err := config.Parse(strings.NewReader(listed), t.TempDir()+"/config.yaml")
	if err != nil {
		t.Fatalf("parsing the config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("the config should be runnable: %v", err)
	}

	attested := &stubAttestedRoots{result: attestedOK()}
	v := newVerifier(t, cfg, ca.fetcher(document, ca.leafFingerprint())).WithAttestedRoots(attested)

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !report.Verified {
		t.Fatalf("the bundle did not verify: %s", report.Denied())
	}
	if report.Admitted {
		t.Fatal("admitted without the attested-root check ever running")
	}
	if len(attested.seen) != 0 {
		t.Errorf("the attested-root check ran %d time(s) for a root the operator listed", len(attested.seen))
	}
	for _, want := range []string{
		"trusts its cloud by measurement",
		"requires the attested-root check",
	} {
		if !strings.Contains(report.Reason, want) {
			t.Errorf("reason = %q\nwant it to mention %q", report.Reason, want)
		}
	}
}
