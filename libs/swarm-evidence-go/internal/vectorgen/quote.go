package main

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"fmt"

	tdxabi "github.com/google/go-tdx-guest/abi"
	tdxpb "github.com/google/go-tdx-guest/proto/tdx"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// The TDX register sizes the image-identity formula depends on.
const (
	tdAttributesOctets = 8
	tdxRegisterOctets  = 48
)

// tdxEvent is one entry of the RTMR0 event list: an event type and the
// SHA-384 digest that was extended into the register.
type tdxEvent struct{ eventType, digest string }

// firmwareBlobEvents are the event types that survive RTMR0 normalisation.
// They are written out here rather than read from the module, for the same
// reason bindingDigest is: a corpus that computed its expectations with the
// code under test would assert nothing.
var firmwareBlobEvents = map[string]bool{
	"EV_EFI_PLATFORM_FIRMWARE_BLOB":  true,
	"EV_EFI_PLATFORM_FIRMWARE_BLOB2": true,
}

// baseEventLog is the RTMR0 event list every TDX case carries: two firmware
// blobs, which are what the normalised register is folded from, and two boot
// events that are not, which is what makes normalisation observable at all. A
// list of firmware blobs alone would replay to the same value either way.
func baseEventLog() []tdxEvent {
	return []tdxEvent{
		{"EV_EFI_PLATFORM_FIRMWARE_BLOB", hexFill("f1", tdxRegisterOctets)},
		{"EV_SEPARATOR", hexFill("5e", tdxRegisterOctets)},
		{"EV_EFI_PLATFORM_FIRMWARE_BLOB2", hexFill("f2", tdxRegisterOctets)},
		{"EV_EVENT_TAG", hexFill("e7", tdxRegisterOctets)},
	}
}

// tdxQuote is the TD a case's quote element carries.
//
// It is a real quote in every part a relying party reads without the vendor's
// signature: the registers, the RTMR0 event list that explains RTMR0, and the
// guest-chosen field carrying the binding digest. The ECDSA signature is
// filler, as it is in the SUP-648 parity vectors and for the same reason — no
// fixture can carry an Intel signature over a request this repository
// invented, and the delegated path hands that half to the relying party's own
// Verifier anyway.
type tdxQuote struct {
	platform     swarmevidence.Platform
	tdAttributes string
	mrtd         string
	// rtmr0 is what the event list replays to, unless a case deliberately
	// breaks the pairing.
	rtmr0                 string
	rtmr1, rtmr2, rtmr3   string
	teeTCBSVN             string
	eventLog              []tdxEvent
	reportData            string
	eventLogDoesNotReplay bool
}

// newTDXQuote builds the TD one case presents, bound to that case's request.
func newTDXQuote(platform swarmevidence.Platform, reportData []byte, eventLogDoesNotReplay bool) (*tdxQuote, error) {
	quote := &tdxQuote{
		platform:              platform,
		tdAttributes:          "0000001000000000",
		mrtd:                  hexFill("4d", tdxRegisterOctets),
		rtmr1:                 hexFill("r1", tdxRegisterOctets),
		rtmr2:                 hexFill("r2", tdxRegisterOctets),
		rtmr3:                 hexFill("r3", tdxRegisterOctets),
		teeTCBSVN:             "05000600000000000000000000000000",
		eventLog:              baseEventLog(),
		reportData:            hexOf(reportData),
		eventLogDoesNotReplay: eventLogDoesNotReplay,
	}
	replayed, err := replayRTMR(quote.eventLog, nil)
	if err != nil {
		return nil, err
	}
	quote.rtmr0 = hexOf(replayed)
	if eventLogDoesNotReplay {
		// A register the list beside it cannot explain. The quote is
		// otherwise sound, which is the point: what fails is the step that
		// derives an image identity, not the quote.
		quote.rtmr0 = hexFill("r0", tdxRegisterOctets)
	}
	return quote, nil
}

