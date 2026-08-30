package attestation

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/certparse"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/testca"
	secpecdsa "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// mintLeaf issues a self-signed end-entity certificate of the given algorithm
// and returns both the minting handle and the parsed form the verifier uses.
func mintLeaf(t *testing.T, algorithm testca.Algorithm) (*testca.Cert, *certparse.Certificate) {
	t.Helper()
	key, err := testca.NewKey(algorithm)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	cert, err := testca.Issue(testca.Template{
		CommonName: "leaf.example.com",
		NotBefore:  time.Now().Add(-time.Hour),
		NotAfter:   time.Now().Add(time.Hour),
		MaxPathLen: -1,
		KeyUsage:   x509.KeyUsageDigitalSignature,
	}, key, nil)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	parsed, err := certparse.ParsePEM(cert.PEM)
	if err != nil {
		t.Fatalf("parse minted certificate: %v", err)
	}
	return cert, parsed
}

func samplePayload(fingerprint string) map[string]any {
	return map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        "leaf.example.com",
		"issuedAt":        "2026-08-30T10:05:00Z",
		"certFingerprint": fingerprint,
		"evidenceDigest":  fingerprint,
	}
}

func TestVerifyJWSAcceptsBothSupportedAlgorithms(t *testing.T) {
	t.Parallel()
	for name, algorithm := range map[string]testca.Algorithm{"RS256": testca.RSA, "ES256K": testca.Secp256k1} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			cert, parsed := mintLeaf(t, algorithm)
			jws, err := cert.SignJWS(samplePayload(cert.Fingerprint()))
			if err != nil {
				t.Fatalf("sign: %v", err)
			}
			payload, err := verifyJWS(jws, parsed)
			if err != nil {
				t.Fatalf("verifyJWS: %v", err)
			}
			if payload.Base().Kind != KindDeploymentEvidence {
				t.Errorf("kind = %q", payload.Base().Kind)
			}
			if len(payload.Raw()) == 0 {
				t.Error("Raw() is empty; the signed bytes should be preserved")
			}
		})
	}
}

// TestVerifyJWSAcceptsDEREncodedES256K mirrors the TypeScript verifier, which
// falls back to DER parsing when a producer emits an X.509-style signature
// instead of the fixed-width r||s form RFC 7515 mandates.
func TestVerifyJWSAcceptsDEREncodedES256K(t *testing.T) {
	t.Parallel()
	cert, parsed := mintLeaf(t, testca.Secp256k1)

	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"ES256K"}`))
	body, err := json.Marshal(samplePayload(cert.Fingerprint()))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payloadSegment := base64.RawURLEncoding.EncodeToString(body)
	sum := sha256.Sum256([]byte(header + "." + payloadSegment))
	der := secpecdsa.Sign(cert.Key.Secp256k1, sum[:]).Serialize()

	jws := header + "." + payloadSegment + "." + base64.RawURLEncoding.EncodeToString(der)
	if _, err := verifyJWS(jws, parsed); err != nil {
		t.Fatalf("verifyJWS with a DER signature: %v", err)
	}
}

func TestVerifyJWSRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	cert, parsed := mintLeaf(t, testca.RSA)
	valid, err := cert.SignJWS(samplePayload(cert.Fingerprint()))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	segments := strings.Split(valid, ".")

	header := func(raw string) string {
		return base64.RawURLEncoding.EncodeToString([]byte(raw)) + "." + segments[1] + "." + segments[2]
	}

	cases := map[string]string{
		"two segments":         segments[0] + "." + segments[1],
		"four segments":        valid + ".extra",
		"header not base64url": "!!!." + segments[1] + "." + segments[2],
		"header not JSON":      header("not json"),
		"alg missing":          header(`{}`),
		"alg unsupported":      header(`{"alg":"HS256"}`),
		"payload not base64":   segments[0] + ".!!!." + segments[2],
		"signature not base64": segments[0] + "." + segments[1] + ".!!!",
		"signature truncated":  segments[0] + "." + segments[1] + "." + segments[2][:len(segments[2])-4],
	}
	for name, jws := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := verifyJWS(jws, parsed); err == nil {
				t.Fatalf("verifyJWS accepted %s", name)
			}
		})
	}
}

func TestVerifyJWSRejectsAlgorithmKeyMismatch(t *testing.T) {
	t.Parallel()
	rsaCert, rsaParsed := mintLeaf(t, testca.RSA)
	k1Cert, k1Parsed := mintLeaf(t, testca.Secp256k1)

	rsaJWS, err := rsaCert.SignJWS(samplePayload(rsaCert.Fingerprint()))
	if err != nil {
		t.Fatalf("sign RS256: %v", err)
	}
	k1JWS, err := k1Cert.SignJWS(samplePayload(k1Cert.Fingerprint()))
	if err != nil {
		t.Fatalf("sign ES256K: %v", err)
	}

	if _, err := verifyJWS(rsaJWS, k1Parsed); err == nil {
		t.Error("an RS256 JWS verified against a secp256k1 leaf")
	}
	if _, err := verifyJWS(k1JWS, rsaParsed); err == nil {
		t.Error("an ES256K JWS verified against an RSA leaf")
	}
}

func TestVerifyJWSRejectsPayloadsThatAreNotEvidence(t *testing.T) {
	t.Parallel()
	cert, parsed := mintLeaf(t, testca.RSA)

	for name, payload := range map[string]any{
		"wrong version":          map[string]any{"version": "2", "kind": "DeploymentEvidence", "hostname": "h", "issuedAt": "t", "certFingerprint": "sha256/x"},
		"unknown kind":           map[string]any{"version": "1", "kind": "Whatever", "hostname": "h", "issuedAt": "t", "certFingerprint": "sha256/x"},
		"empty hostname":         map[string]any{"version": "1", "kind": "DeploymentEvidence", "hostname": "", "issuedAt": "t", "certFingerprint": "sha256/x"},
		"missing issuedAt":       map[string]any{"version": "1", "kind": "DeploymentEvidence", "hostname": "h", "certFingerprint": "sha256/x"},
		"unscheme'd fingerprint": map[string]any{"version": "1", "kind": "DeploymentEvidence", "hostname": "h", "issuedAt": "t", "certFingerprint": "deadbeef"},
		"not an object":          []string{"nope"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			jws, err := cert.SignJWS(payload)
			if err != nil {
				t.Fatalf("sign: %v", err)
			}
			if _, err := verifyJWS(jws, parsed); err == nil {
				t.Fatalf("verifyJWS accepted a payload with %s", name)
			}
		})
	}
}

// TestVerifyJWSRejectsOutOfRangeES256KScalars covers the compact form's own
// validation: 64 bytes always parse as two scalars, so an r or s at or above
// the group order has to be caught explicitly.
func TestVerifyJWSRejectsOutOfRangeES256KScalars(t *testing.T) {
	t.Parallel()
	cert, parsed := mintLeaf(t, testca.Secp256k1)

	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"ES256K"}`))
	body, err := json.Marshal(samplePayload(cert.Fingerprint()))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	oversized := make([]byte, 64)
	for i := range oversized {
		oversized[i] = 0xff
	}

	jws := header + "." + base64.RawURLEncoding.EncodeToString(body) + "." +
		base64.RawURLEncoding.EncodeToString(oversized)
	if _, err := verifyJWS(jws, parsed); err == nil {
		t.Fatal("verifyJWS accepted a signature whose scalars exceed the group order")
	}
}

