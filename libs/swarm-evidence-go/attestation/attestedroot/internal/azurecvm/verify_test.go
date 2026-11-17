package azurecvm

import (
	"bytes"
	"compress/gzip"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"
)

// The fixtures were captured on Azure CVMs running build-442-debug:
// tdx-* on a Standard_DC2es_v6 TDX VM, snp-* on a Standard_DC2as_v5 SEV-SNP
// (Milan) VM. *-binary_bios_measurements.gz is the full firmware log of the
// same boot. The expected values were computed independently.
type platformFixture struct {
	platform  Platform
	evidence  string
	fullLog   string
	mrEnclave string
	flags     string
}

var fixtures = []platformFixture{
	{PlatformTDX, "tdx-evidence.json", "tdx-binary_bios_measurements.gz",
		"67709280b96bb58032be48b127ec7b44e539deddb74ed1eb9b7255d7c10b3b25", "0001010100"},
	{PlatformSNP, "snp-evidence.json", "snp-binary_bios_measurements.gz",
		"e10f7dcb80890a8ef03289be17874737c1ee5d8441d15e296035c48428edbdf5", "000101"},
}

// The same image measures the same boot chain on both platforms.
const (
	expectedPcr4 = "3f0f714c88880decbc7570852a8473b520caa0495fbc58a4f014e05684fb6b78"
	expectedPcr9 = "237f1603b24a15a0e672220bff8f70902e990eba09ce9924385fadf327f2bfdb"
)

var fixtureTime = time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)

type fixtureFile struct {
	UserData     string   `json:"userData"`
	HCLReport    string   `json:"hclReport"`
	Quote        string   `json:"quote"`
	TPMAttest    string   `json:"tpmAttest"`
	TPMSignature string   `json:"tpmSignature"`
	EventLog     string   `json:"eventLog"`
	AKCertChain  []string `json:"akCertChain"`
}

func loadFixture(t *testing.T, fixture platformFixture) (Evidence, []byte) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + fixture.evidence)
	if err != nil {
		t.Fatal(err)
	}
	var f fixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	decode := func(s string) []byte {
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	evidence := Evidence{
		HCLReport:    decode(f.HCLReport),
		TPMAttest:    decode(f.TPMAttest),
		TPMSignature: decode(f.TPMSignature),
		EventLog:     decode(f.EventLog),
	}
	if f.Quote != "" {
		evidence.Quote = decode(f.Quote)
	}
	for _, cert := range f.AKCertChain {
		evidence.AKCertChain = append(evidence.AKCertChain, decode(cert))
	}
	return evidence, decode(f.UserData)
}

func forEachPlatform(t *testing.T, test func(t *testing.T, fixture platformFixture)) {
	for _, fixture := range fixtures {
		t.Run(fixture.platform.String(), func(t *testing.T) { test(t, fixture) })
	}
}

