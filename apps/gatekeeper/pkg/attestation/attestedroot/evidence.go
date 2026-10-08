package attestedroot

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// maxVCPUs bounds the vCPU count a producer may claim. It is far above any
// real SEV-SNP guest — AMD's own limit is an order of magnitude lower — and its
// only job is to keep an attacker-supplied number from sizing the work the
// verifier does before it can reject the evidence.
const maxVCPUs = 4096

// EvidenceType is the kind of hardware evidence a root certificate carries. The
// numbers are the `TeeEvidenceType` enum of the platform's TeeEvidence.proto,
// and they are also what selects a folder in the signed-measurement registry.
type EvidenceType int

// The evidence types the platform defines. Each number is also the
// TeeEvidence field that carries the branch, which is why ParseEvidence can
// name the one it does not know.
const (
	EvidenceUnspecified EvidenceType = 0
	EvidenceSevSnpQemu  EvidenceType = 1
	EvidenceTdxQemu     EvidenceType = 2
	EvidenceTdxGCP      EvidenceType = 3
	// The Azure confidential-VM branches: the hardware report sits inside the
	// paravisor's HCL report, and the image is measured by the vTPM rather
	// than by the hardware registers (azurecvm's package comment has the
	// chain).
	EvidenceTdxAzure    EvidenceType = 4
	EvidenceSevSnpAzure EvidenceType = 5
)

// String renders the type the way the platform's own UI labels it.
func (t EvidenceType) String() string {
	switch t {
	case EvidenceSevSnpQemu:
		return "AMD SEV-SNP (QEMU)"
	case EvidenceTdxQemu:
		return "Intel TDX (QEMU)"
	case EvidenceTdxGCP:
		return "Intel TDX (GCP)"
	case EvidenceTdxAzure:
		return "Intel TDX (Azure)"
	case EvidenceSevSnpAzure:
		return "AMD SEV-SNP (Azure)"
	default:
		return "Unspecified"
	}
}

// registryFolders are the sub-folders of the signed-measurement registry that
// may hold this type's measurements, in lookup order. Each cloud platform has
// its own folder and falls back to its base technology's, which holds the
// signatures published before the per-platform folders existed — the same map
// as attestation-common's `SignatureFolderMap`, which the extension uses.
func (t EvidenceType) registryFolders() []string {
	switch t {
	case EvidenceSevSnpQemu:
		return []string{"sev-snp"}
	case EvidenceTdxQemu:
		return []string{"tdx"}
	case EvidenceTdxGCP:
		return []string{"tdx-google", "tdx"}
	case EvidenceTdxAzure:
		return []string{"tdx-azure", "tdx"}
	case EvidenceSevSnpAzure:
		return []string{"sev-snp-azure", "sev-snp"}
	default:
		return nil
	}
}

// SevSnpCertType identifies one certificate of the AMD chain carried inside
// SEV-SNP evidence.
type SevSnpCertType int

// The AMD certificate roles. VLEK is defined by the platform's schema but is
// not produced by Super Protocol hosts today.
const (
	CertARK  SevSnpCertType = 0
	CertASK  SevSnpCertType = 1
	CertVCEK SevSnpCertType = 2
	CertVLEK SevSnpCertType = 3
)

// SevSnpEvidence is the AMD SEV-SNP branch of TeeEvidence: the raw attestation
// report, the supporting fields needed to re-derive its measurement, and the
// AMD certificate chain that signs it.
type SevSnpEvidence struct {
	// RawReport is the binary attestation report, exactly as the firmware
	// produced it.
	RawReport []byte
	// CPUSig and Cores describe the VM the report came from. They are
	// producer-supplied, and are only ever used to reproduce the report's own
	// MEASUREMENT — never to decide anything on their own.
	CPUSig uint32
	Cores  int
	// CmdLineHash is the SHA-256 of the kernel command line the VM booted with.
	CmdLineHash []byte
	// Build names the sp-vm release whose artefacts the VM booted.
	Build string
	// Certs is the AMD chain, keyed by role. DER or PEM, as published.
	Certs map[SevSnpCertType][]byte
}

// TdxEventLogEntry is one entry of the RTMR0 event list: an event type and the
// SHA-384 digest that was extended into the register.
type TdxEventLogEntry struct {
	Type   string
	Digest string
}

// TdxEvidence is the Intel TDX branch of TeeEvidence: the quote plus the RTMR0
// event list, which is what makes the register reproducible.
type TdxEvidence struct {
	Quote    []byte
	EventLog []TdxEventLogEntry
}

