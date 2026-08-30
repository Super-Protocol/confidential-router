package attestation

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/certparse"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	secpecdsa "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// Supported JWS algorithms. RS256 covers the auto-SSL RSA leaves; ES256K covers
// the secp256k1 leaves Swarm Cloud issues inside the TEE.
const (
	algRS256  = "RS256"
	algES256K = "ES256K"
)

// minRSABits is the smallest RSA modulus RS256 is accepted with. rsa.VerifyPKCS1v15
// will happily verify under a 1024-bit key; jose — and therefore the TypeScript
// verifier — refuses anything below 2048, so without this floor the two would
// disagree on a bundle signed by an undersized leaf. Erring towards the stricter
// side keeps the verdicts identical and the weaker key rejected.
const minRSABits = 2048

// jwsError is any failure decoding or verifying the compact JWS.
type jwsError struct{ msg string }

func (e *jwsError) Error() string { return e.msg }

func jwsErrf(format string, args ...any) error { return &jwsError{msg: fmt.Sprintf(format, args...)} }

// verifyJWS verifies a compact JWS against the chain's leaf certificate and
// returns the evidence payload it carries.
//
// Only the base fields are validated, matching the TypeScript verifier: a
// payload missing a kind-specific field is still a valid payload here and is
// rejected later by policy, so the two implementations never disagree on a
// verdict.
func verifyJWS(jws string, leaf *certparse.Certificate) (Payload, error) {
	segments := strings.Split(jws, ".")
	if len(segments) != 3 {
		return nil, jwsErrf("compact JWS must have exactly 3 segments")
	}
	headerB64, payloadB64, signatureB64 := segments[0], segments[1], segments[2]

	headerBytes, err := base64.RawURLEncoding.DecodeString(headerB64)
	if err != nil {
		return nil, jwsErrf("failed to decode JWS protected header: %v", err)
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, jwsErrf("failed to decode JWS protected header: %v", err)
	}
	alg := header.Alg
	if alg == "" {
		alg = "<missing>"
	}
	if alg != algRS256 && alg != algES256K {
		return nil, jwsErrf("unsupported JWS alg %q (expected RS256 or ES256K)", alg)
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return nil, jwsErrf("failed to decode JWS segment: %v", err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(signatureB64)
	if err != nil {
		return nil, jwsErrf("failed to decode JWS segment: %v", err)
	}
	signingInput := []byte(headerB64 + "." + payloadB64)

	switch alg {
	case algRS256:
		if err := verifyRS256(signingInput, signature, leaf); err != nil {
			return nil, err
		}
	case algES256K:
		if err := verifyES256K(signingInput, signature, leaf); err != nil {
			return nil, err
		}
	}

	return parsePayload(payloadBytes)
}

func verifyRS256(signingInput, signature []byte, leaf *certparse.Certificate) error {
	if leaf.KeyAlgorithm != certparse.KeyRSA {
		return jwsErrf("JWS alg is RS256 but leaf certificate key is %s", leaf.KeyAlgorithm)
	}
	if bits := leaf.RSAPublicKey.N.BitLen(); bits < minRSABits {
		return jwsErrf("RS256 requires an RSA key of at least %d bits, leaf has %d", minRSABits, bits)
	}
	sum := sha256.Sum256(signingInput)
	if err := rsa.VerifyPKCS1v15(leaf.RSAPublicKey, crypto.SHA256, sum[:], signature); err != nil {
		return jwsErrf("signature verification failed: %v", err)
	}
	return nil
}

func verifyES256K(signingInput, signature []byte, leaf *certparse.Certificate) error {
	if leaf.KeyAlgorithm != certparse.KeySecp256k1 {
		return jwsErrf("JWS alg is ES256K but leaf certificate key is not secp256k1")
	}
	sig, err := parseES256KSignature(signature)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(signingInput)
	if !sig.Verify(sum[:], leaf.Secp256k1PublicKey) {
		return jwsErrf("ES256K signature verification failed")
	}
	return nil
}

// parseES256KSignature accepts the 64-byte r||s form RFC 7515 mandates and, as
// the TypeScript verifier does, the DER form some producers emit.
func parseES256KSignature(signature []byte) (*secpecdsa.Signature, error) {
	if len(signature) != 64 {
		sig, err := secpecdsa.ParseDERSignature(signature)
		if err != nil {
			return nil, jwsErrf("failed to parse ES256K signature: %v", err)
		}
		return sig, nil
	}
	var r, s secp256k1.ModNScalar
	if overflow := r.SetByteSlice(signature[:32]); overflow {
		return nil, jwsErrf("failed to parse ES256K signature: R is >= the group order")
	}
	if overflow := s.SetByteSlice(signature[32:]); overflow {
		return nil, jwsErrf("failed to parse ES256K signature: S is >= the group order")
	}
	return secpecdsa.NewSignature(&r, &s), nil
}

// parsePayload decodes the JWS body into the payload struct for its kind.
func parsePayload(raw []byte) (Payload, error) {
	var base PayloadBase
	if err := json.Unmarshal(raw, &base); err != nil {
		return nil, jwsErrf("failed to parse JWS payload as JSON: %v", err)
	}
	if !isEvidencePayload(base) {
		return nil, jwsErrf("JWS payload is not a recognised evidence payload")
	}
	base.raw = append(json.RawMessage(nil), raw...)

	switch base.Kind {
	case KindDeploymentEvidence:
		payload := &DeploymentEvidencePayload{}
		if err := json.Unmarshal(raw, payload); err != nil {
			return nil, jwsErrf("failed to parse DeploymentEvidence payload: %v", err)
		}
		payload.PayloadBase = base
		return payload, nil

	case KindControlPlaneEvidence:
		payload := &ControlPlaneEvidencePayload{}
		if err := json.Unmarshal(raw, payload); err != nil {
			return nil, jwsErrf("failed to parse ControlPlaneEvidence payload: %v", err)
		}
		payload.PayloadBase = base
		return payload, nil

	default:
		payload := &KubernetesControlPlaneEvidencePayload{}
		if err := json.Unmarshal(raw, payload); err != nil {
			return nil, jwsErrf("failed to parse KubernetesControlPlaneEvidence payload: %v", err)
		}
		payload.PayloadBase = base
		return payload, nil
	}
}

func isEvidencePayload(base PayloadBase) bool {
	if base.Version != "1" || !base.Kind.valid() {
		return false
	}
	if base.Hostname == "" || base.IssuedAt == "" {
		return false
	}
	return strings.HasPrefix(base.CertFingerprint, FingerprintPrefix)
}
