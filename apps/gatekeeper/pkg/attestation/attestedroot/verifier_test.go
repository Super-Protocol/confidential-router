package attestedroot

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"math/big"
	"strings"
	"testing"
	"time"
)

// rootCertOptions describes a synthetic root certificate for a test.
type rootCertOptions struct {
	challengeType string
	networkType   string
	evidence      []byte
	// omitNetworkType leaves the extension off entirely, as roots issued
	// before it existed do.
	omitNetworkType bool
}

// newRootCert builds a self-signed CA certificate carrying the platform's
// attestation extensions.
func newRootCert(t *testing.T, opts rootCertOptions) *x509.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	extensions := []pkix.Extension{
		{Id: oidChallengeType, Value: []byte(opts.challengeType)},
	}
	if !opts.omitNetworkType {
		network := opts.networkType
		if network == "" {
			network = string(NetworkUntrusted)
		}
		extensions = append(extensions, pkix.Extension{Id: oidNetworkType, Value: []byte(network)})
	}
	if opts.evidence != nil {
		extensions = append(extensions, pkix.Extension{Id: oidTeeEvidence, Value: opts.evidence})
	}

	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Super Swarm Root CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
		ExtraExtensions:       extensions,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert
}

// TestVerifyRealSwarmRootEvidence drives the whole pipeline over the real
// hardware evidence of a Super Swarm Root CA.
//
// The verdict is a denial, and deliberately so: the CA certificate that report
// was issued for is not published, so the fixture root's key is not the one the
// report commits to. That is exactly the check the whole design rests on — a
// valid report from some Super Protocol VM must not vouch for a certificate it
// was not bound to — and everything before it is real: the AMD chain, the
// report signature, the TCB binding, the CPU line and the policy fields.
func TestVerifyRealSwarmRootEvidence(t *testing.T) {
	cert := newRootCert(t, rootCertOptions{
		challengeType: "sev-snp",
		networkType:   string(NetworkUntrusted),
		evidence:      swarmRootEvidence(t),
	})

	registry := &stubRegistry{}
	verifier := &Verifier{
		Registry:  registry,
		Artifacts: fixedArtifacts{build: "build-350", artifacts: build350(t)},
		// The AMD chain in the fixture was valid when it was captured; pin the
		// clock so the test does not start failing when those certificates age
		// out.
		Now:      func() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) },
		CacheTTL: -1,
	}

	result, err := verifier.Verify(context.Background(), cert)
	if err != nil {
		t.Fatalf("Verify returned an error: %v", err)
	}

	if !result.ReportIntegrity {
		t.Errorf("report integrity = false, want the real AMD chain to verify (%s)", result.Reason)
	}
	if got, want := result.EvidenceTypeName, "AMD SEV-SNP (QEMU)"; got != want {
		t.Errorf("evidence type = %q, want %q", got, want)
	}
	if got, want := result.CPUGeneration, "Genoa"; got != want {
		t.Errorf("CPU generation = %q, want %q", got, want)
	}
	if got, want := result.NetworkType, NetworkUntrusted; got != want {
		t.Errorf("network type = %q, want %q", got, want)
	}
	want := SecurityFields{VMPL: 0, SnpFirmwareTCB: 27, ReportVersion: 5}
	if result.SecurityFields != want {
		t.Errorf("security fields = %+v, want %+v", result.SecurityFields, want)
	}

	if result.KeyBinding {
		t.Error("key binding = true, but the fixture certificate is not the one the report was issued for")
	}
	if result.Attested {
		t.Error("attested = true for a root whose key the report does not commit to")
	}
	if !strings.Contains(result.Reason, "reportData") {
		t.Errorf("reason = %q, want it to name the reportData binding", result.Reason)
	}
	if len(registry.asked) != 0 {
		t.Error("the registry was consulted for a root that failed the key binding")
	}
}

// TestVerifyRejectsRootsWithoutEvidence covers the ordinary case: a root that
// is simply not a TEE-attested one. It must deny with an explanation rather
// than an error, because the caller renders it next to the manual verdict.
func TestVerifyRejectsRootsWithoutEvidence(t *testing.T) {
	for _, tc := range []struct {
		name string
		cert *x509.Certificate
		want string
	}{
		{
			name: "no extensions at all",
			cert: newRootCert(t, rootCertOptions{omitNetworkType: true}),
			want: "carries no TEE evidence extension",
		},
		{
			name: "an unparseable evidence blob",
			cert: newRootCert(t, rootCertOptions{challengeType: "sev-snp", evidence: []byte{0xff, 0xff, 0xff}}),
			want: "tee evidence",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			verifier := &Verifier{Registry: &stubRegistry{}, CacheTTL: -1}
			result, err := verifier.Verify(context.Background(), tc.cert)
			if err != nil {
				t.Fatalf("Verify returned an error: %v", err)
			}
			if result.Attested {
				t.Fatal("attested = true")
			}
			if !strings.Contains(result.Reason, tc.want) {
				t.Errorf("reason = %q, want it to contain %q", result.Reason, tc.want)
			}
		})
	}
}

