// Package testca mints the certificate chains and signed evidence bundles the
// attestation tests and the conformance fixtures run against.
//
// It cannot use x509.CreateCertificate for the secp256k1 half of the matrix:
// crypto/x509 has no encoder for K-256 keys, the same gap certparse works
// around on the parsing side. Certificates are therefore assembled from the
// RFC 5280 ASN.1 structures directly, which also makes it easy to mint the
// deliberately broken chains the negative cases need.
package testca

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	secpecdsa "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// Algorithm selects the key type of a minted certificate.
type Algorithm int

const (
	// RSA mints an rsaEncryption key signed with sha256WithRSAEncryption.
	RSA Algorithm = iota
	// Secp256k1 mints an id-ecPublicKey K-256 key signed with ecdsa-with-SHA256.
	Secp256k1
)

var (
	oidSHA256WithRSA       = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 11}
	oidECPublicKey         = asn1.ObjectIdentifier{1, 2, 840, 10045, 2, 1}
	oidSecp256k1           = asn1.ObjectIdentifier{1, 3, 132, 0, 10}
	oidECDSAWithSHA256     = asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 2}
	oidExtBasicConstraints = asn1.ObjectIdentifier{2, 5, 29, 19}
	oidExtKeyUsage         = asn1.ObjectIdentifier{2, 5, 29, 15}
)

// Key is a minted key pair together with the certificate that carries it.
type Key struct {
	Algorithm Algorithm
	RSA       *rsa.PrivateKey
	Secp256k1 *secp256k1.PrivateKey
}

// DefaultRSABits is the modulus size NewKey mints, matching what the platform
// issues.
const DefaultRSABits = 2048

// NewKey generates a fresh key pair of the requested algorithm.
func NewKey(algorithm Algorithm) (*Key, error) {
	return NewKeyOfSize(algorithm, DefaultRSABits)
}

// NewKeyOfSize is NewKey with an explicit RSA modulus size, for the tests that
// need an undersized key. The size is ignored for secp256k1.
func NewKeyOfSize(algorithm Algorithm, rsaBits int) (*Key, error) {
	switch algorithm {
	case RSA:
		key, err := rsa.GenerateKey(rand.Reader, rsaBits)
		if err != nil {
			return nil, err
		}
		return &Key{Algorithm: RSA, RSA: key}, nil
	case Secp256k1:
		key, err := secp256k1.GeneratePrivateKey()
		if err != nil {
			return nil, err
		}
		return &Key{Algorithm: Secp256k1, Secp256k1: key}, nil
	default:
		return nil, fmt.Errorf("unknown algorithm %d", algorithm)
	}
}

// Cert is a minted certificate and the key that signs on its behalf.
type Cert struct {
	Key      *Key
	DER      []byte
	PEM      string
	Subject  pkix.Name
	Template Template
}

// Template describes a certificate to mint.
type Template struct {
	CommonName string
	NotBefore  time.Time
	NotAfter   time.Time
	// IsCA and MaxPathLen populate BasicConstraints. OmitBasicConstraints
	// leaves the extension out entirely, which is how an end-entity
	// certificate masquerading as an issuer is built.
	IsCA                 bool
	MaxPathLen           int // negative: no pathLenConstraint
	OmitBasicConstraints bool
	// KeyUsage populates the KeyUsage extension; zero omits it.
	KeyUsage x509.KeyUsage
	// IssuerOverride forges the issuer name instead of taking it from the
	// signing certificate.
	IssuerOverride *pkix.Name
}