// AzureEvidence is either Azure branch of TeeEvidence (IntelTDXAzureEvidence
// or AmdSevSnpAzureEvidence): the paravisor's HCL report with the hardware
// report inside it, the vTPM quote over PCR4 and PCR9 with the event log that
// explains them, and Microsoft's certificate chain for the vTPM key.
type AzureEvidence struct {
	// HCLReport is the raw HCL report from vTPM NV index 0x01400001.
	HCLReport []byte
	// Quote is the TD quote covering the TDREPORT in HCLReport. TDX only.
	Quote []byte
	// Certs is the AMD chain for the SEV-SNP report in HCLReport. SEV-SNP only.
	Certs map[SevSnpCertType][]byte
	// TPMAttest and TPMSignature are the TPM2_Quote the vTPM key signed.
	TPMAttest    []byte
	TPMSignature []byte
	// EventLog is the TCG firmware event log the quoted PCRs replay from.
	EventLog []byte
	// AKCertChain is the vTPM attestation key's certificate chain, leaf first.
	AKCertChain [][]byte
}

// Evidence is a decoded TeeEvidence: exactly one branch is populated, and Type
// says which.
type Evidence struct {
	Type   EvidenceType
	SevSnp *SevSnpEvidence
	Tdx    *TdxEvidence
	Azure  *AzureEvidence
}

