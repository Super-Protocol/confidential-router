package testing_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	policytesting "github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy/testing"
)

// The conformance vectors every verifier in the product is held to. Using them
// here rather than a locally minted bundle is the point: the adapter is only
// worth anything if it reaches the same verdicts as pkg/attestation's
// conformance suite and the TypeScript verifier.
const (
	sharedFixturesDir = "libs/attestation-fixtures/vectors"
	fixtureHostname   = "router.example.test"
	fixtureRootName   = "confidential-router-test-root-rsa"
	fixtureDigest     = "sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs"
	fixtureObservedFP = "sha256/d4d-LKXzAIf1DOWon1SzGssmcjKrG1k2hQ-NiU5z_z8"
	fixtureNow        = "2026-01-15T12:00:00Z"
)

// TestVerifierAdmitsAConformanceBundle is the end-to-end happy path: a bundle
// the shared vectors call valid, pinned in the config, admitted by the built-in
// pin policy.
func TestVerifierAdmitsAConformanceBundle(t *testing.T) {
	cfgPath := writeConformanceConfig(t, trustedRootPEM(t))
	verify := newFixtureVerifier(t, cfgPath, fixtureObservedFP)

	result, err := policytesting.EvaluateFile(context.Background(),
		conformanceBundle(t, "valid-rsa-deployment"), cfgPath, policytesting.Options{Verify: verify})
	if err != nil {
		t.Fatalf("EvaluateFile: %v", err)
	}
	if !result.CryptoVerified || !result.Admitted {
		t.Fatalf("CryptoVerified=%v Admitted=%v, want both true (%s)",
			result.CryptoVerified, result.Admitted, result.Decision.Reason)
	}
	if len(result.Warnings) != 0 {
		t.Errorf("warnings = %v, want none: the chain, the signature, the freshness and an observed binding all held",
			result.Warnings)
	}
	attestationInput, _ := result.Input["attestation"].(map[string]any)
	if got := attestationInput["root"]; got != fixtureRootName {
		t.Errorf("attestation.root = %v, want %q", got, fixtureRootName)
	}
	if got := attestationInput["observedTlsFingerprint"]; got != fixtureObservedFP {
		t.Errorf("attestation.observedTlsFingerprint = %v, want the leaf the verdict was bound to", got)
	}
	if got := attestationInput["quoteFormat"]; got != "intel-tdx-quote-v5" {
		t.Errorf("attestation.quoteFormat = %v, want the bundle's rootCaTeeQuote.format", got)
	}
}

// TestVerifierDeniesWhatTheCryptoPipelineRejects is the deny path the seam
// exists for. The bundle's payload is exactly the one the policies admit — the
// policy-only run proves it — and the wired verifier still refuses it, because
// the signature does not verify.
func TestVerifierDeniesWhatTheCryptoPipelineRejects(t *testing.T) {
	cfgPath := writeConformanceConfig(t, trustedRootPEM(t))
	bundlePath := conformanceBundle(t, "jws-bad-signature")

	policyOnly, err := policytesting.EvaluateFile(
		context.Background(), bundlePath, cfgPath, policytesting.Options{})
	if err != nil {
		t.Fatalf("policy-only EvaluateFile: %v", err)
	}
	if !policyOnly.Decision.Allow {
		t.Fatalf("the Rego policies deny this payload (%s); the test cannot show the verifier is what stops it",
			policyOnly.Decision.Reason)
	}
	if policyOnly.Admitted {
		t.Error("a policy-only run admitted a bundle")
	}

	_, err = policytesting.EvaluateFile(context.Background(), bundlePath, cfgPath,
		policytesting.Options{Verify: newFixtureVerifier(t, cfgPath, fixtureObservedFP)})
	if err == nil {
		t.Fatal("a bundle with a bit-flipped signature was accepted by the wired verifier")
	}
	if !strings.Contains(err.Error(), "jws") {
		t.Errorf("err = %v, want the failure to name the pipeline stage", err)
	}
}

