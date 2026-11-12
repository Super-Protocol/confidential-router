package azurecvm

import "encoding/binary"

// SEV-SNP attestation report offsets (AMD SEV-SNP ABI, ATTESTATION_REPORT).
const (
	snpVersionOffset     = 0x00
	snpPolicyOffset      = 0x08
	snpVMPLOffset        = 0x30
	snpMeasurementOffset = 0x90
	snpMeasurementSize   = 48
	snpReportedTCBOffset = 0x180
	snpTCBSize           = 8
	snpPolicyDebug       = 1 << 19
)

// SNPFields are policy-relevant values of the SEV-SNP report embedded in the
// HCL report. They are authenticated only once the caller has verified the
// report signature (VCEK → ASK → ARK).
type SNPFields struct {
	// Report is the raw attestation report, for the caller's signature check.
	Report  []byte
	Version uint32
	// Measurement is the launch digest of the Microsoft paravisor; like MRTD
	// on TDX it changes when Microsoft updates the paravisor.
	Measurement []byte
	Policy      uint64
	// DebugAllowed is the guest policy DEBUG bit. A debuggable guest offers
	// no confidentiality: the host can read and modify its memory.
	DebugAllowed bool
	VMPL         uint32
	ReportedTCB  []byte
}

func snpFields(report []byte) *SNPFields {
	policy := binary.LittleEndian.Uint64(report[snpPolicyOffset:])
	return &SNPFields{
		Report:       append([]byte{}, report...),
		Version:      binary.LittleEndian.Uint32(report[snpVersionOffset:]),
		Measurement:  append([]byte{}, report[snpMeasurementOffset:snpMeasurementOffset+snpMeasurementSize]...),
		Policy:       policy,
		DebugAllowed: policy&snpPolicyDebug != 0,
		VMPL:         binary.LittleEndian.Uint32(report[snpVMPLOffset:]),
		ReportedTCB:  append([]byte{}, report[snpReportedTCBOffset:snpReportedTCBOffset+snpTCBSize]...),
	}
}