func TestVerifyFixture(t *testing.T) {
	forEachPlatform(t, func(t *testing.T, fixture platformFixture) {
		evidence, userData := loadFixture(t, fixture)

		result, err := Verify(evidence, fixture.platform, fixtureTime)
		if err != nil {
			t.Fatalf("Verify: %v", err)
		}
		if got := hex.EncodeToString(result.MrEnclave); got != fixture.mrEnclave {
			t.Errorf("mrEnclave = %s, want %s", got, fixture.mrEnclave)
		}
		if !bytes.Equal(result.ReportData, userData) {
			t.Errorf("reportData = %x, want %x", result.ReportData, userData)
		}
		if got := hex.EncodeToString(result.Pcr4); got != expectedPcr4 {
			t.Errorf("PCR4 = %s, want %s", got, expectedPcr4)
		}
		if got := hex.EncodeToString(result.Pcr9); got != expectedPcr9 {
			t.Errorf("PCR9 = %s, want %s", got, expectedPcr9)
		}
		if !result.AKCertificate.ValidNow {
			t.Errorf("AK certificate should be valid at %s", fixtureTime)
		}
		if !strings.HasSuffix(result.AKCertificate.Subject, akCertSubjectSuffix) {
			t.Errorf("AK subject = %q", result.AKCertificate.Subject)
		}
		config := result.VMConfiguration
		if config.SecureBoot || !config.TpmEnabled || !config.ConsoleEnabled {
			t.Errorf("unexpected VM configuration %+v", config)
		}

		switch fixture.platform {
		case PlatformTDX:
			if result.TDX == nil || result.SNP != nil {
				t.Fatalf("TDX result has TDX=%v SNP=%v", result.TDX, result.SNP)
			}
			if got := hex.EncodeToString(result.TDX.MrTd); !strings.HasPrefix(got, "a2e61f1316e9e367") {
				t.Errorf("mrTd = %s", got)
			}
			if result.TDX.TdDebug {
				t.Errorf("TdDebug = true, want false")
			}
			if config.InteractiveConsoleEnabled == nil || !*config.InteractiveConsoleEnabled {
				t.Errorf("interactiveConsoleEnabled = %v, want true", config.InteractiveConsoleEnabled)
			}
		case PlatformSNP:
			if result.SNP == nil || result.TDX != nil {
				t.Fatalf("SNP result has TDX=%v SNP=%v", result.TDX, result.SNP)
			}
			snp := result.SNP
			if snp.Version != 3 || snp.VMPL != 0 || snp.DebugAllowed || len(snp.Report) != snpReportSize {
				t.Errorf("unexpected SNP fields: version %d, VMPL %d, debug %v, report %d bytes", snp.Version, snp.VMPL, snp.DebugAllowed, len(snp.Report))
			}
			if got := hex.EncodeToString(snp.Measurement); !strings.HasPrefix(got, "11920f61def85094") {
				t.Errorf("measurement = %s", got)
			}
			if config.InteractiveConsoleEnabled != nil || config.FilteredVpciDevicesAllowed != nil {
				t.Errorf("SEV-SNP paravisor unexpectedly reported TDX-only flags: %+v", config)
			}
		}
	})
}

// The evidence type decides which platform signature the caller checks, so
// the HCL report must be of exactly that platform.
func TestVerifyRejectsOtherPlatform(t *testing.T) {
	tdx, _ := loadFixture(t, fixtures[0])
	snp, _ := loadFixture(t, fixtures[1])

	if _, err := Verify(tdx, PlatformSNP, fixtureTime); err == nil || !strings.Contains(err.Error(), "HCL report type") {
		t.Errorf("TDX evidence accepted as SEV-SNP: %v", err)
	}
	if _, err := Verify(snp, PlatformTDX, fixtureTime); err == nil || !strings.Contains(err.Error(), "HCL report type") {
		t.Errorf("SEV-SNP evidence accepted as TDX: %v", err)
	}
	snp.Quote = tdx.Quote
	if _, err := Verify(snp, PlatformSNP, fixtureTime); err == nil || !strings.Contains(err.Error(), "must not carry a TD quote") {
		t.Errorf("SEV-SNP evidence with a TD quote accepted: %v", err)
	}
}

func TestVerifyAfterAKCertificateExpiry(t *testing.T) {
	forEachPlatform(t, func(t *testing.T, fixture platformFixture) {
		evidence, _ := loadFixture(t, fixture)

		result, err := Verify(evidence, fixture.platform, time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC))
		if err != nil {
			t.Fatalf("expired AK certificate must still verify: %v", err)
		}
		if result.AKCertificate.ValidNow {
			t.Errorf("ValidNow = true after expiry")
		}
		if hex.EncodeToString(result.MrEnclave) != fixture.mrEnclave {
			t.Errorf("mrEnclave changed after expiry")
		}
	})
}

var digestSizes = map[uint16]int{0x4: 20, 0xb: 32, 0xc: 48, 0xd: 64}

// eventOffsets returns the offset of every TCG_PCR_EVENT2 record in the log.
func eventOffsets(t *testing.T, log []byte) []int {
	t.Helper()
	offset := 32 + int(binary.LittleEndian.Uint32(log[28:32]))
	var offsets []int
	for offset < len(log) {
		offsets = append(offsets, offset)
		count := int(binary.LittleEndian.Uint32(log[offset+8:]))
		pos := offset + 12
		for i := 0; i < count; i++ {
			pos += 2 + digestSizes[binary.LittleEndian.Uint16(log[pos:])]
		}
		pos += 4 + int(binary.LittleEndian.Uint32(log[pos:]))
		offset = pos
	}
	return offsets
}

