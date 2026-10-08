package verifier_test

import (
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// redeployedDigest is what the same upstream publishes after a redeploy: a
// well-formed digest that is never the pinned one.
const redeployedDigest = "sha256/1Kq0nYn0SgD3o3Jm1F5v0xq3V6Zb7pV3mF0dRk1yQ7c"

// twoFactorConfig is a `trust: measurement-and-digest` deployment with the
// listed measurements and the pinned digests given — either may be empty,
// because the mode runs before anything has been approved.
func twoFactorConfig(t *testing.T, measurements []string, digests []string) *config.Config {
	t.Helper()
	document := "version: 1\ntrustedRoots: []\nattestedRoots:\n  trustedMeasurements:"
	if len(measurements) == 0 {
		document += " []\n"
	} else {
		document += "\n"
		for _, m := range measurements {
			document += "    - " + m + "\n"
		}
	}
	document += "endpoints:\n  - name: llama-33-70b\n    listen: 127.0.0.1:8443\n" +
		"    upstream: https://llama-33-70b.tee.swarm.cloud\n    trust: measurement-and-digest\n" +
		"    trustedEvidence:"
	if len(digests) == 0 {
		document += " []\n"
	} else {
		document += "\n"
		for _, d := range digests {
			document += "      - " + d + "\n"
		}
	}
	cfg, err := config.Parse(strings.NewReader(document), t.TempDir()+"/config.yaml")
	if err != nil {
		t.Fatalf("parsing the config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("a measurement-and-digest config should run with whatever factors it has: %v", err)
	}
	return cfg
}

func verifyTwoFactor(t *testing.T, cfg *config.Config, published string) *status.Report {
	t.Helper()
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: published})
	v := newVerifier(t, cfg, ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(&stubAttestedRoots{result: attestedOK()})
	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !report.Verified {
		t.Fatalf("the bundle did not verify: %s", report.Denied())
	}
	return report
}

// Both factors approved: the cloud is listed and this deployment's digest is
// pinned, so it is admitted — and the report says both factors held.
func TestTwoFactorAdmitsWhenBothFactorsAreApproved(t *testing.T) {
	report := verifyTwoFactor(t, twoFactorConfig(t, []string{attestedMeasurement}, []string{pinnedDigest}), pinnedDigest)

	if !report.Admitted {
		t.Fatalf("denied with both factors approved: %s", report.Denied())
	}
	if !report.Pinned || !report.MeasurementTrusted {
		t.Errorf("pinned=%v measurementTrusted=%v, want both true", report.Pinned, report.MeasurementTrusted)
	}
	if report.Refusal != "" {
		t.Errorf("refusal = %q on an admitted report", report.Refusal)
	}
	if !report.TrustsCloud() || report.ByMeasurement() {
		t.Errorf("trustsCloud=%v byMeasurement=%v: two-factor trusts the cloud and also pins",
			report.TrustsCloud(), report.ByMeasurement())
	}
}

// The case cloud-granularity trust used to admit (T13): a listed cloud, and a
// deployment on it nobody approved. Nothing is pinned yet, so the refusal is
// `digest-not-pinned` — and the report still carries the digest it saw, which
// is what the operator approves.
func TestTwoFactorWithNothingPinnedIsDigestNotPinned(t *testing.T) {
	report := verifyTwoFactor(t, twoFactorConfig(t, []string{attestedMeasurement}, nil), pinnedDigest)

	if report.Admitted {
		t.Fatal("a trusted cloud admitted a deployment nobody pinned")
	}
	if report.Refusal != status.RefusalDigestNotPinned {
		t.Errorf("refusal = %q, want %q", report.Refusal, status.RefusalDigestNotPinned)
	}
	if report.Stage != "policy" {
		t.Errorf("stage = %q, want policy", report.Stage)
	}
	if report.EvidenceDigest != pinnedDigest {
		t.Errorf("evidenceDigest = %q, want the digest the deployment published", report.EvidenceDigest)
	}
	if !strings.Contains(report.Reason, "no evidenceDigest is pinned") {
		t.Errorf("reason = %q, want it to say no digest is pinned", report.Reason)
	}
}

// Neither factor approved — the very first check after registration. The
// refusal is still `digest-not-pinned` (nothing has been approved; this is a
// pending decision), and the reason names the cloud too, so approving the
// digest is not followed by a surprise.
func TestTwoFactorWithNeitherFactorNamesBoth(t *testing.T) {
	report := verifyTwoFactor(t, twoFactorConfig(t, nil, nil), pinnedDigest)

	if report.Admitted {
		t.Fatal("admitted with no factor approved")
	}
	if report.Refusal != status.RefusalDigestNotPinned {
		t.Errorf("refusal = %q, want %q", report.Refusal, status.RefusalDigestNotPinned)
	}
	for _, want := range []string{"no evidenceDigest is pinned", attestedMeasurement, "not listed"} {
		if !strings.Contains(report.Reason, want) {
			t.Errorf("reason = %q\nwant it to mention %q", report.Reason, want)
		}
	}
	// The measurement the verification saw is reported either way: it is the
	// other thing the operator approves.
	if report.AttestedRoot == nil || report.AttestedRoot.Measurement != attestedMeasurement {
		t.Errorf("attestedRoot = %+v, want the measurement seen", report.AttestedRoot)
	}
}

// The deployment is pinned and its cloud is not listed: the cloud is the
// factor to fix.
func TestTwoFactorWithAnUnlistedCloudIsMeasurementNotTrusted(t *testing.T) {
	report := verifyTwoFactor(t, twoFactorConfig(t, []string{otherMeasurement}, []string{pinnedDigest}), pinnedDigest)

	if report.Admitted {
		t.Fatal("admitted on an unlisted cloud")
	}
	if report.Refusal != status.RefusalMeasurementNotTrusted {
		t.Errorf("refusal = %q, want %q", report.Refusal, status.RefusalMeasurementNotTrusted)
	}
	if !report.Pinned {
		t.Error("pinned = false for the digest that is pinned")
	}
	if !strings.Contains(report.Reason, "the list is the sole authority") {
		t.Errorf("reason = %q, want the registry misreading pre-empted as in cloud-measurement", report.Reason)
	}
}

// The beat two-factor exists for: the trusted cloud is unchanged, the upstream
// redeployed, and the new digest is not the approved one. Fail closed, and say
// it is a mismatch rather than "never pinned".
func TestTwoFactorRedeployIsDigestMismatch(t *testing.T) {
	report := verifyTwoFactor(t,
		twoFactorConfig(t, []string{attestedMeasurement}, []string{pinnedDigest}), redeployedDigest)

	if report.Admitted {
		t.Fatal("a redeployed upstream was admitted on its cloud alone")
	}
	if report.Refusal != status.RefusalDigestMismatch {
		t.Errorf("refusal = %q, want %q", report.Refusal, status.RefusalDigestMismatch)
	}
	if !report.MeasurementTrusted {
		t.Error("measurementTrusted = false: the cloud did not change")
	}
	if report.Pinned {
		t.Error("pinned = true for a digest nobody pinned")
	}
	if !strings.Contains(report.Reason, redeployedDigest) {
		t.Errorf("reason = %q, want it to name the new digest", report.Reason)
	}
}

// The other two modes never report a refusal code: their wording is what
// SUP-139 and SUP-222 settled, and a caller reading `refusal` only acts on
// two-factor endpoints.
func TestRefusalIsOnlyReportedForTwoFactorEndpoints(t *testing.T) {
	ca := newTestCA(t)
	document := ca.bundle(t, bundleOptions{EvidenceDigest: pinnedDigest})
	v := newVerifier(t, measurementConfig(t, otherMeasurement), ca.fetcher(document, ca.leafFingerprint())).
		WithAttestedRoots(&stubAttestedRoots{result: attestedOK()})

	report, err := v.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if report.Admitted {
		t.Fatal("admitted on an unlisted measurement")
	}
	if report.Refusal != "" {
		t.Errorf("refusal = %q on a cloud-measurement endpoint", report.Refusal)
	}
}
