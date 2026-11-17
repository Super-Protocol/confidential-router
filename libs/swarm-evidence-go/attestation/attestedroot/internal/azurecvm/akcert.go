package azurecvm

import (
	"crypto/rsa"
	"crypto/x509"
	_ "embed"
	"encoding/asn1"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// Microsoft root of the Azure vTPM PKI. It certifies the attestation key of
// every Azure confidential VM vTPM; the AK certificate chain must end here.
//
//go:embed azure-vtpm-root-ca-2023.pem
var azureVTPMRootPEM []byte

const akCertSubjectSuffix = ".ConfidentialVM.Azure.windows.net"

// tcg-kp-AIKCertificate: the key is a TPM attestation identity key.
var oidTCGKpAIKCertificate = asn1.ObjectIdentifier{2, 23, 133, 8, 3}

var azureVTPMRoots = mustLoadRoots(azureVTPMRootPEM)

func mustLoadRoots(pemBytes []byte) *x509.CertPool {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		panic("azurecvm: embedded Azure vTPM root is not PEM")
	}
	root, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		panic(fmt.Sprintf("azurecvm: embedded Azure vTPM root is invalid: %v", err))
	}
	pool := x509.NewCertPool()
	pool.AddCert(root)
	return pool
}

// verifyAKCertChain verifies the AK certificate chain against the pinned
// Microsoft root at the moment the AK certificate was issued, so evidence stays
// verifiable after the one-year AK certificate expires. Whether the chain is
// valid today is reported separately.
func verifyAKCertChain(chain [][]byte, now time.Time) (*x509.Certificate, AKCertificate, error) {
	if len(chain) == 0 {
		return nil, AKCertificate{}, fmt.Errorf("AK certificate chain is empty")
	}

	certs := make([]*x509.Certificate, 0, len(chain))
	for index, der := range chain {
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, AKCertificate{}, fmt.Errorf("AK certificate chain entry %d is invalid: %w", index, err)
		}
		certs = append(certs, cert)
	}
	leaf := certs[0]
	intermediates := x509.NewCertPool()
	for _, cert := range certs[1:] {
		intermediates.AddCert(cert)
	}

	options := func(at time.Time) x509.VerifyOptions {
		return x509.VerifyOptions{
			Roots:         azureVTPMRoots,
			Intermediates: intermediates,
			CurrentTime:   at,
			// The AK certificate carries only TCG and Microsoft EKUs, which
			// crypto/x509 does not know; the AIK EKU is checked below.
			KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
		}
	}
	if _, err := leaf.Verify(options(leaf.NotBefore)); err != nil {
		return nil, AKCertificate{}, fmt.Errorf("AK certificate does not chain to the Azure vTPM root: %w", err)
	}
	_, errNow := leaf.Verify(options(now))

	if !hasUnknownExtKeyUsage(leaf, oidTCGKpAIKCertificate) {
		return nil, AKCertificate{}, fmt.Errorf("AK certificate lacks the tcg-kp-AIKCertificate extended key usage")
	}
	if !strings.HasSuffix(leaf.Subject.CommonName, akCertSubjectSuffix) {
		return nil, AKCertificate{}, fmt.Errorf("AK certificate subject %q is not an Azure confidential VM", leaf.Subject.CommonName)
	}

	return leaf, AKCertificate{
		Subject:   leaf.Subject.String(),
		Issuer:    leaf.Issuer.String(),
		NotBefore: leaf.NotBefore.UTC(),
		NotAfter:  leaf.NotAfter.UTC(),
		ValidNow:  errNow == nil,
	}, nil
}

func hasUnknownExtKeyUsage(cert *x509.Certificate, oid asn1.ObjectIdentifier) bool {
	for _, usage := range cert.UnknownExtKeyUsage {
		if usage.Equal(oid) {
			return true
		}
	}
	return false
}

// matchAKPublicKey checks that the certified AK is the one the HCL runtime data
// (and therefore the TD quote) vouches for.
func matchAKPublicKey(leaf *x509.Certificate, key jwk) (*rsa.PublicKey, error) {
	certKey, ok := leaf.PublicKey.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("AK certificate key is not RSA")
	}
	if key.Kty != "RSA" {
		return nil, fmt.Errorf("HCLAkPub key type is %q, expected RSA", key.Kty)
	}
	n, err := base64.RawURLEncoding.DecodeString(key.N)
	if err != nil {
		return nil, fmt.Errorf("HCLAkPub modulus is not base64url: %w", err)
	}
	e, err := base64.RawURLEncoding.DecodeString(key.E)
	if err != nil {
		return nil, fmt.Errorf("HCLAkPub exponent is not base64url: %w", err)
	}
	if certKey.N.Cmp(new(big.Int).SetBytes(n)) != 0 || big.NewInt(int64(certKey.E)).Cmp(new(big.Int).SetBytes(e)) != 0 {
		return nil, fmt.Errorf("AK certificate key does not match HCLAkPub")
	}
	return certKey, nil
}