// sha256DigestOffset returns where the SHA-256 digest of an event starts.
func sha256DigestOffset(log []byte, event int) int {
	count := int(binary.LittleEndian.Uint32(log[event+8:]))
	pos := event + 12
	for i := 0; i < count; i++ {
		alg := binary.LittleEndian.Uint16(log[pos:])
		if alg == tpmAlgSHA256 {
			return pos + 2
		}
		pos += 2 + digestSizes[alg]
	}
	return -1
}

func clone(b []byte) []byte { return append([]byte{}, b...) }

type tamperCase struct {
	name   string
	mutate func(e *Evidence)
	want   string
}

func TestVerifyRejectsTampering(t *testing.T) {
	forEachPlatform(t, func(t *testing.T, fixture platformFixture) {
		base, _ := loadFixture(t, fixture)
		events := eventOffsets(t, base.EventLog)
		// PCR4: EFI_ACTION, SEPARATOR, bootloader, kernel; PCR9: command line.
		kernel := events[3]

		tests := []tamperCase{
			{"kernel digest", func(e *Evidence) {
				e.EventLog = clone(e.EventLog)
				e.EventLog[sha256DigestOffset(e.EventLog, kernel)] ^= 1
			}, "event log replay"},
			{"dropped event", func(e *Evidence) {
				e.EventLog = append(clone(e.EventLog[:kernel]), e.EventLog[events[4]:]...)
			}, "event log replay"},
			{"event for another PCR", func(e *Evidence) {
				e.EventLog = clone(e.EventLog)
				binary.LittleEndian.PutUint32(e.EventLog[kernel:], 7)
			}, "only PCRs"},
			{"HCL runtime data", func(e *Evidence) {
				e.HCLReport = clone(e.HCLReport)
				e.HCLReport[runtimeDataOffset+100] ^= 1
			}, "report_data does not match"},
			{"hardware report_data", func(e *Evidence) {
				e.HCLReport = clone(e.HCLReport)
				e.HCLReport[hclHeaderSize+fixture.platform.reportDataOffset()] ^= 1
			}, "report_data does not match"},
			{"TPM quote", func(e *Evidence) {
				e.TPMAttest = clone(e.TPMAttest)
				e.TPMAttest[len(e.TPMAttest)-1] ^= 1
			}, "signature is invalid"},
			{"TPM signature", func(e *Evidence) {
				e.TPMSignature = clone(e.TPMSignature)
				e.TPMSignature[len(e.TPMSignature)-1] ^= 1
			}, "signature is invalid"},
			{"AK chain without intermediates", func(e *Evidence) {
				e.AKCertChain = e.AKCertChain[:1]
			}, "does not chain"},
			{"intermediate as AK", func(e *Evidence) {
				e.AKCertChain = e.AKCertChain[1:]
			}, ""},
			{"self-issued AK", func(e *Evidence) {
				e.AKCertChain = [][]byte{selfSignedAK(t)}
			}, "does not chain"},
		}
		if fixture.platform == PlatformTDX {
			tests = append(tests,
				tamperCase{"quote MRTD", func(e *Evidence) {
					e.Quote = clone(e.Quote)
					e.Quote[quoteHeaderSize+136] ^= 1
				}, "mrtd does not match"},
				tamperCase{"quote report_data", func(e *Evidence) {
					e.Quote = clone(e.Quote)
					e.Quote[quoteHeaderSize+520] ^= 1
				}, "report_data does not match"},
			)
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				evidence := base
				tt.mutate(&evidence)
				_, err := Verify(evidence, fixture.platform, fixtureTime)
				if err == nil {
					t.Fatal("Verify accepted tampered evidence")
				}
				if !strings.Contains(err.Error(), tt.want) {
					t.Fatalf("error %q does not mention %q", err, tt.want)
				}
			})
		}
	})
}

// Relabelling a measured event as informational must not drop it from
// mrEnclave: only events whose digest is the hash of their data are skipped.
func TestRelabelledEventStaysInMrEnclave(t *testing.T) {
	forEachPlatform(t, func(t *testing.T, fixture platformFixture) {
		evidence, _ := loadFixture(t, fixture)
		events := eventOffsets(t, evidence.EventLog)
		for _, eventType := range []uint32{evEFIAction, evSeparator} {
			evidence.EventLog = clone(evidence.EventLog)
			binary.LittleEndian.PutUint32(evidence.EventLog[events[3]+4:], eventType)

			result, err := Verify(evidence, fixture.platform, fixtureTime)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if hex.EncodeToString(result.MrEnclave) != fixture.mrEnclave {
				t.Errorf("relabelling the kernel as %#x changed mrEnclave", eventType)
			}
		}
	})
}

