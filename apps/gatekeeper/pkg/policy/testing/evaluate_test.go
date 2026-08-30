package testing_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	policytesting "github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy/testing"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

var (
	pinned   = trust.Sum([]byte("the pinned snapshot"))
	unpinned = trust.Sum([]byte("another snapshot"))
	certFP   = trust.Sum([]byte("the leaf DER"))
)

type fixture struct {
	dir        string
	configPath string
	rootPEM    string
}

// newFixture writes a config with one endpoint pinning `pinned`, plus the
// policy files the caller asks for.
func newFixture(t *testing.T, policies string) fixture {
	t.Helper()
	dir := t.TempDir()
	rootPEM := selfSignedPEM(t)

	body := "version: 1\ntrustedRoots:\n  - name: swarm-cloud-prod\n    pem: |\n" +
		indent(rootPEM, "      ") +
		policies +
		"endpoints:\n" +
		"  - name: llama\n" +
		"    listen: 127.0.0.1:8443\n" +
		"    upstream: https://llama.tee.swarm.cloud\n" +
		"    trustedEvidence:\n" +
		"      - " + pinned.String() + "\n"

	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return fixture{dir: dir, configPath: path, rootPEM: rootPEM}
}

// writeBundle renders a bundle whose JWS payload carries the given digest. The
// signature is a placeholder: this package never checks it, which is exactly
// what its warnings say.
func (f fixture) writeBundle(t *testing.T, digest trust.Digest, chain []string) string {
	t.Helper()
	payload := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        "llama.tee.swarm.cloud",
		"issuedAt":        time.Now().UTC().Format(time.RFC3339),
		"certFingerprint": certFP.String(),
		"evidenceDigest":  digest.String(),
		"evidence": map[string]any{
			"version": 2,
			"resources": []any{
				map[string]any{"image": "ghcr.io/super-protocol/router-api@sha256:11"},
			},
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	jws := strings.Join([]string{
		base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`)),
		base64.RawURLEncoding.EncodeToString(encoded),
		base64.RawURLEncoding.EncodeToString([]byte("signature-not-checked-offline")),
	}, ".")

	bundle := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        "llama.tee.swarm.cloud",
		"issuedAt":        payload["issuedAt"],
		"certFingerprint": certFP.String(),
		"jws":             jws,
		"certChain":       chain,
		"rootCaTeeQuote":  map[string]any{"format": "intel-tdx-quote-v5", "data": "…"},
	}
	raw, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(f.dir, "bundle.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEvaluateFileAllowsAPinnedBundle(t *testing.T) {
	f := newFixture(t, "")
	bundlePath := f.writeBundle(t, pinned, []string{f.rootPEM})

	result, err := policytesting.EvaluateFile(context.Background(), bundlePath, f.configPath, policytesting.Options{})
	if err != nil {
		t.Fatalf("EvaluateFile: %v", err)
	}

	if !result.Decision.Allow {
		t.Fatalf("Allow = false, want true (%s)", result.Decision.Reason)
	}
	// The policies allow, but nothing cryptographic was checked, so the bundle
	// is not admitted.
	if result.CryptoVerified || result.Admitted {
		t.Errorf("CryptoVerified=%v Admitted=%v, want both false in a policy-only run",
			result.CryptoVerified, result.Admitted)
	}
	if result.Endpoint != "llama" {
		t.Errorf("endpoint = %q, want llama (matched by upstream hostname)", result.Endpoint)
	}
	if got := result.Input["attestation"].(map[string]any)["root"]; got != "swarm-cloud-prod" {
		t.Errorf("attestation.root = %v, want the trusted root the chain ends in", got)
	}
	if !strings.Contains(result.TrustModule, pinned.String()) {
		t.Error("the reported trust module does not carry the pin")
	}
	// The shortcuts this offline path takes must be stated, not implied.
	joined := strings.Join(result.Warnings, "\n")
	if !strings.Contains(joined, "POLICY-ONLY RUN") || !strings.Contains(joined, "channel binding") {
		t.Errorf("warnings do not name the skipped checks: %v", result.Warnings)
	}
}

func TestEvaluateFileAdmitsOnlyWithAVerifier(t *testing.T) {
	f := newFixture(t, "")
	bundlePath := f.writeBundle(t, pinned, []string{f.rootPEM})

	called := false
	verify := func(_ context.Context, bundleJSON []byte, hostname string) (*policytesting.Verified, error) {
		called = true
		if hostname != "llama.tee.swarm.cloud" {
			t.Errorf("hostname = %q, want the endpoint's upstream host", hostname)
		}
		var b struct {
			JWS string `json:"jws"`
		}
		if err := json.Unmarshal(bundleJSON, &b); err != nil {
			t.Fatal(err)
		}
		return &policytesting.Verified{
			Root:                   "swarm-cloud-prod",
			RootFingerprint:        trust.Sum([]byte("root")),
			ObservedTLSFingerprint: certFP,
			VerifiedAt:             time.Now(),
			Payload: map[string]any{
				"version":         "1",
				"kind":            "DeploymentEvidence",
				"hostname":        "llama.tee.swarm.cloud",
				"certFingerprint": certFP.String(),
				"evidenceDigest":  pinned.String(),
			},
		}, nil
	}

	result, err := policytesting.EvaluateFile(
		context.Background(), bundlePath, f.configPath, policytesting.Options{Verify: verify})
	if err != nil {
		t.Fatalf("EvaluateFile: %v", err)
	}
	if !called {
		t.Fatal("the verifier was not called")
	}
	if !result.CryptoVerified || !result.Admitted {
		t.Errorf("CryptoVerified=%v Admitted=%v, want both true", result.CryptoVerified, result.Admitted)
	}
	if len(result.Warnings) != 0 {
		t.Errorf("warnings = %v, want none when the bundle was really verified", result.Warnings)
	}
}

func TestEvaluateFilePropagatesAVerifierFailure(t *testing.T) {
	f := newFixture(t, "")
	bundlePath := f.writeBundle(t, pinned, []string{f.rootPEM})

	verify := func(context.Context, []byte, string) (*policytesting.Verified, error) {
		return nil, errors.New("evidence jws: signature does not verify")
	}
	_, err := policytesting.EvaluateFile(
		context.Background(), bundlePath, f.configPath, policytesting.Options{Verify: verify})
	if err == nil || !strings.Contains(err.Error(), "signature does not verify") {
		t.Fatalf("err = %v, want the verifier's failure", err)
	}
}

func TestEvaluateFileDeniesAnUnpinnedBundle(t *testing.T) {
	f := newFixture(t, "")
	bundlePath := f.writeBundle(t, unpinned, []string{f.rootPEM})

	result, err := policytesting.EvaluateFile(context.Background(), bundlePath, f.configPath, policytesting.Options{})
	if err != nil {
		t.Fatalf("EvaluateFile: %v", err)
	}
	if result.Decision.Allow || result.Admitted {
		t.Fatal("a digest that is not pinned was allowed")
	}
	if !strings.Contains(result.Decision.Reason, "gatekeeper.default") {
		t.Errorf("reason = %q, want it to name the built-in pin policy", result.Decision.Reason)
	}
}

func TestEvaluateFileRunsUserPolicies(t *testing.T) {
	const denyAll = "package user.strict\n\ndefault allow := false\n"
	f := newFixture(t, "policies:\n  - name: strict\n    file: ./strict.rego\n")
	if err := os.WriteFile(filepath.Join(f.dir, "strict.rego"), []byte(denyAll), 0o600); err != nil {
		t.Fatal(err)
	}
	bundlePath := f.writeBundle(t, pinned, []string{f.rootPEM})

	result, err := policytesting.EvaluateFile(context.Background(), bundlePath, f.configPath, policytesting.Options{})
	if err != nil {
		t.Fatalf("EvaluateFile: %v", err)
	}
	if result.Decision.Allow {
		t.Fatal("Allow = true although a user policy denies")
	}
	if len(result.Decision.Packages) != 2 {
		t.Errorf("packages = %+v, want both the built-in and the user policy", result.Decision.Packages)
	}
}

func TestEvaluateWarnsAboutAnUntrustedChain(t *testing.T) {
	f := newFixture(t, "")
	bundlePath := f.writeBundle(t, pinned, []string{selfSignedPEM(t)})

	result, err := policytesting.EvaluateFile(context.Background(), bundlePath, f.configPath, policytesting.Options{})
	if err != nil {
		t.Fatalf("EvaluateFile: %v", err)
	}
	if !strings.Contains(strings.Join(result.Warnings, "\n"), "not a trusted root") {
		t.Errorf("warnings = %v, want one about the untrusted chain terminus", result.Warnings)
	}
	if got := result.Input["attestation"].(map[string]any)["root"]; got != "" {
		t.Errorf("attestation.root = %q, want it empty for an unknown root", got)
	}
}

func TestEvaluateRejectsMalformedInput(t *testing.T) {
	f := newFixture(t, "")

	tests := []struct {
		name   string
		bundle string
		want   string
	}{
		{"not JSON", "{", "not valid JSON"},
		{"wrong kind", `{"kind":"ControlPlaneEvidence","jws":"a.b.c"}`, "not admissible"},
		{"jws is not compact", `{"kind":"DeploymentEvidence","jws":"nope"}`, "compact JWS"},
		{"payload is not JSON", `{"kind":"DeploymentEvidence","jws":"aa.bm90LWpzb24.cc"}`, "not a JSON object"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "bundle.json")
			if err := os.WriteFile(path, []byte(tc.bundle), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := policytesting.EvaluateFile(context.Background(), path, f.configPath, policytesting.Options{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestEvaluateRejectsAnUnknownEndpointOption(t *testing.T) {
	f := newFixture(t, "")
	bundlePath := f.writeBundle(t, pinned, []string{f.rootPEM})

	_, err := policytesting.EvaluateFile(
		context.Background(), bundlePath, f.configPath, policytesting.Options{Endpoint: "mistral"})
	if err == nil || !strings.Contains(err.Error(), `no endpoint named "mistral"`) {
		t.Fatalf("err = %v, want a missing-endpoint error listing the configured ones", err)
	}
}

func indent(s, prefix string) string {
	var b strings.Builder
	for _, line := range strings.Split(strings.TrimRight(s, "\n"), "\n") {
		b.WriteString(prefix + line + "\n")
	}
	return b.String()
}

func selfSignedPEM(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "swarm-cloud"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}
