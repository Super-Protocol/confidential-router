package attestedroot

import (
	"encoding/hex"
	"strings"
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
	realEvidence := swarmRootEvidence(t)

	for _, tc := range []struct {
		name  string
		input []byte
	}{
		{name: "empty", input: nil},
		{name: "a truncated length prefix", input: []byte{0x0a, 0x7f}},
		{name: "an unknown wire type", input: []byte{0x0b, 0x00}},
		{name: "no recognised branch", input: []byte{0x22, 0x00}},
		{name: "a SEV-SNP branch with no report", input: []byte{0x0a, 0x00}},
		{
			// Which branch is present selects both the verifier and the
			// registry folder; two of them answer neither question.
			name:  "two hardware branches at once",
			input: concat(realEvidence, field(2, concat(field(1, []byte("a quote"))))),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseEvidence(tc.input); err == nil {
				t.Fatal("malformed evidence was accepted")
			}
		})
	}
}

// TestParseEvidenceBoundsProducerSuppliedNumbers is about work, not about
// parsing: `cores` sizes a per-vCPU hashing loop in the launch measurement and
// is the producer's word, so it has to be bounded before anything acts on it.
func TestParseEvidenceBoundsProducerSuppliedNumbers(t *testing.T) {
	// TeeEvidence.amdSevSnpQemu → SNPReport, with a report body long enough to
	// look real so the case that fails is the number and not the shape.
	report := func(fields ...[]byte) []byte {
		body := concat(append([][]byte{field(1, make([]byte, 1184))}, fields...)...)
		return field(1, field(1, body))
	}

	for _, tc := range []struct {
		name  string
		input []byte
		want  string
	}{
		{name: "a vCPU count of zero", input: report(varintField(3, 0)), want: "cores is 0"},
		{
			name:  "a vCPU count past any real guest",
			input: report(varintField(3, 1<<40)),
			want:  "cores is 1099511627776",
		},
		{
			name:  "a CPU signature wider than the CPUID field",
			input: report(varintField(2, 1<<40)),
			want:  "does not fit in the 32-bit CPUID field",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseEvidence(tc.input)
			if err == nil {
				t.Fatal("an out-of-range value was accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v, want it to contain %q", err, tc.want)
			}
		})
	}

	// The real evidence's own values must still pass, or the bound is wrong.
	evidence, err := ParseEvidence(swarmRootEvidence(t))
	if err != nil {
		t.Fatalf("the bound rejected real evidence: %v", err)
	}
	if evidence.SevSnp.Cores > maxVCPUs {
		t.Errorf("the fixture claims %d cores, above the bound", evidence.SevSnp.Cores)
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

// varintField encodes one varint protobuf field.
func varintField(number int, value uint64) []byte {
	out := appendVarint(nil, uint64(number)<<3|uint64(wireVarint))
	return appendVarint(out, value)
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