// measurements is the quote's registers in the spelling both the claim set
// and a Verifier's token use.
func (q *tdxQuote) measurements() swarmevidence.Measurements {
	return swarmevidence.Measurements{
		TDAttributes: q.tdAttributes,
		MRTD:         q.mrtd,
		RTMR0:        q.rtmr0,
		RTMR1:        q.rtmr1,
		RTMR2:        q.rtmr2,
		RTMR3:        q.rtmr3,
	}
}

// mrEnclave is the normalised, vCPU-independent image identity:
//
//	SHA-256(TDATTRIBUTES ‖ MRTD ‖ normalizedRTMR0 ‖ RTMR1 ‖ RTMR2 ‖ RTMR3)
//
// as sp-vm/docs/04-vm-measurements.md fixes it, written out here rather than
// called from the package the vectors appraise.
func (q *tdxQuote) mrEnclave() (string, error) {
	normalized, err := replayRTMR(q.eventLog, firmwareBlobEvents)
	if err != nil {
		return "", err
	}
	sum := sha256.New()
	for _, register := range []struct {
		name, value string
		octets      int
	}{
		{"tdattributes", q.tdAttributes, tdAttributesOctets},
		{"mrtd", q.mrtd, tdxRegisterOctets},
		{"normalised rtmr0", hexOf(normalized), tdxRegisterOctets},
		{"rtmr1", q.rtmr1, tdxRegisterOctets},
		{"rtmr2", q.rtmr2, tdxRegisterOctets},
		{"rtmr3", q.rtmr3, tdxRegisterOctets},
	} {
		raw, err := hex.DecodeString(register.value)
		if err != nil {
			return "", fmt.Errorf("%s is not hex: %w", register.name, err)
		}
		if len(raw) != register.octets {
			return "", fmt.Errorf("%s is %d octets, expected %d", register.name, len(raw), register.octets)
		}
		sum.Write(raw)
	}
	return hexOf(sum.Sum(nil)), nil
}

// replayRTMR folds an event list into a register, the way the TDX
// specification states it. A nil filter replays every event, which is what
// RTMR0 itself accumulates; the firmware-blob filter is the normalisation.
func replayRTMR(events []tdxEvent, included map[string]bool) ([]byte, error) {
	register := make([]byte, tdxRegisterOctets)
	for i, event := range events {
		if included != nil && !included[event.eventType] {
			continue
		}
		digest, err := hex.DecodeString(event.digest)
		if err != nil {
			return nil, fmt.Errorf("event %d digest is not hex: %w", i, err)
		}
		next := sha512.Sum384(append(append(make([]byte, 0, 2*tdxRegisterOctets), register...), digest...))
		register = next[:]
	}
	return register, nil
}

// evidence serialises the TeeEvidence the quote element carries: the TD quote
// and the RTMR0 event list, in the branch that names the platform.
func (q *tdxQuote) evidence() ([]byte, error) {
	registers, err := hexRegisters(q)
	if err != nil {
		return nil, err
	}
	body := &tdxpb.TDQuoteBody{
		TeeTcbSvn:      registers["tee_tcb_svn"],
		MrSeam:         make([]byte, tdxRegisterOctets),
		MrSignerSeam:   make([]byte, tdxRegisterOctets),
		SeamAttributes: make([]byte, tdAttributesOctets),
		TdAttributes:   registers["tdattributes"],
		Xfam:           make([]byte, tdAttributesOctets),
		MrTd:           registers["mrtd"],
		MrConfigId:     make([]byte, tdxRegisterOctets),
		MrOwner:        make([]byte, tdxRegisterOctets),
		MrOwnerConfig:  make([]byte, tdxRegisterOctets),
		Rtmrs: [][]byte{
			registers["rtmr0"], registers["rtmr1"], registers["rtmr2"], registers["rtmr3"],
		},
		ReportData: registers["report_data"],
	}
	raw, err := tdxabi.QuoteToAbiBytes(syntheticQuoteV4(body))
	if err != nil {
		return nil, fmt.Errorf("serialising the synthetic TD quote: %w", err)
	}

	inner := protoBytes(1, raw)
	for _, event := range q.eventLog {
		entry := append(protoBytes(1, []byte(event.eventType)), protoBytes(2, []byte(event.digest))...)
		inner = append(inner, protoBytes(2, entry)...)
	}
	// Field 2 is intelTdxQemu and field 3 intelTdxGcp: which branch the
	// message carries is what names the platform.
	field := 2
	if q.platform == swarmevidence.PlatformTDXGCP {
		field = 3
	}
	return protoBytes(field, inner), nil
}

