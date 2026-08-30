package attestation_test

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/testca"
)

// The certificate matrix the Go-side tests are built on. The shared conformance
// vectors in libs/attestation-fixtures are the contract both verifiers are held
// to; this kit exists for the cases that are about *this* implementation — the
// chain-hygiene rules, the fetch layer, and the Go API surface.
const (
	testHostname = "llama-33-70b.tee.swarm.cloud"
	// testNow is the clock tests verify under unless they are exercising the
	// validity window or the freshness check.
	testNow = "2026-08-30T10:06:00Z"
	// canonicalEvidence is the deployment snapshot the payloads digest. Its
	// exact bytes matter: evidenceDigest is the SHA-256 of this document.
	canonicalEvidence = `{"version":2,"resources":[{"image":"ghcr.io/super-protocol/router-api@sha256:` +
		`3f0a1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c","kind":"Deployment",` +
		`"name":"router-api"}]}`
)

// testKit holds every certificate the Go-side tests are built from. One kit
// mints the whole matrix so the chains stay internally consistent: the same root
// signs the healthy chains and the tampered ones.
type testKit struct {
	rsaRoot, rsaInter, rsaLeaf             *testca.Cert
	k1Root, k1Inter, k1Leaf                *testca.Cert
	otherRoot                              *testca.Cert
	strayLeaf                              *testca.Cert
	forgedSignatureLeaf                    *testca.Cert
	forgedIssuerLeaf                       *testca.Cert
	nonCAInter, nonCAInterLeaf             *testca.Cert
	noCertSignInter, noCertSignLeaf        *testca.Cert
	pathLenRoot, pathLenInter, pathLenLeaf *testca.Cert
}

var (
	kitOnce  sync.Once
	kitValue *testKit
)

// testKitFor memoises one kit for the whole test binary. Minting the matrix
// costs a dozen RSA key generations; the certificates are immutable once
// issued, so every read-only test can share them.
func testKitFor(t *testing.T) *testKit {
	t.Helper()
	kitOnce.Do(func() { kitValue = newTestKit(t) })
	return kitValue
}

func newTestKit(t *testing.T) *testKit {
	t.Helper()
	notBefore := mustTime(t, "2026-08-01T00:00:00Z")
	notAfter := mustTime(t, "2027-08-01T00:00:00Z")

	caUsage := x509.KeyUsageCertSign | x509.KeyUsageCRLSign
	ca := func(cn string, maxPathLen int) testca.Template {
		return testca.Template{
			CommonName: cn, NotBefore: notBefore, NotAfter: notAfter,
			IsCA: true, MaxPathLen: maxPathLen, KeyUsage: caUsage,
		}
	}
	ee := func(cn string) testca.Template {
		return testca.Template{
			CommonName: cn, NotBefore: notBefore, NotAfter: notAfter,
			MaxPathLen: -1, KeyUsage: x509.KeyUsageDigitalSignature,
		}
	}

	kit := &testKit{}
	kit.rsaRoot = issue(t, ca("Swarm Cloud Test Root RSA", -1), testca.RSA, nil)
	kit.rsaInter = issue(t, ca("Swarm Cloud Test Intermediate RSA", -1), testca.RSA, kit.rsaRoot)
	kit.rsaLeaf = issue(t, ee(testHostname), testca.RSA, kit.rsaInter)

	kit.k1Root = issue(t, ca("Swarm Cloud Test Root K256", -1), testca.Secp256k1, nil)
	kit.k1Inter = issue(t, ca("Swarm Cloud Test Intermediate K256", -1), testca.Secp256k1, kit.k1Root)
	kit.k1Leaf = issue(t, ee(testHostname), testca.Secp256k1, kit.k1Inter)

	kit.otherRoot = issue(t, ca("Some Other Cloud Root", -1), testca.RSA, nil)
	kit.strayLeaf = issue(t, ee("stray.example.com"), testca.RSA, kit.otherRoot)

	// A leaf whose issuer name says "signed by the intermediate" but whose
	// signature was produced by an unrelated CA key.
	forgedSignature := ee(testHostname)
	forgedSignature.IssuerOverride = &kit.rsaInter.Subject
	kit.forgedSignatureLeaf = issue(t, forgedSignature, testca.RSA, kit.otherRoot)

	// A leaf that names an issuer nobody in the chain matches.
	forgedIssuer := ee(testHostname)
	forgedIssuer.IssuerOverride = &pkix.Name{CommonName: "Not In This Chain"}
	kit.forgedIssuerLeaf = issue(t, forgedIssuer, testca.RSA, kit.rsaInter)

	nonCA := ee("Intermediate Without BasicConstraints")
	nonCA.OmitBasicConstraints = true
	kit.nonCAInter = issue(t, nonCA, testca.RSA, kit.rsaRoot)
	kit.nonCAInterLeaf = issue(t, ee(testHostname), testca.RSA, kit.nonCAInter)

	noCertSign := ca("Intermediate Without keyCertSign", -1)
	noCertSign.KeyUsage = x509.KeyUsageDigitalSignature
	kit.noCertSignInter = issue(t, noCertSign, testca.RSA, kit.rsaRoot)
	kit.noCertSignLeaf = issue(t, ee(testHostname), testca.RSA, kit.noCertSignInter)

	kit.pathLenRoot = issue(t, ca("Root With pathLenConstraint 0", 0), testca.RSA, nil)
	kit.pathLenInter = issue(t, ca("Intermediate Below pathLen 0", -1), testca.RSA, kit.pathLenRoot)
	kit.pathLenLeaf = issue(t, ee(testHostname), testca.RSA, kit.pathLenInter)

	return kit
}

func issue(t *testing.T, template testca.Template, algorithm testca.Algorithm, issuer *testca.Cert) *testca.Cert {
	t.Helper()
	key, err := testca.NewKey(algorithm)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	cert, err := testca.Issue(template, key, issuer)
	if err != nil {
		t.Fatalf("issue %q: %v", template.CommonName, err)
	}
	return cert
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed
}

// buildBundle assembles a bundle document. mutatePayload runs before the JWS is
// signed (so the mutation is covered by the signature); mutateBundle runs after
// (so it is not).
func buildBundle(
	t *testing.T,
	hostname string,
	chain []*testca.Cert,
	jwsSigner *testca.Cert,
	issuedAt time.Time,
	mutatePayload func(map[string]any),
	mutateBundle func(map[string]any),
) map[string]any {
	t.Helper()
	leaf := chain[0]
	timestamp := issuedAt.UTC().Format(time.RFC3339)

	payload := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        hostname,
		"issuedAt":        timestamp,
		"certFingerprint": leaf.Fingerprint(),
		"evidenceDigest":  attestation.SHA256Fingerprint([]byte(canonicalEvidence)),
		"evidence":        json.RawMessage(canonicalEvidence),
	}
	if mutatePayload != nil {
		mutatePayload(payload)
	}
	jws, err := jwsSigner.SignJWS(payload)
	if err != nil {
		t.Fatalf("sign JWS: %v", err)
	}

	pems := make([]string, 0, len(chain))
	for _, cert := range chain {
		pems = append(pems, cert.PEM)
	}

	bundle := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        hostname,
		"issuedAt":        timestamp,
		"certFingerprint": leaf.Fingerprint(),
		"jws":             jws,
		"certChain":       pems,
	}
	if mutateBundle != nil {
		mutateBundle(bundle)
	}
	return bundle
}

// document marshals a bundle as the bytes an endpoint would serve.
func document(t *testing.T, bundle map[string]any) []byte {
	t.Helper()
	encoded, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	return encoded
}
