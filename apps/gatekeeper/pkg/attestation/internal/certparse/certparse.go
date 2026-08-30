// Package certparse parses X.509 certificates for the attestation verifier.
//
// It exists because Swarm Cloud chains are signed with secp256k1 (ECDSA K-256)
// keys, a curve crypto/x509 refuses outright: ParseCertificate fails with
// "unsupported elliptic curve" before any field can be read. The TypeScript
// verifier hits the same wall in the browser and works around it with a noble
// fallback (libs/swarm-attestation/src/crypto-secp256k1.ts); this package is the
// Go equivalent.
//
// The parser reads the RFC 5280 structure with encoding/asn1 and delegates the
// parts crypto/x509 does handle (RSA and NIST-curve SubjectPublicKeyInfo) to
// x509.ParsePKIXPublicKey. Certificates are never re-encoded: signatures are
// checked over the exact TBSCertificate bytes carried by the input DER.
package certparse

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	secpecdsa "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// KeyAlgorithm identifies the public key carried by a certificate.
type KeyAlgorithm int

const (
	// KeyUnknown is the zero value; a certificate never carries it.
	KeyUnknown KeyAlgorithm = iota
	// KeyRSA is an rsaEncryption key.
	KeyRSA
	// KeyECDSA is an id-ecPublicKey key on a curve crypto/x509 supports (P-256/384/521).
	KeyECDSA
	// KeySecp256k1 is an id-ecPublicKey key on secp256k1 (K-256).
	KeySecp256k1
)

func (k KeyAlgorithm) String() string {
	switch k {
	case KeyRSA:
		return "RSA"
	case KeyECDSA:
		return "ECDSA"
	case KeySecp256k1:
		return "ECDSA(secp256k1)"
	default:
		return "unknown"
	}
}

// Error is returned for every parse or signature-check failure.
type Error struct{ msg string }

func (e *Error) Error() string { return e.msg }

func errf(format string, args ...any) error { return &Error{msg: fmt.Sprintf(format, args...)} }

// Certificate is the subset of an X.509 certificate the verifier needs.
type Certificate struct {
	// Raw is the full DER of the certificate; its SHA-256 is the fingerprint.
	Raw []byte
	// RawTBS is the exact TBSCertificate DER the signature covers.
	RawTBS []byte

	RawIssuer  []byte
	RawSubject []byte
	Issuer     string
	Subject    string

	NotBefore time.Time
	NotAfter  time.Time

	SignatureAlgorithm asn1.ObjectIdentifier
	Signature          []byte

	KeyAlgorithm       KeyAlgorithm
	RawSPKI            []byte
	RSAPublicKey       *rsa.PublicKey
	ECDSAPublicKey     *ecdsa.PublicKey
	Secp256k1PublicKey *secp256k1.PublicKey

	// BasicConstraints
	BasicConstraintsPresent bool
	IsCA                    bool
	MaxPathLen              int
	MaxPathLenPresent       bool

	// KeyUsage
	KeyUsagePresent bool
	KeyUsage        x509.KeyUsage
}

type tbsCertificate struct {
	Raw                asn1.RawContent
	Version            int `asn1:"optional,explicit,default:0,tag:0"`
	SerialNumber       *big.Int
	SignatureAlgorithm pkix.AlgorithmIdentifier
	Issuer             asn1.RawValue
	Validity           validity
	Subject            asn1.RawValue
	PublicKey          publicKeyInfo
	UniqueID           asn1.BitString   `asn1:"optional,tag:1"`
	SubjectUniqueID    asn1.BitString   `asn1:"optional,tag:2"`
	Extensions         []pkix.Extension `asn1:"optional,explicit,tag:3"`
}

type validity struct {
	NotBefore, NotAfter time.Time
}

type publicKeyInfo struct {
	Raw       asn1.RawContent
	Algorithm pkix.AlgorithmIdentifier
	PublicKey asn1.BitString
}

type certificate struct {
	Raw                asn1.RawContent
	TBSCertificate     tbsCertificate
	SignatureAlgorithm pkix.AlgorithmIdentifier
	SignatureValue     asn1.BitString
}

type basicConstraints struct {
	IsCA       bool `asn1:"optional"`
	MaxPathLen int  `asn1:"optional,default:-1"`
}

var (
	oidRSAEncryption = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	oidECPublicKey   = asn1.ObjectIdentifier{1, 2, 840, 10045, 2, 1}
	oidSecp256k1     = asn1.ObjectIdentifier{1, 3, 132, 0, 10}

	oidExtBasicConstraints = asn1.ObjectIdentifier{2, 5, 29, 19}
	oidExtKeyUsage         = asn1.ObjectIdentifier{2, 5, 29, 15}
)

