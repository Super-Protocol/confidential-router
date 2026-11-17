package attestedroot

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"strings"
	"testing"
	"time"
)

// apps448Measurement is the launch measurement of the build-448 demo cloud
// (conf-apps.superprotocol.dev). It is signed in the registry's sev-snp-azure
// folder, which is how it is known to be the value the platform's own tooling
// derives — not merely the value this code happens to compute.
const apps448Measurement = "74c75a0ba5f36e55548a14aa0dae0d0c9de9cd6ad041a4f6c553c996e2c579a7"

// apps448Root is the real root CA of that cloud; see testdata/README.md.
func apps448Root(t *testing.T) *x509.Certificate {
	t.Helper()
	raw, err := os.ReadFile("testdata/apps-448-azure-sev-snp-root.pem")
	if err != nil {
		t.Fatalf("reading the Azure root fixture: %v", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		t.Fatal("the Azure root fixture is not PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parsing the Azure root fixture: %v", err)
	}
	return cert
}

// apps448Clock is when the fixture was captured; every certificate in it is
// valid then.
func apps448Clock() time.Time { return time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC) }

// TestVerifyRealAzureSevSnpRoot drives the whole pipeline over the root that
// SUP-251 was filed about: a build-448 Azure SEV-SNP cloud whose evidence the
// gatekeeper used to reject as carrying "no recognised evidence branch".
//
// Unlike the QEMU fixture this is the CA certificate itself, so every step is
// real and the verdict is an admission: the AMD chain, the Microsoft vTPM
// chain, the TPM quote, the event-log replay, and the binding of the HCL
// user-data to this certificate's key.
func TestVerifyRealAzureSevSnpRoot(t *testing.T) {
	registry := &stubRegistry{}
	verifier := &Verifier{Registry: registry, Now: apps448Clock, CacheTTL: -1}

	result, err := verifier.Verify(context.Background(), apps448Root(t))
	if err != nil {
		t.Fatalf("Verify returned an error: %v", err)
	}
	if !result.Attested {
		t.Fatalf("attested = false: %s", result.Reason)
	}
	if got, want := result.EvidenceTypeName, "AMD SEV-SNP (Azure)"; got != want {
		t.Errorf("evidence type = %q, want %q", got, want)
	}
	if !result.ReportIntegrity || !result.KeyBinding {
		t.Errorf("integrity = %v, key binding = %v; want both", result.ReportIntegrity, result.KeyBinding)
	}
	if got := result.MeasurementHex(); got != apps448Measurement {
		t.Errorf("measurement = %s, want %s", got, apps448Measurement)
	}
	if got, want := result.CPUGeneration, "Genoa"; got != want {
		t.Errorf("CPU generation = %q, want %q", got, want)
	}
	if got, want := result.NetworkType, NetworkTrusted; got != want {
		t.Errorf("network type = %q, want %q", got, want)
	}
	if result.SecurityFields.DebugAllowed {
		t.Error("debug allowed = true for a production root")
	}
	if registry.folder != EvidenceSevSnpAzure {
		t.Errorf("registry asked under %v, want the Azure SEV-SNP folders", registry.folder)
	}
}

// TestVerifyAzureRootListedByOperator is the trust-list path: the registry
// knows nothing of the image, and the operator's list admits it.
func TestVerifyAzureRootListedByOperator(t *testing.T) {
	verifier := &Verifier{
		Registry:            &stubRegistry{err: ErrNotInRegistry},
		TrustedMeasurements: []string{apps448Measurement},
		Now:                 apps448Clock,
		CacheTTL:            -1,
	}
	result, err := verifier.Verify(context.Background(), apps448Root(t))
	if err != nil {
		t.Fatal(err)
	}
	if !result.Attested || result.MeasurementSource != SourceOperatorPinned {
		t.Errorf("attested = %v via %q (%s), want admission by the operator's list",
			result.Attested, result.MeasurementSource, result.Reason)
	}
}