// Issue mints a certificate for key, signed by issuer. A nil issuer makes it
// self-signed, i.e. a root.
func Issue(template Template, key *Key, issuer *Cert) (*Cert, error) {
	subject := pkix.Name{CommonName: template.CommonName}
	issuerName := subject
	signer := key
	if issuer != nil {
		issuerName = issuer.Subject
		signer = issuer.Key
	}
	if template.IssuerOverride != nil {
		issuerName = *template.IssuerOverride
	}

	subjectDER, err := marshalName(subject)
	if err != nil {
		return nil, err
	}
	issuerDER, err := marshalName(issuerName)
	if err != nil {
		return nil, err
	}
	spki, err := marshalPublicKey(key)
	if err != nil {
		return nil, err
	}
	extensions, err := marshalExtensions(template)
	if err != nil {
		return nil, err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 96))
	if err != nil {
		return nil, err
	}

	tbs := tbsCertificate{
		Version:            2, // v3
		SerialNumber:       serial,
		SignatureAlgorithm: signatureAlgorithm(signer.Algorithm),
		Issuer:             asn1.RawValue{FullBytes: issuerDER},
		Validity:           validity{NotBefore: template.NotBefore.UTC(), NotAfter: template.NotAfter.UTC()},
		Subject:            asn1.RawValue{FullBytes: subjectDER},
		PublicKey:          asn1.RawValue{FullBytes: spki},
		Extensions:         extensions,
	}
	tbsDER, err := asn1.Marshal(tbs)
	if err != nil {
		return nil, err
	}

	signature, err := signer.sign(tbsDER)
	if err != nil {
		return nil, err
	}
	certDER, err := asn1.Marshal(signedCertificate{
		TBSCertificate:     asn1.RawValue{FullBytes: tbsDER},
		SignatureAlgorithm: signatureAlgorithm(signer.Algorithm),
		SignatureValue:     asn1.BitString{Bytes: signature, BitLength: len(signature) * 8},
	})
	if err != nil {
		return nil, err
	}

	return &Cert{
		Key:      key,
		DER:      certDER,
		PEM:      string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})),
		Subject:  subject,
		Template: template,
	}, nil
}