// ParseEvidence decodes the serialised TeeEvidence a root certificate carries.
//
// The wire format is protobuf, decoded by hand rather than through generated
// code: the message is four small types deep, the gatekeeper needs no other
// protobuf, and a hand-written reader keeps the schema visible next to the
// code that depends on it. Unknown fields are skipped, so a message written by
// a newer producer still decodes — which is the property the format is for.
func ParseEvidence(serialized []byte) (*Evidence, error) {
	if len(serialized) == 0 {
		return nil, errors.New("tee evidence is empty")
	}
	var out Evidence
	var unknown []int
	err := eachField(serialized, func(field int, wire wireType, value []byte, _ uint64) error {
		if wire != wireBytes {
			return nil
		}
		// The schema's branches are alternatives, and which one is present
		// selects both the verifier and the registry folder the measurement is
		// looked up in. A message carrying two of them has no single answer to
		// either question, so it is rejected rather than resolved by field
		// order.
		if field >= int(EvidenceSevSnpQemu) && field <= int(EvidenceSevSnpAzure) && out.Type != EvidenceUnspecified {
			return errors.New("evidence carries more than one hardware branch")
		}
		switch field {
		case 1:
			snp, err := parseSevSnpEvidence(value)
			if err != nil {
				return err
			}
			out.Type, out.SevSnp = EvidenceSevSnpQemu, snp
		case 2, 3:
			tdx, err := parseTdxEvidence(value)
			if err != nil {
				return err
			}
			out.Type, out.Tdx = EvidenceTdxQemu, tdx
			if field == 3 {
				out.Type = EvidenceTdxGCP
			}
		case 4, 5:
			azure, err := parseAzureEvidence(value, EvidenceType(field))
			if err != nil {
				return err
			}
			out.Type, out.Azure = EvidenceType(field), azure
		default:
			unknown = append(unknown, field)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("tee evidence: %w", err)
	}
	if out.Type == EvidenceUnspecified {
		// Said in terms of what an operator can act on: the root is not
		// necessarily broken, it may simply come from a platform newer than
		// this build — and the field numbers are what a developer needs to
		// tell which.
		if len(unknown) > 0 {
			return nil, fmt.Errorf("unrecognised evidence format: the root's TEE evidence carries only "+
				"branch field(s) %v, which this build does not know (it reads 1-5: SEV-SNP and TDX on QEMU, "+
				"TDX on GCP, TDX and SEV-SNP on Azure)", unknown)
		}
		return nil, errors.New("unrecognised evidence format: the root's TEE evidence carries no hardware branch")
	}
	return &out, nil
}

// parseAzureEvidence decodes IntelTDXAzureEvidence or AmdSevSnpAzureEvidence.
// The two share every field number; field 2 is the TD quote in the first and a
// repeated AMD certificate in the second.
func parseAzureEvidence(b []byte, kind EvidenceType) (*AzureEvidence, error) {
	name := "intelTdxAzure"
	if kind == EvidenceSevSnpAzure {
		name = "amdSevSnpAzure"
	}
	out := &AzureEvidence{Certs: map[SevSnpCertType][]byte{}}
	err := eachField(b, func(field int, wire wireType, value []byte, _ uint64) error {
		if wire != wireBytes {
			return nil
		}
		switch field {
		case 1:
			out.HCLReport = value
		case 2:
			if kind == EvidenceSevSnpAzure {
				return parseSnpCert(value, out.Certs)
			}
			out.Quote = value
		case 3:
			out.TPMAttest = value
		case 4:
			out.TPMSignature = value
		case 5:
			out.EventLog = value
		case 6:
			out.AKCertChain = append(out.AKCertChain, value)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if len(out.HCLReport) == 0 {
		return nil, fmt.Errorf("%s: evidence carries no HCL report", name)
	}
	return out, nil
}

func parseSevSnpEvidence(b []byte) (*SevSnpEvidence, error) {
	out := &SevSnpEvidence{Certs: map[SevSnpCertType][]byte{}}
	err := eachField(b, func(field int, wire wireType, value []byte, _ uint64) error {
		switch {
		case field == 1 && wire == wireBytes:
			return parseSnpReport(value, out)
		case field == 2 && wire == wireBytes:
			return parseSnpCert(value, out.Certs)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("amdSevSnpQemu: %w", err)
	}
	if len(out.RawReport) == 0 {
		return nil, errors.New("amdSevSnpQemu: evidence carries no snpReport")
	}
	return out, nil
}

func parseSnpReport(b []byte, out *SevSnpEvidence) error {
	return eachField(b, func(field int, wire wireType, value []byte, varint uint64) error {
		switch {
		case field == 1 && wire == wireBytes:
			out.RawReport = value
		case field == 2 && wire == wireVarint:
			if varint > math.MaxUint32 {
				return fmt.Errorf("snpReport: cpuSig %d does not fit in the 32-bit CPUID field", varint)
			}
			out.CPUSig = uint32(varint)
		case field == 3 && wire == wireVarint:
			// Bounded here, before anything acts on it: the vCPU count drives a
			// per-vCPU hashing loop in the launch measurement, and this value is
			// the producer's word. Evidence naming a real build and a billion
			// cores would otherwise keep the verifier hashing long past the
			// point where it was going to deny anyway.
			if varint == 0 || varint > maxVCPUs {
				return fmt.Errorf("snpReport: cores is %d, expected 1..%d", varint, maxVCPUs)
			}
			out.Cores = int(varint)
		case field == 4 && wire == wireBytes:
			out.CmdLineHash = value
		case field == 5 && wire == wireBytes:
			out.Build = string(value)
		}
		return nil
	})
}

func parseSnpCert(b []byte, certs map[SevSnpCertType][]byte) error {
	var role SevSnpCertType
	var der []byte
	err := eachField(b, func(field int, wire wireType, value []byte, varint uint64) error {
		switch {
		case field == 1 && wire == wireVarint:
			if varint > math.MaxInt32 {
				return fmt.Errorf("snpCert: certificate role %d is not one this schema defines", varint)
			}
			role = SevSnpCertType(varint)
		case field == 2 && wire == wireBytes:
			der = value
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(der) > 0 {
		certs[role] = der
	}
	return nil
}

func parseTdxEvidence(b []byte) (*TdxEvidence, error) {
	out := &TdxEvidence{}
	err := eachField(b, func(field int, wire wireType, value []byte, _ uint64) error {
		switch {
		case field == 1 && wire == wireBytes:
			out.Quote = value
		case field == 2 && wire == wireBytes:
			entry, err := parseTdxEventLogEntry(value)
			if err != nil {
				return err
			}
			out.EventLog = append(out.EventLog, entry)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("intelTdx: %w", err)
	}
	if len(out.Quote) == 0 {
		return nil, errors.New("intelTdx: evidence carries no quote")
	}
	return out, nil
}

func parseTdxEventLogEntry(b []byte) (TdxEventLogEntry, error) {
	var entry TdxEventLogEntry
	err := eachField(b, func(field int, wire wireType, value []byte, _ uint64) error {
		switch {
		case field == 1 && wire == wireBytes:
			entry.Type = string(value)
		case field == 2 && wire == wireBytes:
			entry.Digest = string(value)
		}
		return nil
	})
	return entry, err
}

// wireType is a protobuf wire type; only the two the schema uses are handled,
// with the fixed-width ones skipped rather than decoded.
type wireType int

const (
	wireVarint  wireType = 0
	wireFixed64 wireType = 1
	wireBytes   wireType = 2
	wireFixed32 wireType = 5
)

// eachField walks a protobuf message, calling visit once per field. Length-
// delimited values are passed as sub-slices of b — no copy — and varints as the
// decoded number.
func eachField(b []byte, visit func(field int, wire wireType, value []byte, varint uint64) error) error {
	for len(b) > 0 {
		tag, n := binary.Uvarint(b)
		if n <= 0 {
			return errors.New("malformed field tag")
		}
		b = b[n:]
		field, wire := int(tag>>3), wireType(tag&7)
		if field <= 0 {
			return fmt.Errorf("invalid field number %d", field)
		}

		switch wire {
		case wireVarint:
			value, n := binary.Uvarint(b)
			if n <= 0 {
				return fmt.Errorf("field %d: malformed varint", field)
			}
			b = b[n:]
			if err := visit(field, wire, nil, value); err != nil {
				return err
			}
		case wireBytes:
			length, n := binary.Uvarint(b)
			if n <= 0 {
				return fmt.Errorf("field %d: malformed length prefix", field)
			}
			b = b[n:]
			if length > uint64(len(b)) {
				return fmt.Errorf("field %d: length %d exceeds the %d bytes left", field, length, len(b))
			}
			if err := visit(field, wire, b[:length], 0); err != nil {
				return err
			}
			b = b[length:]
		case wireFixed64:
			if len(b) < 8 {
				return fmt.Errorf("field %d: truncated 64-bit value", field)
			}
			b = b[8:]
		case wireFixed32:
			if len(b) < 4 {
				return fmt.Errorf("field %d: truncated 32-bit value", field)
			}
			b = b[4:]
		default:
			return fmt.Errorf("field %d: unsupported wire type %d", field, wire)
		}
	}
	return nil
}