// TestVerifyAzureRootRejectsTamperedEvidence re-issues the real evidence under
// a key it was never bound to, and with one byte of the vTPM signature
// flipped. Both must deny, and neither may report a measurement — a value
// derived from evidence that did not verify is not one an admin should be
// shown to copy into the trust list.
func TestVerifyAzureRootRejectsTamperedEvidence(t *testing.T) {
	genuine, err := ReadRootExtensions(apps448Root(t))
	if err != nil {
		t.Fatal(err)
	}

	t.Run("bound to another key", func(t *testing.T) {
		cert := newRootCert(t, rootCertOptions{challengeType: "sev-snp-azure", evidence: genuine.Evidence})
		result := mustVerify(t, cert)
		if result.Attested || result.KeyBinding {
			t.Fatalf("attested = %v, key binding = %v for a certificate the evidence was not issued for",
				result.Attested, result.KeyBinding)
		}
		if !result.ReportIntegrity {
			t.Errorf("integrity = false, want the untouched hardware report to verify (%s)", result.Reason)
		}
		if !strings.Contains(result.Reason, "user-data") {
			t.Errorf("reason = %q, want it to name the user-data binding", result.Reason)
		}
		if result.MeasurementHex() != "" {
			t.Errorf("measurement %s reported for an unbound root", result.MeasurementHex())
		}
	})

	t.Run("vTPM signature flipped", func(t *testing.T) {
		parsed, err := ParseEvidence(genuine.Evidence)
		if err != nil {
			t.Fatal(err)
		}
		signature := append([]byte{}, parsed.Azure.TPMSignature...)
		signature[len(signature)-1] ^= 0xff
		tampered := field(int(EvidenceSevSnpAzure), azureMessage(parsed.Azure, signature))

		cert := newRootCert(t, rootCertOptions{challengeType: "sev-snp-azure", evidence: tampered})
		result := mustVerify(t, cert)
		if result.Attested || result.MeasurementHex() != "" {
			t.Fatalf("attested = %v, measurement %q after the vTPM signature was broken",
				result.Attested, result.MeasurementHex())
		}
		if !strings.Contains(result.Reason, "azure SEV-SNP evidence") {
			t.Errorf("reason = %q, want it to name the Azure evidence", result.Reason)
		}
	})
}

// TestVerifyAzureTdxEvidence covers the other Azure family, from the TDX
// capture of sp-nodejs-addons' azurecvm suite (a Standard_DC2es_v6 VM). No TDX
// root certificate has been published, so the evidence is re-issued under a
// synthetic one: the TD quote and the vTPM layer verify for real, and the
// verdict is the key-binding denial, exactly like the QEMU SEV-SNP fixture.
// The measurement formula itself is pinned by the azurecvm suite.
func TestVerifyAzureTdxEvidence(t *testing.T) {
	raw, err := os.ReadFile("internal/azurecvm/testdata/tdx-evidence.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		HCLReport    string   `json:"hclReport"`
		Quote        string   `json:"quote"`
		TPMAttest    string   `json:"tpmAttest"`
		TPMSignature string   `json:"tpmSignature"`
		EventLog     string   `json:"eventLog"`
		AKCertChain  []string `json:"akCertChain"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	decode := func(s string) []byte {
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	ev := &AzureEvidence{
		HCLReport:    decode(fixture.HCLReport),
		Quote:        decode(fixture.Quote),
		TPMAttest:    decode(fixture.TPMAttest),
		TPMSignature: decode(fixture.TPMSignature),
		EventLog:     decode(fixture.EventLog),
	}
	for _, c := range fixture.AKCertChain {
		ev.AKCertChain = append(ev.AKCertChain, decode(c))
	}
	evidence := field(int(EvidenceTdxAzure), azureMessage(ev, ev.TPMSignature))

	parsed, err := ParseEvidence(evidence)
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}
	if parsed.Type != EvidenceTdxAzure || parsed.Azure == nil || len(parsed.Azure.Quote) == 0 {
		t.Fatalf("parsed as %v with quote %d bytes, want Intel TDX (Azure) with its quote", parsed.Type,
			len(parsed.Azure.Quote))
	}

	cert := newRootCert(t, rootCertOptions{challengeType: "tdx-azure", evidence: evidence})
	verifier := &Verifier{
		Registry: &stubRegistry{},
		Now:      func() time.Time { return time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC) },
		CacheTTL: -1,
	}
	result, err := verifier.Verify(context.Background(), cert)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := result.EvidenceTypeName, "Intel TDX (Azure)"; got != want {
		t.Errorf("evidence type = %q, want %q", got, want)
	}
	if !result.ReportIntegrity {
		t.Errorf("integrity = false, want the real TD quote to verify (%s)", result.Reason)
	}
	if result.Attested || result.KeyBinding || !strings.Contains(result.Reason, "user-data") {
		t.Errorf("attested = %v, key binding = %v, reason %q; want the key-binding denial",
			result.Attested, result.KeyBinding, result.Reason)
	}
}

func mustVerify(t *testing.T, cert *x509.Certificate) *Result {
	t.Helper()
	verifier := &Verifier{Registry: &stubRegistry{}, Now: apps448Clock, CacheTTL: -1}
	result, err := verifier.Verify(context.Background(), cert)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// azureMessage re-encodes an Azure branch with the given TPM signature, in the
// field order IntelTDXAzureEvidence and AmdSevSnpAzureEvidence share.
func azureMessage(ev *AzureEvidence, tpmSignature []byte) []byte {
	out := field(1, ev.HCLReport)
	if len(ev.Quote) > 0 {
		out = concat(out, field(2, ev.Quote))
	}
	for role, der := range ev.Certs {
		out = concat(out, field(2, concat(varintField(1, uint64(role)), field(2, der))))
	}
	out = concat(out, field(3, ev.TPMAttest), field(4, tpmSignature), field(5, ev.EventLog))
	for _, cert := range ev.AKCertChain {
		out = concat(out, field(6, cert))
	}
	return out
}
