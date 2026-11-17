package attestedroot

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// QuoteStructure is what a hardware quote says about itself, read without any
// judgement about whether it is authentic.
//
// It exists for the one caller that does not appraise the quote's signature
// itself: the delegated appraiser, which hands the quote to the relying
// party's own Verifier and consumes the result as an EAT. That caller still
// needs the parts a quote-only Verifier does not report — the RTMR0 event
// list, and the guest-chosen field the binding digest is compared against —
// and it must read them from the quote in hand rather than from anything an
// intermediary says about it.
//
// Nothing here is a claim. [Verifier.Verify] and [Verifier.VerifyQuote] are
// what turn a quote into an appraisal; this only decodes one.
type QuoteStructure struct {
	// EvidenceType is the branch the serialised TeeEvidence carries. It is
	// always reported, including for the branches whose registers this does
	// not decode, because a caller outside its coverage has to be able to name
	// the platform it is refusing.
	EvidenceType EvidenceType

	// Measurements are the registers the quote carries, hex-encoded. Populated
	// for the two Intel TDX branches; empty for the rest, see [ReadQuote].
	Measurements RawMeasurements
	// ReportData is the guest-chosen field, and ReportDataSource which field
	// that was. Populated on the same branches as Measurements.
	ReportData       []byte
	ReportDataSource ReportDataSource
	// EventLog is the RTMR0 event list the TDX branches carry, which is what
	// makes the register normalisable.
	EventLog []TdxEventLogEntry
	// RawQuote is the hardware quote inside the TeeEvidence wrapper, for a
	// Verifier whose API takes the bare quote rather than the platform's
	// envelope around it.
	RawQuote []byte
	// TeeTCBSVN is the TD's TEE_TCB_SVN field, raw. Its first octets are the
	// SEAM module's security version, which is what a Verifier's own TCB
	// verdict is about.
	TeeTCBSVN []byte
}

// ReadQuote decodes a serialised TeeEvidence into the parts a delegated
// appraisal needs, without verifying anything.
//
// The two Intel TDX branches — `tdx-qemu` and `tdx-gcp` — are decoded in full.
// Every other branch returns a structure carrying only its [EvidenceType]:
// SEV-SNP has no RTMR event list to normalise, and on either Azure branch the
// hardware registers describe Microsoft's paravisor while the image identity
// is the vTPM's (sp-vm/docs/08-azure-attestation.md), so decoding them here
// would offer a caller numbers that do not mean what their names suggest.
func ReadQuote(serialized []byte) (*QuoteStructure, error) {
	evidence, err := ParseEvidence(serialized)
	if err != nil {
		return nil, err
	}
	out := &QuoteStructure{EvidenceType: evidence.Type}
	if evidence.Tdx == nil {
		return out, nil
	}

	body, err := tdQuoteBody(evidence.Tdx.Quote)
	if err != nil {
		return nil, err
	}
	out.Measurements = tdRegisters(body)
	out.ReportData = body.GetReportData()
	out.ReportDataSource = ReportDataQuote
	out.EventLog = evidence.Tdx.EventLog
	out.RawQuote = evidence.Tdx.Quote
	out.TeeTCBSVN = body.GetTeeTcbSvn()
	return out, nil
}

// TDXMrEnclave derives a TD's normalised, vCPU-independent image identity:
//
//	SHA-256(TDATTRIBUTES ‖ MRTD ‖ normalizedRTMR0 ‖ RTMR1 ‖ RTMR2 ‖ RTMR3)
//
// as sp-vm/docs/04-vm-measurements.md fixes it. The registers are taken in the
// hex spelling a quote and an EAT both report them in, so the offline path and
// a delegated one compute the same value from the same formula rather than
// from two implementations of it.
//
// The event list is checked against the RTMR0 it claims to explain before any
// of it is used: a list that does not replay to that register describes some
// other boot, and normalising it would silently measure a VM nobody attested.
// This is the step a quote-only Verifier structurally cannot perform — it
// consumes no event log, and a SHA-384 chain over a variable event list is not
// something a policy language can practically replay — which is why the
// delegated path still runs it here.
func TDXMrEnclave(m RawMeasurements, eventLog []TdxEventLogEntry) ([]byte, error) {
	attributes, err := registerBytes("TDATTRIBUTES", m.TDAttributes, tdAttributesSize)
	if err != nil {
		return nil, err
	}
	var registers [][]byte
	for _, register := range []struct{ name, value string }{
		{"MRTD", m.MRTD}, {"RTMR0", m.RTMR0}, {"RTMR1", m.RTMR1}, {"RTMR2", m.RTMR2}, {"RTMR3", m.RTMR3},
	} {
		raw, err := registerBytes(register.name, register.value, tdxRegisterSize)
		if err != nil {
			return nil, err
		}
		registers = append(registers, raw)
	}
	mrtd, rtmr0 := registers[0], registers[1]

	if len(eventLog) == 0 {
		return nil, errors.New("tdx evidence: the quote has no RTMR0 event list, so RTMR0 cannot be normalised")
	}

	replayed, err := replayRTMR(eventLog, nil)
	if err != nil {
		return nil, err
	}
	if !equalBytes(replayed, rtmr0) {
		return nil, fmt.Errorf("tdx evidence: the event list replays to %x, but the quote's RTMR0 is %x",
			replayed, rtmr0)
	}
	normalized, err := replayRTMR(eventLog, normalizedRTMR0Events)
	if err != nil {
		return nil, err
	}

	sum := sha256.New()
	for _, part := range [][]byte{attributes, mrtd, normalized, registers[2], registers[3], registers[4]} {
		sum.Write(part)
	}
	return sum.Sum(nil), nil
}

// registerBytes decodes one hex-spelled register and holds it to its size. A
// register of the wrong length would otherwise fold into the digest and
// produce an mrEnclave that is nobody's image.
func registerBytes(name, value string, size int) ([]byte, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return nil, fmt.Errorf("tdx quote: %s is not hex: %w", name, err)
	}
	if len(raw) != size {
		return nil, fmt.Errorf("tdx quote: %s is %d bytes, expected %d", name, len(raw), size)
	}
	return raw, nil
}