func TestPayloadKindsDecodeIntoTheirOwnStructs(t *testing.T) {
	t.Parallel()
	cert, parsed := mintLeaf(t, testca.RSA)

	deployment := samplePayload(cert.Fingerprint())
	deployment["evidence"] = json.RawMessage(`{"version":2,"resources":[]}`)
	control := samplePayload(cert.Fingerprint())
	control["kind"] = "ControlPlaneEvidence"
	control["topologyDigest"] = "sha256/topology"
	kubernetes := samplePayload(cert.Fingerprint())
	kubernetes["kind"] = "KubernetesControlPlaneEvidence"
	kubernetes["rke2Version"] = "v1.31.2+rke2r1"

	for name, tc := range map[string]struct {
		payload map[string]any
		check   func(*testing.T, Payload)
	}{
		"deployment": {deployment, func(t *testing.T, p Payload) {
			typed, ok := p.(*DeploymentEvidencePayload)
			if !ok {
				t.Fatalf("payload is %T", p)
			}
			if string(typed.Evidence) != `{"version":2,"resources":[]}` {
				t.Errorf("evidence = %s", typed.Evidence)
			}
		}},
		"control plane": {control, func(t *testing.T, p Payload) {
			typed, ok := p.(*ControlPlaneEvidencePayload)
			if !ok {
				t.Fatalf("payload is %T", p)
			}
			if typed.TopologyDigest != "sha256/topology" {
				t.Errorf("topologyDigest = %q", typed.TopologyDigest)
			}
		}},
		"kubernetes control plane": {kubernetes, func(t *testing.T, p Payload) {
			typed, ok := p.(*KubernetesControlPlaneEvidencePayload)
			if !ok {
				t.Fatalf("payload is %T", p)
			}
			if typed.RKE2Version != "v1.31.2+rke2r1" {
				t.Errorf("rke2Version = %q", typed.RKE2Version)
			}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			jws, err := cert.SignJWS(tc.payload)
			if err != nil {
				t.Fatalf("sign: %v", err)
			}
			payload, err := verifyJWS(jws, parsed)
			if err != nil {
				t.Fatalf("verifyJWS: %v", err)
			}
			tc.check(t, payload)
		})
	}
}