// signatureAlgorithms maps the signature OIDs the verifier accepts to their
// digest. SHA-1 is deliberately absent: nothing in the Swarm Cloud trust chain
// issues it, and accepting it would weaken the anchor for no gain.
var signatureAlgorithms = map[string]struct {
	hash    crypto.Hash
	ecdsaOK bool
	rsaOK   bool
	name    string
}{
	"1.2.840.113549.1.1.11": {crypto.SHA256, false, true, "SHA256-RSA"},
	"1.2.840.113549.1.1.12": {crypto.SHA384, false, true, "SHA384-RSA"},
	"1.2.840.113549.1.1.13": {crypto.SHA512, false, true, "SHA512-RSA"},
	"1.2.840.10045.4.3.2":   {crypto.SHA256, true, false, "ECDSA-SHA256"},
	"1.2.840.10045.4.3.3":   {crypto.SHA384, true, false, "ECDSA-SHA384"},
	"1.2.840.10045.4.3.4":   {crypto.SHA512, true, false, "ECDSA-SHA512"},
}

// ParsePEM parses a single PEM-encoded certificate. Additional PEM blocks after
// the first are rejected: a chain entry must be exactly one certificate, so a
// second block would silently go unverified.
func ParsePEM(pemBytes string) (*Certificate, error) {
	block, rest := pem.Decode([]byte(pemBytes))
	if block == nil {
		return nil, errf("no PEM block found")
	}
	if block.Type != "CERTIFICATE" {
		return nil, errf("PEM block is %q, expected CERTIFICATE", block.Type)
	}
	if trailing, _ := pem.Decode(rest); trailing != nil {
		return nil, errf("PEM contains more than one certificate")
	}
	return ParseDER(block.Bytes)
}

// ParseDER parses a DER-encoded certificate.
func ParseDER(der []byte) (*Certificate, error) {
	var raw certificate
	rest, err := asn1.Unmarshal(der, &raw)
	if err != nil {
		return nil, errf("malformed certificate: %v", err)
	}
	if len(rest) > 0 {
		return nil, errf("malformed certificate: %d trailing bytes", len(rest))
	}
	tbs := raw.TBSCertificate

	// RFC 5280 4.1.1.2: the outer signatureAlgorithm must equal the one inside
	// the TBS. A mismatch means the digest a verifier picks is not the one the
	// issuer committed to, so refuse rather than pick either.
	if !raw.SignatureAlgorithm.Algorithm.Equal(tbs.SignatureAlgorithm.Algorithm) {
		return nil, errf("signature algorithm %v does not match the one inside TBSCertificate (%v)",
			raw.SignatureAlgorithm.Algorithm, tbs.SignatureAlgorithm.Algorithm)
	}
	if raw.SignatureValue.BitLength%8 != 0 {
		return nil, errf("signature is not a whole number of bytes")
	}

	cert := &Certificate{
		Raw:                raw.Raw,
		RawTBS:             tbs.Raw,
		RawIssuer:          tbs.Issuer.FullBytes,
		RawSubject:         tbs.Subject.FullBytes,
		NotBefore:          tbs.Validity.NotBefore,
		NotAfter:           tbs.Validity.NotAfter,
		SignatureAlgorithm: raw.SignatureAlgorithm.Algorithm,
		Signature:          raw.SignatureValue.RightAlign(),
		RawSPKI:            tbs.PublicKey.Raw,
		MaxPathLen:         -1,
	}

	if cert.Issuer, err = distinguishedName(tbs.Issuer); err != nil {
		return nil, errf("malformed issuer name: %v", err)
	}
	if cert.Subject, err = distinguishedName(tbs.Subject); err != nil {
		return nil, errf("malformed subject name: %v", err)
	}
	if err := cert.parsePublicKey(tbs.PublicKey); err != nil {
		return nil, err
	}
	if err := cert.parseExtensions(tbs.Extensions); err != nil {
		return nil, err
	}
	return cert, nil
}

func distinguishedName(name asn1.RawValue) (string, error) {
	var rdns pkix.RDNSequence
	if _, err := asn1.Unmarshal(name.FullBytes, &rdns); err != nil {
		return "", err
	}
	return rdns.String(), nil
}

