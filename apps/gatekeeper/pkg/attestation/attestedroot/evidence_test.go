package attestedroot

import (
	"encoding/hex"
	"testing"
)

// TestParseRealEvidence reads the fixture and checks the fields the rest of
// the pipeline depends on, so a wire-format mistake surfaces here rather than
// as an unexplained measurement mismatch three steps later.
func TestParseRealEvidence(t *testing.T) {
	evidence, err := ParseEvidence(swarmRootEvidence(t))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}
	if evidence.Type != EvidenceSevSnpQemu {
		t.Fatalf("type = %v, want AMD SEV-SNP (QEMU)", evidence.Type)
	}
	if evidence.SevSnp == nil {
		t.Fatal("the SEV-SNP branch is empty")
	}

	snp := evidence.SevSnp
	if got, want := len(snp.RawReport), 1184; got != want {
		t.Errorf("raw report is %d bytes, want %d", got, want)
	}
	if got, want := snp.Build, "build-350"; got != want {
		t.Errorf("build = %q, want %q", got, want)
	}
	if got, want := snp.Cores, 2; got != want {
		t.Errorf("cores = %d, want %d", got, want)
	}
	// 0x800f12 is CPUID's family 23, model 1, stepping 2 — the signature QEMU
	// leaves in RDX for its baseline EPYC model.
	if got, want := snp.CPUSig, uint32(0x800f12); got != want {
		t.Errorf("cpuSig = %#x, want %#x", got, want)
	}
	if got, want := len(snp.CmdLineHash), 32; got != want {
		t.Errorf("cmdLineHash is %d bytes, want %d", got, want)
	}
	for _, role := range []SevSnpCertType{CertARK, CertASK, CertVCEK} {
		if len(snp.Certs[role]) == 0 {
			t.Errorf("the AMD chain is missing the certificate for role %d", role)
		}
	}
}

// TestParseEvidenceRejectsMalformedInput covers the shapes a hostile or broken
// producer can serve.
func TestParseEvidenceRejectsMalformedInput(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input []byte
	}{
		{name: "empty", input: nil},
		{name: "a truncated length prefix", input: []byte{0x0a, 0x7f}},
		{name: "an unknown wire type", input: []byte{0x0b, 0x00}},
		{name: "no recognised branch", input: []byte{0x22, 0x00}},
		{name: "a SEV-SNP branch with no report", input: []byte{0x0a, 0x00}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseEvidence(tc.input); err == nil {
				t.Fatal("malformed evidence was accepted")
			}
		})
	}
}

// TestEvidenceTypeLabels keeps the labels aligned with the platform's own UI,
// and the registry folders with its layout.
func TestEvidenceTypeLabels(t *testing.T) {
	for _, tc := range []struct {
		evidence EvidenceType
		label    string
		folder   string
	}{
		{EvidenceSevSnpQemu, "AMD SEV-SNP (QEMU)", "sev-snp"},
		{EvidenceTdxQemu, "Intel TDX (QEMU)", "tdx"},
		{EvidenceTdxGCP, "Intel TDX (GCP)", "tdx"},
		{EvidenceUnspecified, "Unspecified", ""},
	} {
		if got := tc.evidence.String(); got != tc.label {
			t.Errorf("%d.String() = %q, want %q", tc.evidence, got, tc.label)
		}
		if got := tc.evidence.registryFolder(); got != tc.folder {
			t.Errorf("%d.registryFolder() = %q, want %q", tc.evidence, got, tc.folder)
		}
	}
}

// TestParseTdxEvidence builds a TDX message by hand and reads it back, since
// the platform has no published TDX root fixture to check against.
func TestParseTdxEvidence(t *testing.T) {
	digest := hex.EncodeToString(make([]byte, 48))
	entry := concat(
		field(1, []byte("EV_EFI_PLATFORM_FIRMWARE_BLOB2")),
		field(2, []byte(digest)),
	)
	inner := concat(field(1, []byte("a quote")), field(2, entry))

	for _, tc := range []struct {
		name  string
		field int
		want  EvidenceType
	}{
		{name: "QEMU", field: 2, want: EvidenceTdxQemu},
		{name: "GCP", field: 3, want: EvidenceTdxGCP},
	} {
		t.Run(tc.name, func(t *testing.T) {
			evidence, err := ParseEvidence(field(tc.field, inner))
			if err != nil {
				t.Fatalf("parsing: %v", err)
			}
			if evidence.Type != tc.want {
				t.Errorf("type = %v, want %v", evidence.Type, tc.want)
			}
			if len(evidence.Tdx.EventLog) != 1 ||
				evidence.Tdx.EventLog[0].Type != "EV_EFI_PLATFORM_FIRMWARE_BLOB2" {
				t.Errorf("event log = %+v", evidence.Tdx.EventLog)
			}
		})
	}
}

// field encodes one length-delimited protobuf field.
func field(number int, value []byte) []byte {
	out := appendVarint(nil, uint64(number)<<3|uint64(wireBytes))
	out = appendVarint(out, uint64(len(value)))
	return append(out, value...)
}

func appendVarint(dst []byte, v uint64) []byte {
	for v >= 0x80 {
		dst = append(dst, byte(v)|0x80)
		v >>= 7
	}
	return append(dst, byte(v))
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