func TestVMConfigFlagsRequireEveryKey(t *testing.T) {
	yes, no := true, false
	config := vmConfiguration{SecureBoot: &no, TpmEnabled: &yes, ConsoleEnabled: &yes, InteractiveConsoleEnabled: &yes, FilteredVpciDevicesAllowed: &no}
	for _, fixture := range fixtures {
		flags, err := config.vmConfigFlags(fixture.platform)
		if err != nil || hex.EncodeToString(flags) != fixture.flags {
			t.Fatalf("%s flags = %x, err = %v, want %s", fixture.platform, flags, err, fixture.flags)
		}
	}

	config.InteractiveConsoleEnabled = nil
	if _, err := config.vmConfigFlags(PlatformTDX); err == nil || !strings.Contains(err.Error(), "interactive-console-enabled") {
		t.Fatalf("missing TDX key accepted: %v", err)
	}
	if _, err := config.vmConfigFlags(PlatformSNP); err != nil {
		t.Fatalf("SEV-SNP must not need interactive-console-enabled: %v", err)
	}
	config.ConsoleEnabled = nil
	if _, err := config.vmConfigFlags(PlatformSNP); err == nil || !strings.Contains(err.Error(), "console-enabled") {
		t.Fatalf("missing SEV-SNP key accepted: %v", err)
	}
}

func TestVerifyTruncatedInputsDoNotPanic(t *testing.T) {
	forEachPlatform(t, func(t *testing.T, fixture platformFixture) {
		base, _ := loadFixture(t, fixture)
		fields := []func(e *Evidence) *[]byte{
			func(e *Evidence) *[]byte { return &e.HCLReport },
			func(e *Evidence) *[]byte { return &e.TPMAttest },
			func(e *Evidence) *[]byte { return &e.TPMSignature },
			func(e *Evidence) *[]byte { return &e.EventLog },
			func(e *Evidence) *[]byte { return &e.AKCertChain[0] },
		}
		if fixture.platform == PlatformTDX {
			fields = append(fields, func(e *Evidence) *[]byte { return &e.Quote })
		}
		for _, field := range fields {
			full := *field(&base)
			significant := len(full)
			switch field(&base) {
			case &base.HCLReport:
				// Bytes after the header's report size are NV padding.
				significant = int(binary.LittleEndian.Uint32(full[8:12]))
			case &base.Quote:
				// Only header and body are read here; the signature section is
				// verified by go-tdx-guest.
				significant = quoteHeaderSize + quoteBodySize
			}
			for size := 0; size < significant; size += 7 {
				evidence := base
				evidence.AKCertChain = append([][]byte{}, base.AKCertChain...)
				*field(&evidence) = full[:size]
				if _, err := Verify(evidence, fixture.platform, fixtureTime); err == nil {
					t.Fatalf("truncated field of %d/%d bytes was accepted", size, len(full))
				}
			}
		}
	})
}

func selfSignedAK(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:       big.NewInt(1),
		Subject:            pkix.Name{CommonName: "forged" + akCertSubjectSuffix},
		NotBefore:          fixtureTime.Add(-time.Hour),
		NotAfter:           fixtureTime.Add(time.Hour),
		UnknownExtKeyUsage: []asn1.ObjectIdentifier{oidTCGKpAIKCertificate},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestFilterEventLogKeepsQuotedPCRs(t *testing.T) {
	forEachPlatform(t, func(t *testing.T, fixture platformFixture) {
		evidence, _ := loadFixture(t, fixture)
		compressed, err := os.ReadFile("testdata/" + fixture.fullLog)
		if err != nil {
			t.Fatal(err)
		}
		reader, err := gzip.NewReader(bytes.NewReader(compressed))
		if err != nil {
			t.Fatal(err)
		}
		full, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}

		if _, err := parseEventLog(full); err == nil {
			t.Fatal("full firmware log must be rejected as evidence: it has events of other PCRs")
		}
		filtered, err := FilterEventLog(full)
		if err != nil {
			t.Fatalf("FilterEventLog: %v", err)
		}
		if !bytes.Equal(filtered, evidence.EventLog) {
			t.Fatalf("filtered log (%d bytes) differs from the evidence log (%d bytes)", len(filtered), len(evidence.EventLog))
		}
	})
}
