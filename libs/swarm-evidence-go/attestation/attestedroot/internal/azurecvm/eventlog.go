package azurecvm

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

const (
	evNoAction  = 0x00000003
	evSeparator = 0x00000004
	evEFIAction = 0x80000007

	sha1DigestSize = 20
	// Upper bound for one event's data, far above anything firmware emits;
	// guards against absurd allocations on malformed input.
	maxEventDataSize = 1 << 20
)

var specIDSignature = []byte("Spec ID Event03\x00")

type tcgEvent struct {
	offset    int // record bounds in the log
	end       int
	pcr       uint32
	eventType uint32
	digest    []byte // SHA-256 bank
	data      []byte
}

// parseEventLog parses an evidence event log. Every event must belong to one of
// quotedPCRs.
func parseEventLog(raw []byte) ([]tcgEvent, error) {
	_, events, err := parseEventRecords(raw)
	if err != nil {
		return nil, err
	}
	for _, event := range events {
		if !isQuotedPCR(event.pcr) {
			return nil, fmt.Errorf("event at offset %d is for PCR%d; only PCRs %v are allowed", event.offset, event.pcr, quotedPCRs)
		}
	}
	return events, nil
}

// FilterEventLog reduces a full firmware event log (such as
// /sys/kernel/security/tpm0/binary_bios_measurements) to the Spec ID header and
// the events of the quoted PCRs, which is what the evidence carries.
func FilterEventLog(raw []byte) ([]byte, error) {
	headerSize, events, err := parseEventRecords(raw)
	if err != nil {
		return nil, err
	}
	filtered := append([]byte{}, raw[:headerSize]...)
	for _, event := range events {
		if isQuotedPCR(event.pcr) {
			filtered = append(filtered, raw[event.offset:event.end]...)
		}
	}
	return filtered, nil
}

// parseEventRecords parses a TCG2 crypto-agile event log: a SHA-1 format Spec
// ID header event followed by TCG_PCR_EVENT2 records, each of which must carry a
// SHA-256 digest. It returns the header size and the records.
func parseEventRecords(raw []byte) (int, []tcgEvent, error) {
	r := leReader{data: raw}

	r.uint32() // header PCR index
	headerType := r.uint32()
	r.skip(sha1DigestSize)
	header := r.bytes(int(r.uint32()))
	if r.err != nil {
		return 0, nil, fmt.Errorf("event log header is malformed: %w", r.err)
	}
	if headerType != evNoAction {
		return 0, nil, fmt.Errorf("event log header type is %#x, expected EV_NO_ACTION", headerType)
	}
	digestSizes, err := parseSpecIDEvent(header)
	if err != nil {
		return 0, nil, err
	}
	headerSize := r.pos

	var events []tcgEvent
	for r.remaining() > 0 {
		offset := r.pos
		event := tcgEvent{offset: offset, pcr: r.uint32(), eventType: r.uint32()}
		count := r.uint32()
		if r.err == nil && count > uint32(len(digestSizes)) {
			return 0, nil, fmt.Errorf("event at offset %d has %d digests, more than the %d declared algorithms", offset, count, len(digestSizes))
		}
		for i := uint32(0); i < count && r.err == nil; i++ {
			alg := r.uint16()
			size, known := digestSizes[alg]
			if !known {
				return 0, nil, fmt.Errorf("event at offset %d uses undeclared digest algorithm %#x", offset, alg)
			}
			digest := r.bytes(int(size))
			if alg == tpmAlgSHA256 {
				if event.digest != nil {
					return 0, nil, fmt.Errorf("event at offset %d has more than one SHA-256 digest", offset)
				}
				event.digest = digest
			}
		}
		dataSize := r.uint32()
		if r.err == nil && dataSize > maxEventDataSize {
			return 0, nil, fmt.Errorf("event at offset %d has %d bytes of data", offset, dataSize)
		}
		event.data = r.bytes(int(dataSize))
		if r.err != nil {
			return 0, nil, fmt.Errorf("event at offset %d is malformed: %w", offset, r.err)
		}
		if event.digest == nil {
			return 0, nil, fmt.Errorf("event at offset %d has no SHA-256 digest", offset)
		}
		event.end = r.pos
		events = append(events, event)
	}
	return headerSize, events, nil
}

// parseSpecIDEvent returns the digest size of every algorithm the log declares.
func parseSpecIDEvent(data []byte) (map[uint16]uint16, error) {
	r := leReader{data: data}
	signature := r.bytes(len(specIDSignature))
	r.skip(4 + 1 + 1 + 1 + 1) // platformClass, spec version minor/major, errata, uintnSize
	count := r.uint32()
	if r.err == nil && count > 16 {
		return nil, fmt.Errorf("event log declares %d digest algorithms", count)
	}
	sizes := make(map[uint16]uint16, count)
	for i := uint32(0); i < count && r.err == nil; i++ {
		sizes[r.uint16()] = r.uint16()
	}
	if r.err != nil {
		return nil, fmt.Errorf("event log Spec ID event is malformed: %w", r.err)
	}
	if !bytes.Equal(signature, specIDSignature) {
		return nil, fmt.Errorf("event log is not a TCG2 crypto-agile log")
	}
	if sizes[tpmAlgSHA256] != sha256.Size {
		return nil, fmt.Errorf("event log does not declare a SHA-256 bank")
	}
	return sizes, nil
}

func isQuotedPCR(pcr uint32) bool {
	for _, quoted := range quotedPCRs {
		if pcr == quoted {
			return true
		}
	}
	return false
}

// replayPCR extends a zeroed PCR with every measured event of pcr, the way the
// TPM did. EV_NO_ACTION events are informational and never extended.
func replayPCR(events []tcgEvent, pcr uint32) []byte {
	return extendPCR(events, pcr, func(tcgEvent) bool { return true })
}

func extendPCR(events []tcgEvent, pcr uint32, include func(tcgEvent) bool) []byte {
	value := make([]byte, sha256.Size)
	for _, event := range events {
		if event.pcr != pcr || event.eventType == evNoAction || !include(event) {
			continue
		}
		sum := sha256.Sum256(append(value, event.digest...))
		value = sum[:]
	}
	return value
}

// leReader reads little-endian event log structures and records the first error.
type leReader struct {
	data []byte
	pos  int
	err  error
}

func (r *leReader) bytes(n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || r.pos+n > len(r.data) {
		r.err = fmt.Errorf("truncated at offset %d", r.pos)
		return nil
	}
	b := r.data[r.pos : r.pos+n]
	r.pos += n
	return b
}

func (r *leReader) skip(n int) { r.bytes(n) }

func (r *leReader) uint16() uint16 {
	if b := r.bytes(2); b != nil {
		return binary.LittleEndian.Uint16(b)
	}
	return 0
}

func (r *leReader) uint32() uint32 {
	if b := r.bytes(4); b != nil {
		return binary.LittleEndian.Uint32(b)
	}
	return 0
}

func (r *leReader) remaining() int {
	return len(r.data) - r.pos
}
