package verifier_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

// testCA is a throwaway two-level PKI plus the JWS signer that goes with it —
// enough to build bundles the real verifier accepts, so these tests exercise
// the whole pipeline rather than a stub of it.
type testCA struct {
	rootPEM string
	leafPEM string
	leafDER []byte
	leafKey *rsa.PrivateKey
}

// RSA-2048 twice is the slowest thing in this package's tests, so the keys are
// generated once and shared.
var sharedCA *testCA

func newTestCA(t *testing.T) *testCA {
	t.Helper()
	if sharedCA != nil {
		return sharedCA
	}

	rootKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generating the root key: %v", err)
	}
	rootTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "swarm-cloud-test-root"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTemplate, rootTemplate, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatalf("creating the root certificate: %v", err)
	}
	rootCert, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatal(err)
	}

	leafKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generating the leaf key: %v", err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "llama-33-70b.tee.swarm.cloud"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		DNSNames:     []string{"llama-33-70b.tee.swarm.cloud"},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, rootCert, &leafKey.PublicKey, rootKey)
	if err != nil {
		t.Fatalf("creating the leaf certificate: %v", err)
	}

	sharedCA = &testCA{
		rootPEM: encodePEM(rootDER),
		leafPEM: encodePEM(leafDER),
		leafDER: leafDER,
		leafKey: leafKey,
	}
	return sharedCA
}

func encodePEM(der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// leafFingerprint is the `sha256/<base64url>` of the leaf DER — the value the
// payload has to claim and the handshake has to present.
func (ca *testCA) leafFingerprint() string { return attestation.SHA256Fingerprint(ca.leafDER) }

// bundleOptions tweaks one generated bundle, so a test can make exactly one
// thing wrong.
type bundleOptions struct {
	Hostname       string
	EvidenceDigest string
	IssuedAt       time.Time
	// CertFingerprint overrides what the payload claims the TLS leaf is.
	CertFingerprint string
	// Chain overrides the certChain, e.g. to terminate somewhere untrusted.
	Chain []string
	// Images are written into the deployment snapshot.
	Images []string
	// BreakSignature corrupts the JWS after signing.
	BreakSignature bool
}

// bundle builds a signed evidence bundle.
func (ca *testCA) bundle(t *testing.T, opts bundleOptions) []byte {
	t.Helper()
	if opts.Hostname == "" {
		opts.Hostname = "llama-33-70b.tee.swarm.cloud"
	}
	if opts.IssuedAt.IsZero() {
		opts.IssuedAt = time.Now().Add(-2 * time.Minute)
	}
	if opts.CertFingerprint == "" {
		opts.CertFingerprint = ca.leafFingerprint()
	}
	if opts.Chain == nil {
		opts.Chain = []string{ca.leafPEM, ca.rootPEM}
	}
	if opts.Images == nil {
		opts.Images = []string{"ghcr.io/super-protocol/vllm@sha256:aaaa"}
	}

	containers := make([]any, 0, len(opts.Images))
	for i, image := range opts.Images {
		containers = append(containers, map[string]any{"name": "c" + string(rune('0'+i)), "image": image})
	}
	payload := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        opts.Hostname,
		"issuedAt":        opts.IssuedAt.UTC().Format(time.RFC3339),
		"certFingerprint": opts.CertFingerprint,
		"evidence": map[string]any{
			"deployment": map[string]any{"containers": containers},
		},
	}
	// An empty digest means "publish none at all", which is what a control-plane
	// bundle looks like to the pin policy.
	if opts.EvidenceDigest != "" {
		payload["evidenceDigest"] = opts.EvidenceDigest
	}

	jws := ca.signJWS(t, payload)
	if opts.BreakSignature {
		jws = jws[:len(jws)-4] + "AAAA"
	}

	document := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        opts.Hostname,
		"issuedAt":        payload["issuedAt"],
		"certFingerprint": opts.CertFingerprint,
		"jws":             jws,
		"certChain":       opts.Chain,
		"rootCaTeeQuote":  map[string]any{"format": "intel-tdx-quote-v5"},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// signJWS produces a compact RS256 JWS under the leaf key.
func (ca *testCA) signJWS(t *testing.T, payload map[string]any) string {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	claims := base64.RawURLEncoding.EncodeToString(body)
	digest := sha256Of(header + "." + claims)
	signature, err := rsa.SignPKCS1v15(rand.Reader, ca.leafKey, crypto.SHA256, digest)
	if err != nil {
		t.Fatal(err)
	}
	return header + "." + claims + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func sha256Of(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

// fetcher replays a prepared bundle through the verifier's transport seam,
// supplying the observed TLS fingerprint the real Fetch would have captured.
func (ca *testCA) fetcher(document []byte, observed string) attestation.Fetcher {
	return func(_ context.Context, hostname string, _ attestation.FetchOptions) (*attestation.FetchResult, error) {
		return &attestation.FetchResult{
			URL:                    "https://" + hostname + attestation.EvidencePath,
			StatusCode:             200,
			Body:                   document,
			ObservedLeafDER:        ca.leafDER,
			ObservedTLSFingerprint: observed,
		}, nil
	}
}

// newForeignCA is a second, unrelated PKI: the one a chain that terminates
// outside the trust store came from.
func newForeignCA(t *testing.T) *testCA {
	t.Helper()
	if sharedForeignCA != nil {
		return sharedForeignCA
	}
	saved := sharedCA
	sharedCA = nil
	sharedForeignCA = newTestCA(t)
	sharedCA = saved
	return sharedForeignCA
}

var sharedForeignCA *testCA

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