// TestVerifyRejectsATamperedReport shows that the hardware check is doing work:
// flip a byte of the signed report and the AMD chain no longer covers it.
func TestVerifyRejectsATamperedReport(t *testing.T) {
	evidence := swarmRootEvidence(t)
	tampered := make([]byte, len(evidence))
	copy(tampered, evidence)
	// MEASUREMENT sits at 0x90 of the report, inside the region the AMD key
	// signs. The report is located by searching for it rather than by a
	// hard-coded offset, so the test keeps working if the envelope changes.
	parsed, err := ParseEvidence(evidence)
	if err != nil {
		t.Fatal(err)
	}
	offset := indexOf(tampered, parsed.SevSnp.RawReport)
	if offset < 0 {
		t.Fatal("could not locate the raw report inside the serialised evidence")
	}
	tampered[offset+0x90] ^= 0xff

	cert := newRootCert(t, rootCertOptions{challengeType: "sev-snp", evidence: tampered})
	verifier := &Verifier{
		Registry:  &stubRegistry{},
		Artifacts: fixedArtifacts{build: "build-350", artifacts: build350(t)},
		Now:       func() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) },
		CacheTTL:  -1,
	}

	result, err := verifier.Verify(context.Background(), cert)
	if err != nil {
		t.Fatalf("Verify returned an error: %v", err)
	}
	if result.Attested || result.ReportIntegrity {
		t.Fatalf("a tampered report verified: %+v", result)
	}
	if !strings.Contains(result.Reason, "attestation report") {
		t.Errorf("reason = %q, want it to name the attestation report", result.Reason)
	}
}

// TestVerifyCachesVerdicts keeps re-attestation from re-downloading a firmware
// image every few minutes.
func TestVerifyCachesVerdicts(t *testing.T) {
	cert := newRootCert(t, rootCertOptions{challengeType: "sev-snp", evidence: []byte{0xff}})
	verifier := &Verifier{Registry: &stubRegistry{}, Now: func() time.Time { return time.Unix(0, 0) }}

	first, err := verifier.Verify(context.Background(), cert)
	if err != nil {
		t.Fatal(err)
	}
	second, err := verifier.Verify(context.Background(), cert)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Error("a second Verify of the same certificate re-ran the check instead of reusing the verdict")
	}
}

// TestBindsPublicKey covers the check on its own, in both directions.
func TestBindsPublicKey(t *testing.T) {
	var digest [32]byte
	for i := range digest {
		digest[i] = byte(i)
	}
	reportData := make([]byte, 64)
	copy(reportData, digest[:])

	if !BindsPublicKey(reportData, digest) {
		t.Error("a reportData that begins with the digest was rejected")
	}
	reportData[31] ^= 1
	if BindsPublicKey(reportData, digest) {
		t.Error("a reportData that differs in its last digest byte was accepted")
	}
	if BindsPublicKey(digest[:31], digest) {
		t.Error("a truncated reportData was accepted")
	}
}

// TestReadRootExtensions checks how the certificate's own claims are read,
// including the spelling variants generators produce.
func TestReadRootExtensions(t *testing.T) {
	t.Run("bare ASCII values", func(t *testing.T) {
		cert := newRootCert(t, rootCertOptions{challengeType: "sev-snp", networkType: "trusted"})
		ext, err := ReadRootExtensions(cert)
		if err != nil {
			t.Fatal(err)
		}
		if ext.ChallengeType != "sev-snp" || ext.NetworkType != NetworkTrusted {
			t.Errorf("read %+v", ext)
		}
		if ext.HasEvidence() {
			t.Error("HasEvidence = true for a certificate with no evidence extension")
		}
	})

	t.Run("a DER-wrapped network type", func(t *testing.T) {
		wrapped, err := asn1.Marshal([]byte("untrusted"))
		if err != nil {
			t.Fatal(err)
		}
		cert := newRootCert(t, rootCertOptions{challengeType: "sev-snp", omitNetworkType: true})
		cert.Extensions = append(cert.Extensions, pkix.Extension{Id: oidNetworkType, Value: wrapped})
		ext, err := ReadRootExtensions(cert)
		if err != nil {
			t.Fatal(err)
		}
		if ext.NetworkType != NetworkUntrusted {
			t.Errorf("network type = %q, want %q", ext.NetworkType, NetworkUntrusted)
		}
	})

	t.Run("an unrecognised network type", func(t *testing.T) {
		cert := newRootCert(t, rootCertOptions{challengeType: "sev-snp", networkType: "semi-trusted"})
		if _, err := ReadRootExtensions(cert); err == nil {
			t.Fatal("an unrecognised network type was accepted")
		}
	})
}

// TestVerifyRejectsNoCertificate is the one case that is a caller mistake
// rather than a verdict.
func TestVerifyRejectsNoCertificate(t *testing.T) {
	verifier := &Verifier{}
	if _, err := verifier.Verify(context.Background(), nil); err == nil {
		t.Fatal("Verify accepted a nil certificate")
	}
}

func indexOf(haystack, needle []byte) int {
	return strings.Index(string(haystack), string(needle))
}
