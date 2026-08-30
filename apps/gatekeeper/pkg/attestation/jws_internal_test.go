package attestation

import (
	"crypto"
	"crypto/rsa"
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

	// Every branch is asserted by its reason, not merely by failing: otherwise a
	// case like "alg missing" could start passing through the base64 decoder and
	// nothing here would notice.
	cases := map[string]struct{ jws, want string }{
		"two segments":  {segments[0] + "." + segments[1], "must have exactly 3 segments"},
		"four segments": {valid + ".extra", "must have exactly 3 segments"},
		// The TypeScript verifier reports both header failures the same way, so
		// these two share a reason on purpose.
		"header not base64url": {"!!!." + segments[1] + "." + segments[2], "failed to decode JWS protected header"},
		"header not JSON":      {header("not json"), "failed to decode JWS protected header"},
		"alg missing":          {header(`{}`), `unsupported JWS alg "<missing>"`},
		"alg unsupported":      {header(`{"alg":"HS256"}`), `unsupported JWS alg "HS256"`},
		"payload not base64":   {segments[0] + ".!!!." + segments[2], "failed to decode JWS segment"},
		"signature not base64": {segments[0] + "." + segments[1] + ".!!!", "failed to decode JWS segment"},
		"signature truncated": {
			segments[0] + "." + segments[1] + "." + segments[2][:len(segments[2])-4],
			"signature verification failed",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := verifyJWS(tc.jws, parsed)
			if err == nil {
				t.Fatalf("verifyJWS accepted %s", name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %q, want it to mention %q", err, tc.want)
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

	_, err = verifyJWS(rsaJWS, k1Parsed)
	if err == nil || !strings.Contains(err.Error(), "JWS alg is RS256 but leaf certificate key is ECDSA(secp256k1)") {
		t.Errorf("err = %v, want the RS256/secp256k1 mismatch to be named", err)
	}
	_, err = verifyJWS(k1JWS, rsaParsed)
	if err == nil || !strings.Contains(err.Error(), "JWS alg is ES256K but leaf certificate key is not secp256k1") {
		t.Errorf("err = %v, want the ES256K/RSA mismatch to be named", err)
	}
}

// TestVerifyJWSRejectsUndersizedRSAKeys keeps the two verifiers on the same
// verdict: jose refuses RS256 below a 2048-bit modulus, while
// rsa.VerifyPKCS1v15 accepts a 1024-bit one, so without an explicit floor a
// bundle signed by an undersized leaf would be denied by one and admitted by
// the other.
func TestVerifyJWSRejectsUndersizedRSAKeys(t *testing.T) {
	t.Parallel()
	key, err := testca.NewKeyOfSize(testca.RSA, 1024)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	cert, err := testca.Issue(testca.Template{
		CommonName: "small.example.com",
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
		t.Fatalf("parse: %v", err)
	}

	jws, err := cert.SignJWS(samplePayload(cert.Fingerprint()))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	// The signature itself is valid — only the key size is not.
	if err := rsa.VerifyPKCS1v15(parsed.RSAPublicKey, crypto.SHA256,
		signingInputDigest(t, jws), jwsSignature(t, jws)); err != nil {
		t.Fatalf("the 1024-bit signature should be cryptographically valid: %v", err)
	}

	_, err = verifyJWS(jws, parsed)
	if err == nil || !strings.Contains(err.Error(), "RS256 requires an RSA key of at least 2048 bits") {
		t.Fatalf("err = %v, want the modulus floor to be enforced", err)
	}
}

func signingInputDigest(t *testing.T, jws string) []byte {
	t.Helper()
	segments := strings.Split(jws, ".")
	sum := sha256.Sum256([]byte(segments[0] + "." + segments[1]))
	return sum[:]
}

func jwsSignature(t *testing.T, jws string) []byte {
	t.Helper()
	segments := strings.Split(jws, ".")
	signature, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	return signature
}

func TestVerifyJWSRejectsPayloadsThatAreNotEvidence(t *testing.T) {
	t.Parallel()
	cert, parsed := mintLeaf(t, testca.RSA)

	const notRecognised = "JWS payload is not a recognised evidence payload"
	base := func(overrides map[string]any) map[string]any {
		payload := map[string]any{
			"version": "1", "kind": "DeploymentEvidence", "hostname": "h",
			"issuedAt": "t", "certFingerprint": "sha256/x",
		}
		for key, value := range overrides {
			if value == nil {
				delete(payload, key)
				continue
			}
			payload[key] = value
		}
		return payload
	}

	for name, tc := range map[string]struct {
		payload any
		want    string
	}{
		"wrong version":          {base(map[string]any{"version": "2"}), notRecognised},
		"unknown kind":           {base(map[string]any{"kind": "Whatever"}), notRecognised},
		"empty hostname":         {base(map[string]any{"hostname": ""}), notRecognised},
		"missing issuedAt":       {base(map[string]any{"issuedAt": nil}), notRecognised},
		"unscheme'd fingerprint": {base(map[string]any{"certFingerprint": "deadbeef"}), notRecognised},
		// A payload that is valid JSON but not an object cannot even be decoded
		// into the base struct, so it fails one step earlier.
		"not an object": {[]string{"nope"}, "failed to parse JWS payload as JSON"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			jws, err := cert.SignJWS(tc.payload)
			if err != nil {
				t.Fatalf("sign: %v", err)
			}
			_, err = verifyJWS(jws, parsed)
			if err == nil {
				t.Fatalf("verifyJWS accepted a payload with %s", name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %q, want it to mention %q", err, tc.want)
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
	_, err = verifyJWS(jws, parsed)
	if err == nil || !strings.Contains(err.Error(), "R is >= the group order") {
		t.Fatalf("err = %v, want the out-of-range scalar to be named", err)
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