// TestVerifierDeniesAnUntrustedRoot covers the other half of the gate: the
// bundle is intact, but its chain does not terminate in a root this config
// trusts.
func TestVerifierDeniesAnUntrustedRoot(t *testing.T) {
	cfgPath := writeConformanceConfig(t, selfSignedPEM(t))

	_, err := policytesting.EvaluateFile(context.Background(),
		conformanceBundle(t, "valid-rsa-deployment"), cfgPath,
		policytesting.Options{Verify: newFixtureVerifier(t, cfgPath, fixtureObservedFP)})
	if err == nil {
		t.Fatal("a chain terminating in an unknown root was accepted")
	}
	if !strings.Contains(err.Error(), "untrusted-root") {
		t.Errorf("err = %v, want the untrusted-root stage", err)
	}
}

// TestVerifierWarnsAboutAProducerAssertedBinding: with no handshake to observe,
// the pipeline falls back to hashing the bundle's own tlsLeaf. That is a valid
// verdict, but a weaker one, and `policy test` has to say so rather than let the
// input document's `channelBinding: observed` stand unqualified.
func TestVerifierWarnsAboutAProducerAssertedBinding(t *testing.T) {
	cfgPath := writeConformanceConfig(t, trustedRootPEM(t))

	result, err := policytesting.EvaluateFile(context.Background(),
		conformanceBundle(t, "valid-producer-asserted"), cfgPath,
		policytesting.Options{Verify: newFixtureVerifier(t, cfgPath, "")})
	if err != nil {
		t.Fatalf("EvaluateFile: %v", err)
	}
	if !result.Admitted {
		t.Fatalf("Admitted = false, want true (%s)", result.Decision.Reason)
	}
	if !strings.Contains(strings.Join(result.Warnings, "\n"), "producer-asserted") {
		t.Errorf("warnings = %v, want one naming the weaker channel binding", result.Warnings)
	}
}

// TestVerifierWarnsWhenFreshnessIsNotEnforced: MaxBundleAge of 0 disables the
// freshness check, which is the right default for a bundle saved days ago but
// also means a replayed bundle of any age passes. `policy test` has to say so —
// silently skipping a stage is exactly what Result.Warnings exists to prevent.
func TestVerifierWarnsWhenFreshnessIsNotEnforced(t *testing.T) {
	cfgPath := writeConformanceConfig(t, trustedRootPEM(t))
	bundlePath := conformanceBundle(t, "valid-rsa-deployment")

	result, err := policytesting.EvaluateFile(context.Background(), bundlePath, cfgPath,
		policytesting.Options{Verify: newFixtureVerifierWithMaxAge(t, cfgPath, fixtureObservedFP, 0)})
	if err != nil {
		t.Fatalf("EvaluateFile: %v", err)
	}
	if !result.Admitted {
		t.Fatalf("Admitted = false, want true: a zero maxBundleAge disables the check, it does not deny (%s)",
			result.Decision.Reason)
	}
	if !strings.Contains(strings.Join(result.Warnings, "\n"), "maxBundleAge") {
		t.Errorf("warnings = %v, want one naming the unenforced freshness check", result.Warnings)
	}

	// The same bundle with the check switched on and the vectors' reference
	// clock stays admitted and unqualified, so the warning tracks the setting
	// and not the bundle.
	enforced, err := policytesting.EvaluateFile(context.Background(), bundlePath, cfgPath,
		policytesting.Options{Verify: newFixtureVerifier(t, cfgPath, fixtureObservedFP)})
	if err != nil {
		t.Fatalf("EvaluateFile with freshness enforced: %v", err)
	}
	if len(enforced.Warnings) != 0 {
		t.Errorf("warnings = %v, want none once maxBundleAge is set", enforced.Warnings)
	}
}