func (c *Certificate) parsePublicKey(spki publicKeyInfo) error {
	switch {
	case spki.Algorithm.Algorithm.Equal(oidRSAEncryption):
		key, err := x509.ParsePKIXPublicKey(spki.Raw)
		if err != nil {
			return errf("failed to parse RSA public key: %v", err)
		}
		rsaKey, ok := key.(*rsa.PublicKey)
		if !ok {
			return errf("rsaEncryption key parsed as %T", key)
		}
		c.KeyAlgorithm, c.RSAPublicKey = KeyRSA, rsaKey
		return nil

	case spki.Algorithm.Algorithm.Equal(oidECPublicKey):
		var curve asn1.ObjectIdentifier
		if _, err := asn1.Unmarshal(spki.Algorithm.Parameters.FullBytes, &curve); err != nil {
			return errf("failed to parse EC curve parameters: %v", err)
		}
		if curve.Equal(oidSecp256k1) {
			// crypto/x509 cannot reach this branch at all, hence the dcrd parser.
			key, err := secp256k1.ParsePubKey(spki.PublicKey.RightAlign())
			if err != nil {
				return errf("failed to parse secp256k1 public key: %v", err)
			}
			c.KeyAlgorithm, c.Secp256k1PublicKey = KeySecp256k1, key
			return nil
		}
		key, err := x509.ParsePKIXPublicKey(spki.Raw)
		if err != nil {
			return errf("failed to parse EC public key on curve %v: %v", curve, err)
		}
		ecKey, ok := key.(*ecdsa.PublicKey)
		if !ok {
			return errf("id-ecPublicKey key parsed as %T", key)
		}
		c.KeyAlgorithm, c.ECDSAPublicKey = KeyECDSA, ecKey
		return nil

	default:
		return errf("unsupported public key algorithm %v", spki.Algorithm.Algorithm)
	}
}

func (c *Certificate) parseExtensions(extensions []pkix.Extension) error {
	for _, ext := range extensions {
		switch {
		case ext.Id.Equal(oidExtBasicConstraints):
			var bc basicConstraints
			if _, err := asn1.Unmarshal(ext.Value, &bc); err != nil {
				return errf("malformed BasicConstraints extension: %v", err)
			}
			c.BasicConstraintsPresent = true
			c.IsCA = bc.IsCA
			if bc.MaxPathLen >= 0 {
				c.MaxPathLen, c.MaxPathLenPresent = bc.MaxPathLen, true
			}

		case ext.Id.Equal(oidExtKeyUsage):
			var bits asn1.BitString
			if _, err := asn1.Unmarshal(ext.Value, &bits); err != nil {
				return errf("malformed KeyUsage extension: %v", err)
			}
			// KeyUsage bit i maps onto x509.KeyUsage bit i; nine bits are defined.
			usage := 0
			for i := 0; i < 9 && i < bits.BitLength; i++ {
				if bits.At(i) != 0 {
					usage |= 1 << i //nolint:gosec // i is bounded by the loop to [0,9)
				}
			}
			c.KeyUsagePresent, c.KeyUsage = true, x509.KeyUsage(usage)
		}
	}
	return nil
}

// CheckSignatureFrom verifies that parent signed this certificate.
func (c *Certificate) CheckSignatureFrom(parent *Certificate) error {
	return parent.CheckSignature(c.SignatureAlgorithm, c.RawTBS, c.Signature)
}

// CheckSignature verifies sig over signed using this certificate's public key
// and the digest named by algorithm.
func (c *Certificate) CheckSignature(algorithm asn1.ObjectIdentifier, signed, sig []byte) error {
	spec, ok := signatureAlgorithms[algorithm.String()]
	if !ok {
		return errf("unsupported signature algorithm %v", algorithm)
	}
	digest := spec.hash.New()
	digest.Write(signed)
	sum := digest.Sum(nil)

	switch c.KeyAlgorithm {
	case KeyRSA:
		if !spec.rsaOK {
			return errf("signature algorithm %s cannot be verified with an RSA key", spec.name)
		}
		if err := rsa.VerifyPKCS1v15(c.RSAPublicKey, spec.hash, sum, sig); err != nil {
			return errf("%s signature verification failed: %v", spec.name, err)
		}
		return nil

	case KeyECDSA:
		if !spec.ecdsaOK {
			return errf("signature algorithm %s cannot be verified with an ECDSA key", spec.name)
		}
		if !ecdsa.VerifyASN1(c.ECDSAPublicKey, sum, sig) {
			return errf("%s signature verification failed", spec.name)
		}
		return nil

	case KeySecp256k1:
		if !spec.ecdsaOK {
			return errf("signature algorithm %s cannot be verified with a secp256k1 key", spec.name)
		}
		parsed, err := secpecdsa.ParseDERSignature(sig)
		if err != nil {
			return errf("failed to parse secp256k1 signature: %v", err)
		}
		if !parsed.Verify(sum, c.Secp256k1PublicKey) {
			return errf("%s signature verification failed", spec.name)
		}
		return nil

	default:
		return errf("certificate carries no usable public key")
	}
}
