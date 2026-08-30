package attestation_test

import (
	"crypto/x509"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/testca"
)

func TestValidateChainReportsLeafAndRoot(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	now := mustTime(t, testNow)

	chain, err := attestation.ValidateChain(
		[]string{kit.rsaLeaf.PEM, kit.rsaInter.PEM, kit.rsaRoot.PEM}, now)
	if err != nil {
		t.Fatalf("ValidateChain: %v", err)
	}
	if chain.LeafFingerprint != kit.rsaLeaf.Fingerprint() {
		t.Errorf("leaf fingerprint = %q, want %q", chain.LeafFingerprint, kit.rsaLeaf.Fingerprint())
	}
	if chain.RootFingerprint != kit.rsaRoot.Fingerprint() {
		t.Errorf("root fingerprint = %q, want %q", chain.RootFingerprint, kit.rsaRoot.Fingerprint())
	}
	if string(chain.LeafDER) != string(kit.rsaLeaf.DER) || string(chain.RootDER) != string(kit.rsaRoot.DER) {
		t.Error("ValidateChain returned DER that is not the input certificates")
	}
}

// TestValidateChainAcceptsASelfSignedSingleton covers the degenerate chain: one
// certificate that is its own root. The issuer-hygiene loop has nothing to
// check there, so only the self-signature carries the weight.
func TestValidateChainAcceptsASelfSignedSingleton(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)

	chain, err := attestation.ValidateChain([]string{kit.rsaRoot.PEM}, mustTime(t, testNow))
	if err != nil {
		t.Fatalf("ValidateChain: %v", err)
	}
	if chain.LeafFingerprint != chain.RootFingerprint {
		t.Error("in a singleton chain the leaf is the root")
	}
}

func TestValidateChainRejectsAnEmptyChain(t *testing.T) {
	t.Parallel()
	if _, err := attestation.ValidateChain(nil, time.Now()); err == nil {
		t.Fatal("an empty chain was accepted")
	}
}

func TestRootFingerprintFromPEM(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)

	fingerprint, err := attestation.RootFingerprintFromPEM(kit.rsaRoot.PEM)
	if err != nil {
		t.Fatalf("RootFingerprintFromPEM: %v", err)
	}
	if fingerprint != kit.rsaRoot.Fingerprint() {
		t.Errorf("fingerprint = %q, want %q", fingerprint, kit.rsaRoot.Fingerprint())
	}
	if _, err := attestation.RootFingerprintFromPEM("not a pem"); err == nil {
		t.Error("a non-PEM trusted root was accepted")
	}
}

// TestVerifyBundleReportsAnUnparseableTrustedRoot: a broken entry in the user's
// own trust store must be surfaced, not silently skipped — otherwise a typo in
// config quietly narrows trust to the remaining roots.
func TestVerifyBundleReportsAnUnparseableTrustedRoot(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	bundle := buildBundle(t, testHostname,
		[]*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}, kit.rsaLeaf,
		mustTime(t, "2026-08-30T10:05:00Z"), nil, nil)
	document, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	result := attestation.VerifyBundle(document, attestation.Params{
		Hostname:               testHostname,
		TrustedRoots:           []attestation.TrustedRoot{{Name: "typo", PEM: "-----BEGIN CERTIFICATE-----\nnope\n"}},
		ObservedTLSFingerprint: kit.rsaLeaf.Fingerprint(),
		Now:                    mustTime(t, testNow),
	})

	if result.OK || result.Stage != attestation.StageUntrustedRoot {
		t.Fatalf("result = %+v, want an untrusted-root denial", result)
	}
	if !strings.Contains(result.Reason, `"typo"`) {
		t.Errorf("reason %q should name the offending root", result.Reason)
	}
}

func TestVerifyBundleRequiresAHostname(t *testing.T) {
	t.Parallel()
	result := attestation.VerifyBundle([]byte(`{}`), attestation.Params{})
	if result.OK || result.Stage != attestation.StageFetch {
		t.Fatalf("result = %+v, want a fetch-stage denial", result)
	}
}

func TestResultErrorCarriesStageAndReason(t *testing.T) {
	t.Parallel()
	ok := attestation.Result{OK: true}
	if ok.Error() != nil {
		t.Error("a successful result should not produce an error")
	}

	denied := attestation.Result{Stage: attestation.StageJWS, Reason: "signature verification failed"}
	err := denied.Error()
	if err == nil || !strings.Contains(err.Error(), "jws") || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("Error() = %v, want it to carry the stage and the reason", err)
	}
}

// TestVerifyBundleAcceptsAnIntermediateAsTheTrustedRoot: trust is anchored by
// fingerprint on the chain's terminal certificate, so pinning something that is
// not terminal must not accidentally admit the chain.
func TestVerifyBundleAcceptsOnlyTheTerminalCertificateAsRoot(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	bundle := buildBundle(t, testHostname,
		[]*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}, kit.rsaLeaf,
		mustTime(t, "2026-08-30T10:05:00Z"), nil, nil)
	document, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	result := attestation.VerifyBundle(document, attestation.Params{
		Hostname:               testHostname,
		TrustedRoots:           []attestation.TrustedRoot{{Name: "intermediate-pinned", PEM: kit.rsaInter.PEM}},
		ObservedTLSFingerprint: kit.rsaLeaf.Fingerprint(),
		Now:                    mustTime(t, testNow),
	})

	if result.OK || result.Stage != attestation.StageUntrustedRoot {
		t.Fatalf("result = %+v, want the intermediate pin to be rejected", result)
	}
}

func TestValidateChainRejectsAnEndEntityActingAsIssuer(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)

	_, err := attestation.ValidateChain(
		[]string{kit.nonCAInterLeaf.PEM, kit.nonCAInter.PEM, kit.rsaRoot.PEM}, mustTime(t, testNow))
	if err == nil || !strings.Contains(err.Error(), "is not a CA") {
		t.Fatalf("err = %v, want the missing CA bit to be reported", err)
	}
	if kit.nonCAInter.Template.KeyUsage&x509.KeyUsageCertSign != 0 {
		t.Fatal("the fixture certificate is supposed to lack keyCertSign")
	}
}