func hexRegisters(q *tdxQuote) (map[string][]byte, error) {
	out := map[string][]byte{}
	for name, value := range map[string]string{
		"tee_tcb_svn":  q.teeTCBSVN,
		"tdattributes": q.tdAttributes,
		"mrtd":         q.mrtd,
		"rtmr0":        q.rtmr0,
		"rtmr1":        q.rtmr1,
		"rtmr2":        q.rtmr2,
		"rtmr3":        q.rtmr3,
		"report_data":  q.reportData,
	} {
		raw, err := hex.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("%s is not hex: %w", name, err)
		}
		out[name] = raw
	}
	return out, nil
}

// syntheticQuoteV4 wraps a TD quote body in the smallest well-formed V4
// envelope the ABI encoder accepts.
func syntheticQuoteV4(body *tdxpb.TDQuoteBody) *tdxpb.QuoteV4 {
	const (
		certificationDataSize = 459
		signedDataSize        = 593
	)
	return &tdxpb.QuoteV4{
		Header: &tdxpb.Header{
			Version: 4, AttestationKeyType: 2, TeeType: 0x81,
			QeSvn: make([]byte, 2), PceSvn: make([]byte, 2),
			QeVendorId: make([]byte, 16), UserData: make([]byte, 20),
		},
		TdQuoteBody:    body,
		SignedDataSize: signedDataSize,
		SignedData: &tdxpb.Ecdsa256BitQuoteV4AuthData{
			Signature:           make([]byte, 64),
			EcdsaAttestationKey: make([]byte, 64),
			CertificationData: &tdxpb.CertificationData{
				CertificateDataType: 6,
				Size:                certificationDataSize,
				QeReportCertificationData: &tdxpb.QEReportCertificationData{
					QeReport: &tdxpb.EnclaveReport{
						CpuSvn: make([]byte, 16), Reserved1: make([]byte, 28),
						Attributes: make([]byte, 16), MrEnclave: make([]byte, 32),
						Reserved2: make([]byte, 32), MrSigner: make([]byte, 32),
						Reserved3: make([]byte, 96), Reserved4: make([]byte, 60),
						ReportData: make([]byte, 64),
					},
					QeReportSignature: make([]byte, 64),
					QeAuthData:        &tdxpb.QeAuthData{},
					PckCertificateChainData: &tdxpb.PCKCertificateChainData{
						CertificateDataType: 5, Size: 3, PckCertChain: []byte("pck"),
					},
				},
			},
		},
	}
}

// nonTDXEvidence is the smallest well-formed TeeEvidence of a branch the
// delegated path does not cover.
//
// It carries no registers, which is exactly right: there is nothing for a
// quote-only Verifier to appraise on these branches, and the refusal the
// corpus records must come from the platform rather than from evidence that
// failed to parse.
func nonTDXEvidence(platform swarmevidence.Platform) []byte {
	switch platform {
	case swarmevidence.PlatformSNPQemu:
		return protoBytes(1, protoBytes(1, protoBytes(1, []byte("an SEV-SNP attestation report"))))
	case swarmevidence.PlatformTDXAzure:
		return protoBytes(4, protoBytes(1, []byte("an HCL report")))
	case swarmevidence.PlatformSNPAzure:
		return protoBytes(5, protoBytes(1, []byte("an HCL report")))
	default:
		return nil
	}
}

// protoBytes writes one length-delimited protobuf field.
func protoBytes(field int, value []byte) []byte {
	out := binary.AppendUvarint(nil, uint64(field)<<3|2)
	out = binary.AppendUvarint(out, uint64(len(value)))
	return append(out, value...)
}
