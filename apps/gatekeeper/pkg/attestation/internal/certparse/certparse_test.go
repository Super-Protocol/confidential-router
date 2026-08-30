package certparse_test

import (
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/certparse"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/testca"
)

func mint(t *testing.T, template testca.Template, algorithm testca.Algorithm, issuer *testca.Cert) *testca.Cert {
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

func caTemplate(cn string) testca.Template {
	return testca.Template{
		CommonName: cn,
		NotBefore:  time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:   time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC),
		IsCA:       true,
		MaxPathLen: -1,
		KeyUsage:   x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
}

func TestParsePEMReadsBothKeyAlgorithms(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		algorithm testca.Algorithm
		want      certparse.KeyAlgorithm
	}{
		"rsa":       {testca.RSA, certparse.KeyRSA},
		"secp256k1": {testca.Secp256k1, certparse.KeySecp256k1},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			cert := mint(t, caTemplate("Root "+name), tc.algorithm, nil)

			parsed, err := certparse.ParsePEM(cert.PEM)
			if err != nil {
				t.Fatalf("ParsePEM: %v", err)
			}
			if parsed.KeyAlgorithm != tc.want {
				t.Errorf("KeyAlgorithm = %v, want %v", parsed.KeyAlgorithm, tc.want)
			}
			if !parsed.IsCA || !parsed.BasicConstraintsPresent {
				t.Error("BasicConstraints.cA was not read back")
			}
			if !parsed.KeyUsagePresent || parsed.KeyUsage&x509.KeyUsageCertSign == 0 {
				t.Errorf("KeyUsage = %v, want keyCertSign asserted", parsed.KeyUsage)
			}
			if parsed.Subject != "CN=Root "+name {
				t.Errorf("Subject = %q", parsed.Subject)
			}
			if string(parsed.Raw) != string(cert.DER) {
				t.Error("Raw is not the input DER")
			}
			if len(parsed.RawTBS) == 0 || len(parsed.RawTBS) >= len(parsed.Raw) {
				t.Errorf("RawTBS length %d is implausible for a %d byte certificate", len(parsed.RawTBS), len(parsed.Raw))
			}
		})
	}
}

// TestParsePEMHandlesTheCurveCryptoX509Rejects is the reason this package
// exists: crypto/x509 refuses secp256k1 outright, so a chain that uses it could
// not be read at all through the standard parser.
func TestParsePEMHandlesTheCurveCryptoX509Rejects(t *testing.T) {
	t.Parallel()
	cert := mint(t, caTemplate("K256 Root"), testca.Secp256k1, nil)

	if _, err := x509.ParseCertificate(cert.DER); err == nil {
		t.Skip("this Go release parses secp256k1 certificates; the fallback is no longer load-bearing")
	}
	parsed, err := certparse.ParsePEM(cert.PEM)
	if err != nil {
		t.Fatalf("ParsePEM: %v", err)
	}
	if parsed.Secp256k1PublicKey == nil {
		t.Fatal("secp256k1 public key was not extracted")
	}
}

func TestParsePEMRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	cert := mint(t, caTemplate("Root"), testca.RSA, nil)

	cases := map[string]string{
		"empty":            "",
		"not PEM":          "hello",
		"wrong block type": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: cert.DER})),
		"two certificates": cert.PEM + cert.PEM,
		"garbage DER":      string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{0x30, 0x03, 0x02, 0x01, 0x01}})),
		"trailing bytes":   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: append(append([]byte{}, cert.DER...), 0x00)})),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := certparse.ParsePEM(input); err == nil {
				t.Fatalf("ParsePEM accepted %s", name)
			}
		})
	}
}

func TestCheckSignatureFromVerifiesRealChains(t *testing.T) {
	t.Parallel()
	for name, algorithm := range map[string]testca.Algorithm{"rsa": testca.RSA, "secp256k1": testca.Secp256k1} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			root := mint(t, caTemplate("Root"), algorithm, nil)
			intermediate := mint(t, caTemplate("Intermediate"), algorithm, root)

			parsedRoot, err := certparse.ParsePEM(root.PEM)
			if err != nil {
				t.Fatalf("parse root: %v", err)
			}
			parsedIntermediate, err := certparse.ParsePEM(intermediate.PEM)
			if err != nil {
				t.Fatalf("parse intermediate: %v", err)
			}

			if err := parsedIntermediate.CheckSignatureFrom(parsedRoot); err != nil {
				t.Errorf("intermediate should verify under the root: %v", err)
			}
			if err := parsedRoot.CheckSignatureFrom(parsedRoot); err != nil {
				t.Errorf("root self-signature should verify: %v", err)
			}
			if err := parsedRoot.CheckSignatureFrom(parsedIntermediate); err == nil {
				t.Error("the root verified under the wrong key")
			}
		})
	}
}

func TestCheckSignatureRejectsMismatchedAlgorithms(t *testing.T) {
	t.Parallel()
	rsaRoot := mint(t, caTemplate("RSA Root"), testca.RSA, nil)
	parsed, err := certparse.ParsePEM(rsaRoot.PEM)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	ecdsaWithSHA256 := asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 2}
	if err := parsed.CheckSignature(ecdsaWithSHA256, []byte("data"), []byte("sig")); err == nil {
		t.Error("an ECDSA signature algorithm was accepted against an RSA key")
	}

	// SHA-1 is not in the accepted set; nothing in the trust chain issues it.
	sha1WithRSA := asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 5}
	err = parsed.CheckSignature(sha1WithRSA, []byte("data"), []byte("sig"))
	if err == nil || !strings.Contains(err.Error(), "unsupported signature algorithm") {
		t.Errorf("err = %v, want SHA-1 to be refused as unsupported", err)
	}
}
