package attestedroot

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/asn1"
	"errors"
	"fmt"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/internal/certparse"
)

// The OIDs a Super Swarm root certificate carries. They are the constants of
// @super-protocol/pki-common (`OID_CUSTOM_EXTENSION_CHALLENGE_TYPE`,
// `OID_CUSTOM_EXTENSION_NETWORK_TYPE`, `OID_TEE_EVIDENCE`), restated here so
// the gatekeeper's trust decision does not depend on a JavaScript package.
var (
	// oidChallengeType names the kind of enrolment challenge the CA answered:
	// "sev-snp", "tdx", "tdx-google" or "untrusted".
	oidChallengeType = asn1.ObjectIdentifier{1, 3, 6, 1, 3, 8888, 1, 1}
	// oidNetworkType is "trusted" or "untrusted" — which Super Protocol network
	// the CA belongs to.
	oidNetworkType = asn1.ObjectIdentifier{1, 3, 6, 1, 3, 8888, 4}
	// oidTeeEvidence carries the serialised TeeEvidence the CA enrolled with.
	oidTeeEvidence = asn1.ObjectIdentifier{0, 6, 9, 42, 840, 113741, 1337, 6}
)

// NetworkType is which Super Protocol network a root belongs to.
type NetworkType string

// The two network types. A root's own extension states one; the gatekeeper
// reports it rather than requiring a particular value, because the live Swarm
// stand's root is enrolled as `untrusted` and rejecting it silently would look
// exactly like a broken verifier.
const (
	NetworkTrusted   NetworkType = "trusted"
	NetworkUntrusted NetworkType = "untrusted"
)

// RootExtensions is what a root certificate declares about its own origin.
type RootExtensions struct {
	// ChallengeType is the enrolment challenge the CA answered, verbatim.
	ChallengeType string
	// NetworkType is the network the CA claims, empty when the extension is
	// absent (roots issued before the extension existed).
	NetworkType NetworkType
	// Evidence is the serialised TeeEvidence, nil when the root carries none.
	Evidence []byte
	// SPKIDigest is the SHA-256 of the certificate's SubjectPublicKeyInfo. It
	// is what the hardware report's reportData must commit to, and therefore
	// what ties the attestation to this key rather than to a VM in general.
	SPKIDigest [32]byte
}

// HasEvidence reports whether the certificate can be checked against hardware
// at all.
func (e *RootExtensions) HasEvidence() bool { return e != nil && len(e.Evidence) > 0 }

// ReadRootExtensions pulls the attestation-related extensions off a root
// certificate. A certificate with none of them is not an error: it is an
// ordinary root, which the manual trust store is for.
func ReadRootExtensions(cert *x509.Certificate) (*RootExtensions, error) {
	if cert == nil {
		return nil, errors.New("no certificate")
	}
	out := &RootExtensions{SPKIDigest: sha256.Sum256(cert.RawSubjectPublicKeyInfo)}
	for _, ext := range cert.Extensions {
		switch {
		case ext.Id.Equal(oidChallengeType):
			out.ChallengeType = extensionText(ext.Value)
		case ext.Id.Equal(oidNetworkType):
			text := extensionText(ext.Value)
			switch NetworkType(text) {
			case NetworkTrusted, NetworkUntrusted:
				out.NetworkType = NetworkType(text)
			default:
				return nil, fmt.Errorf(
					"root certificate network type extension %s is %q, expected \"trusted\" or \"untrusted\"",
					oidNetworkType, text)
			}
		case ext.Id.Equal(oidTeeEvidence):
			out.Evidence = ext.Value
		}
	}
	return out, nil
}

// BindsPublicKey reports whether a hardware report's reportData commits to the
// certificate's public key.
//
// The VM asks the firmware to bind SHA-256(SubjectPublicKeyInfo) into the
// report when it enrols, so this is the step that makes the attestation about
// *this* CA key: without it a valid report from any Super Protocol VM would
// vouch for any certificate. Only the first 32 bytes are compared — the rest of
// the 64-byte field is zero padding, or an NVIDIA token digest on GPU hosts.
func BindsPublicKey(reportData []byte, spkiDigest [32]byte) bool {
	if len(reportData) < len(spkiDigest) {
		return false
	}
	return subtle.ConstantTimeCompare(reportData[:len(spkiDigest)], spkiDigest[:]) == 1
}

// extensionText reads an extension whose value the platform writes as bare
// ASCII rather than as a DER string. The unwrapping rules are shared with the
// signer-binding reader, so the two cannot disagree about what a challenge
// type extension says.
func extensionText(value []byte) string {
	return certparse.ExtensionText(value)
}