// SignJWS produces a compact JWS over payload, signed by the certificate's key
// with the algorithm that key implies (RS256 or ES256K).
func (c *Cert) SignJWS(payload any) (string, error) {
	alg := "RS256"
	if c.Key.Algorithm == Secp256k1 {
		alg = "ES256K"
	}
	headerJSON, err := json.Marshal(map[string]string{"alg": alg, "typ": "JWT"})
	if err != nil {
		return "", err
	}
	payloadJSON, err := toJSON(payload)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(payloadJSON)

	signature, err := c.Key.signJWS([]byte(signingInput))
	if err != nil {
		return "", err
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

// Fingerprint returns the certificate's `sha256/<base64url>` fingerprint.
func (c *Cert) Fingerprint() string {
	sum := sha256.Sum256(c.DER)
	return "sha256/" + base64.RawURLEncoding.EncodeToString(sum[:])
}

func (k *Key) sign(tbs []byte) ([]byte, error) {
	sum := sha256.Sum256(tbs)
	switch k.Algorithm {
	case RSA:
		return rsa.SignPKCS1v15(rand.Reader, k.RSA, crypto.SHA256, sum[:])
	case Secp256k1:
		return secpecdsa.Sign(k.Secp256k1, sum[:]).Serialize(), nil
	default:
		return nil, fmt.Errorf("unknown algorithm %d", k.Algorithm)
	}
}

// signJWS signs the JWS signing input. ES256K uses the fixed-width r||s form
// RFC 7515 mandates, not the DER form used inside certificates.
func (k *Key) signJWS(signingInput []byte) ([]byte, error) {
	sum := sha256.Sum256(signingInput)
	switch k.Algorithm {
	case RSA:
		return rsa.SignPKCS1v15(rand.Reader, k.RSA, crypto.SHA256, sum[:])
	case Secp256k1:
		sig := secpecdsa.Sign(k.Secp256k1, sum[:])
		r, s := sig.R(), sig.S()
		rBytes, sBytes := r.Bytes(), s.Bytes()
		out := make([]byte, 0, 64)
		out = append(out, rBytes[:]...)
		out = append(out, sBytes[:]...)
		return out, nil
	default:
		return nil, fmt.Errorf("unknown algorithm %d", k.Algorithm)
	}
}

type tbsCertificate struct {
	Version            int `asn1:"optional,explicit,default:0,tag:0"`
	SerialNumber       *big.Int
	SignatureAlgorithm pkix.AlgorithmIdentifier
	Issuer             asn1.RawValue
	Validity           validity
	Subject            asn1.RawValue
	PublicKey          asn1.RawValue
	Extensions         []pkix.Extension `asn1:"optional,explicit,tag:3"`
}

type validity struct {
	NotBefore, NotAfter time.Time
}

type signedCertificate struct {
	TBSCertificate     asn1.RawValue
	SignatureAlgorithm pkix.AlgorithmIdentifier
	SignatureValue     asn1.BitString
}

type basicConstraints struct {
	IsCA       bool `asn1:"optional"`
	MaxPathLen int  `asn1:"optional,default:-1"`
}

func signatureAlgorithm(algorithm Algorithm) pkix.AlgorithmIdentifier {
	if algorithm == Secp256k1 {
		return pkix.AlgorithmIdentifier{Algorithm: oidECDSAWithSHA256}
	}
	return pkix.AlgorithmIdentifier{
		Algorithm:  oidSHA256WithRSA,
		Parameters: asn1.RawValue{Tag: asn1.TagNull},
	}
}

func marshalName(name pkix.Name) ([]byte, error) {
	rdns := name.ToRDNSequence()
	return asn1.Marshal(rdns)
}

func marshalPublicKey(key *Key) ([]byte, error) {
	switch key.Algorithm {
	case RSA:
		return x509.MarshalPKIXPublicKey(&key.RSA.PublicKey)
	case Secp256k1:
		point := key.Secp256k1.PubKey().SerializeUncompressed()
		curveParams, err := asn1.Marshal(oidSecp256k1)
		if err != nil {
			return nil, err
		}
		return asn1.Marshal(struct {
			Algorithm pkix.AlgorithmIdentifier
			PublicKey asn1.BitString
		}{
			Algorithm: pkix.AlgorithmIdentifier{
				Algorithm:  oidECPublicKey,
				Parameters: asn1.RawValue{FullBytes: curveParams},
			},
			PublicKey: asn1.BitString{Bytes: point, BitLength: len(point) * 8},
		})
	default:
		return nil, fmt.Errorf("unknown algorithm %d", key.Algorithm)
	}
}

func marshalExtensions(template Template) ([]pkix.Extension, error) {
	var extensions []pkix.Extension

	if !template.OmitBasicConstraints {
		bc := basicConstraints{IsCA: template.IsCA, MaxPathLen: -1}
		if template.MaxPathLen >= 0 {
			bc.MaxPathLen = template.MaxPathLen
		}
		value, err := asn1.Marshal(bc)
		if err != nil {
			return nil, err
		}
		extensions = append(extensions, pkix.Extension{Id: oidExtBasicConstraints, Critical: true, Value: value})
	}

	if template.KeyUsage != 0 {
		bits := asn1.BitString{Bytes: []byte{0, 0}, BitLength: 9}
		for i := uint(0); i < 9; i++ {
			if template.KeyUsage&(1<<i) != 0 {
				bits.Bytes[i/8] |= 0x80 >> (i % 8)
			}
		}
		trimBitString(&bits)
		value, err := asn1.Marshal(bits)
		if err != nil {
			return nil, err
		}
		extensions = append(extensions, pkix.Extension{Id: oidExtKeyUsage, Critical: true, Value: value})
	}

	return extensions, nil
}

// trimBitString drops trailing zero bits, as RFC 5280 requires for KeyUsage.
func trimBitString(bits *asn1.BitString) {
	for bits.BitLength > 1 && bits.At(bits.BitLength-1) == 0 {
		bits.BitLength--
	}
	bits.Bytes = bits.Bytes[:(bits.BitLength+7)/8]
}

func toJSON(value any) ([]byte, error) {
	if raw, ok := value.(json.RawMessage); ok {
		return raw, nil
	}
	return json.Marshal(value)
}
