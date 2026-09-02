package attestedroot

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// EvidenceType is the kind of hardware evidence a root certificate carries. The
// numbers are the `TeeEvidenceType` enum of the platform's TeeEvidence.proto,
// and they are also what selects a folder in the signed-measurement registry.
type EvidenceType int

// The evidence types the platform defines. Only the two the gatekeeper can
// verify are handled below; the rest are named so an unsupported root fails
// with something a human can act on.
const (
	EvidenceUnspecified EvidenceType = 0
	EvidenceSevSnpQemu  EvidenceType = 1
	EvidenceTdxQemu     EvidenceType = 2
	EvidenceTdxGCP      EvidenceType = 3
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
	default:
		return "Unspecified"
	}
}

// registryFolder is the sub-folder of the signed-measurement registry that
// holds this type's measurements. TDX under QEMU and under GCP share one.
func (t EvidenceType) registryFolder() string {
	switch t {
	case EvidenceSevSnpQemu:
		return "sev-snp"
	case EvidenceTdxQemu, EvidenceTdxGCP:
		return "tdx"
	default:
		return ""
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

// Evidence is a decoded TeeEvidence: exactly one branch is populated, and Type
// says which.
type Evidence struct {
	Type   EvidenceType
	SevSnp *SevSnpEvidence
	Tdx    *TdxEvidence
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
	err := eachField(serialized, func(field int, wire wireType, value []byte, _ uint64) error {
		if wire != wireBytes {
			return nil
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
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("tee evidence: %w", err)
	}
	if out.Type == EvidenceUnspecified {
		return nil, errors.New("tee evidence carries no recognised evidence branch")
	}
	return &out, nil
}

func parseSevSnpEvidence(b []byte) (*SevSnpEvidence, error) {
	out := &SevSnpEvidence{Certs: map[SevSnpCertType][]byte{}}
	err := eachField(b, func(field int, wire wireType, value []byte, _ uint64) error {
		switch {
		case field == 1 && wire == wireBytes:
			return parseSnpReport(value, out)
		case field == 2 && wire == wireBytes:
			return parseSnpCert(value, out)
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
			out.CPUSig = uint32(varint)
		case field == 3 && wire == wireVarint:
			out.Cores = int(varint)
		case field == 4 && wire == wireBytes:
			out.CmdLineHash = value
		case field == 5 && wire == wireBytes:
			out.Build = string(value)
		}
		return nil
	})
}

func parseSnpCert(b []byte, out *SevSnpEvidence) error {
	var role SevSnpCertType
	var der []byte
	err := eachField(b, func(field int, wire wireType, value []byte, varint uint64) error {
		switch {
		case field == 1 && wire == wireVarint:
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
		out.Certs[role] = der
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