// TestNewVerifierRejectsAnUnreadableRoot fails at construction rather than once
// per bundle, so a broken trust store is one clear error and not a stream of
// denials.
func TestNewVerifierRejectsAnUnreadableRoot(t *testing.T) {
	dir := t.TempDir()
	body := "version: 1\n" +
		"trustedRoots:\n  - name: missing\n    pemFile: ./nowhere.pem\n" +
		"endpoints:\n" +
		"  - name: router\n    listen: 127.0.0.1:8443\n    upstream: https://" + fixtureHostname + "\n" +
		"    trustedEvidence:\n      - " + fixtureDigest + "\n"
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(config.Options{Path: path})
	if err != nil {
		t.Skipf("the config layer already rejects an unreadable pemFile: %v", err)
	}
	if _, err := policytesting.NewVerifier(cfg, policytesting.VerifierOptions{}); err == nil {
		t.Fatal("NewVerifier accepted a trusted root it cannot read")
	}
}

func TestNewVerifierRequiresAConfig(t *testing.T) {
	if _, err := policytesting.NewVerifier(nil, policytesting.VerifierOptions{}); err == nil {
		t.Fatal("NewVerifier(nil) returned a verifier")
	}
}

// newFixtureVerifier builds the adapter with the vectors' reference clock and
// max age, so the verdicts here are the ones the manifest publishes.
func newFixtureVerifier(t *testing.T, configPath, observed string) policytesting.VerifyFunc {
	t.Helper()
	return newFixtureVerifierWithMaxAge(t, configPath, observed, 24*time.Hour)
}

func newFixtureVerifierWithMaxAge(
	t *testing.T, configPath, observed string, maxAge time.Duration,
) policytesting.VerifyFunc {
	t.Helper()
	cfg, err := config.Load(config.Options{Path: configPath})
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	now, err := time.Parse(time.RFC3339, fixtureNow)
	if err != nil {
		t.Fatal(err)
	}
	verify, err := policytesting.NewVerifier(cfg, policytesting.VerifierOptions{
		ObservedTLSFingerprint: observed,
		MaxBundleAge:           maxAge,
		Now:                    now,
	})
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return verify
}

// writeConformanceConfig pins the vectors' evidenceDigest on an endpoint whose
// upstream is the hostname the fixture bundles are published for.
func writeConformanceConfig(t *testing.T, rootPEM string) string {
	t.Helper()
	dir := t.TempDir()
	body := "version: 1\n" +
		"trustedRoots:\n  - name: " + fixtureRootName + "\n    pem: |\n" +
		indent(rootPEM, "      ") +
		"endpoints:\n" +
		"  - name: router\n" +
		"    listen: 127.0.0.1:8443\n" +
		"    upstream: https://" + fixtureHostname + "\n" +
		"    trustedEvidence:\n" +
		"      - " + fixtureDigest + "\n"
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func conformanceBundle(t *testing.T, id string) string {
	t.Helper()
	path := filepath.Join(sharedFixtures(t), "bundles", id+".json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("conformance bundle %s: %v", id, err)
	}
	return path
}

func trustedRootPEM(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(sharedFixtures(t), "roots.json"))
	if err != nil {
		t.Fatalf("read roots.json: %v", err)
	}
	var doc struct {
		Roots []struct {
			Name string `json:"name"`
			PEM  string `json:"pem"`
		} `json:"roots"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse roots.json: %v", err)
	}
	for _, root := range doc.Roots {
		if root.Name == fixtureRootName {
			return root.PEM
		}
	}
	t.Fatalf("roots.json has no root named %q", fixtureRootName)
	return ""
}

// sharedFixtures walks up to the repository root, so the suite works from a
// worktree, a plain checkout or CI alike.
func sharedFixtures(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		candidate := filepath.Join(dir, filepath.FromSlash(sharedFixturesDir))
		if info, err := os.Stat(filepath.Join(candidate, "manifest.json")); err == nil && !info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not find %s above %s", sharedFixturesDir, dir)
		}
		dir = parent
	}
}
