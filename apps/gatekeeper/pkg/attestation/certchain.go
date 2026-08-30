package attestation

import (
	"bytes"
	"crypto/x509"
	"fmt"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/certparse"
)

// CertChainError is any failure parsing or validating the bundle's certChain.
type CertChainError struct{ msg string }

func (e *CertChainError) Error() string { return e.msg }

func chainErrf(format string, args ...any) error {
	return &CertChainError{msg: fmt.Sprintf(format, args...)}
}

// ParsedChain is a certChain that passed validation. It deliberately exposes
// DER and fingerprints rather than parsed certificates: the parser is an
// implementation detail of this package, and callers that want an
// x509.Certificate can parse the DER themselves — as long as the key is on a
// curve crypto/x509 knows.
type ParsedChain struct {
	// LeafDER is the certificate the JWS is signed by and the TLS binding is
	// compared against.
	LeafDER []byte
	// RootDER is the terminal, self-signed certificate.
	RootDER []byte
	// LeafFingerprint and RootFingerprint are the `sha256/<base64url>` digests
	// of those certificates. RootFingerprint is what the trust store matches.
	LeafFingerprint string
	RootFingerprint string

	certs []*certparse.Certificate
}

// leaf is the parsed leaf certificate, used inside the package to verify the JWS.
func (c *ParsedChain) leaf() *certparse.Certificate { return c.certs[0] }

// ValidateChain checks a PEM chain ordered leaf → root, mirroring
// libs/swarm-attestation/src/cert-chain.ts:
//
//  1. every certificate is inside its validity window at now;
//  2. every issuing certificate asserts BasicConstraints.cA, respects its own
//     pathLenConstraint, and — when it carries a KeyUsage — asserts keyCertSign;
//  3. each certificate's issuer name matches the next one's subject and its
//     signature verifies under that key;
//  4. the chain terminates at a self-signed certificate whose self-signature
//     verifies.
//
// It deliberately does not build a path against a system pool: the terminal
// root is matched against the user's trust store by fingerprint afterwards
// (ADR-003 §2), and Swarm Cloud roots are not publicly trusted.
func ValidateChain(pems []string, now time.Time) (*ParsedChain, error) {
	certs, err := parseCertificates(pems)
	if err != nil {
		return nil, err
	}

	for _, cert := range certs {
		if cert.NotBefore.After(now) {
			return nil, chainErrf("certificate %q is not yet valid", cert.Subject)
		}
		if cert.NotAfter.Before(now) {
			return nil, chainErrf("certificate %q has expired", cert.Subject)
		}
	}

	// X.509 issuer hygiene on every non-leaf certificate. Without it a malformed
	// chain — an end-entity certificate acting as a CA, or one claiming itself as
	// issuer — would pass on issuer name plus signature alone.
	for i := 1; i < len(certs); i++ {
		issuer := certs[i]
		if !issuer.BasicConstraintsPresent || !issuer.IsCA {
			return nil, chainErrf(
				"certificate at index %d (%q) is not a CA (BasicConstraints.cA missing or false)", i, issuer.Subject)
		}
		intermediatesBelow := i - 1
		if issuer.MaxPathLenPresent && issuer.MaxPathLen < intermediatesBelow {
			return nil, chainErrf(
				"pathLenConstraint=%d on %q is exceeded by chain depth %d", issuer.MaxPathLen, issuer.Subject, intermediatesBelow)
		}
		if issuer.KeyUsagePresent && issuer.KeyUsage&x509.KeyUsageCertSign == 0 {
			return nil, chainErrf(
				"certificate at index %d (%q) does not assert keyCertSign in KeyUsage", i, issuer.Subject)
		}
	}

	for i := 0; i < len(certs)-1; i++ {
		child, parent := certs[i], certs[i+1]
		if !bytes.Equal(child.RawIssuer, parent.RawSubject) {
			return nil, chainErrf(
				"certificate at index %d (%q) issuer does not match next certificate's subject", i, child.Subject)
		}
		if err := child.CheckSignatureFrom(parent); err != nil {
			return nil, chainErrf(
				"signature verification failed for certificate at index %d (%q): %v", i, child.Subject, err)
		}
	}

	root := certs[len(certs)-1]
	if !bytes.Equal(root.RawIssuer, root.RawSubject) {
		return nil, chainErrf("chain does not terminate at a self-signed root certificate")
	}
	if err := root.CheckSignatureFrom(root); err != nil {
		return nil, chainErrf("root self-signature is invalid: %v", err)
	}

	return &ParsedChain{
		LeafDER:         certs[0].Raw,
		RootDER:         root.Raw,
		LeafFingerprint: SHA256Fingerprint(certs[0].Raw),
		RootFingerprint: SHA256Fingerprint(root.Raw),
		certs:           certs,
	}, nil
}

// parseCertificates parses a chain of PEM certificates, keeping the order.
func parseCertificates(pems []string) ([]*certparse.Certificate, error) {
	if len(pems) == 0 {
		return nil, chainErrf("certChain must contain at least one certificate")
	}
	certs := make([]*certparse.Certificate, 0, len(pems))
	for i, p := range pems {
		cert, err := certparse.ParsePEM(p)
		if err != nil {
			return nil, chainErrf("failed to parse certificate at index %d: %v", i, err)
		}
		certs = append(certs, cert)
	}
	return certs, nil
}

// RootFingerprintFromPEM returns the fingerprint a trusted-root PEM is matched by.
func RootFingerprintFromPEM(pemBytes string) (string, error) {
	cert, err := certparse.ParsePEM(pemBytes)
	if err != nil {
		return "", err
	}
	return SHA256Fingerprint(cert.Raw), nil
}
