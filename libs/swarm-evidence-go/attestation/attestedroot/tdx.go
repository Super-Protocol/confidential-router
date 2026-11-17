package attestedroot

import (
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	tdxabi "github.com/google/go-tdx-guest/abi"
	tdxpb "github.com/google/go-tdx-guest/proto/tdx"
	tdxverify "github.com/google/go-tdx-guest/verify"
)

// The TDX register sizes the measurement formula depends on.
const (
	tdAttributesSize = 8
	tdxRegisterSize  = 48
)

// normalizedRTMR0Events are the only event types that survive RTMR0
// normalisation: the firmware blobs. Everything else RTMR0 accumulates is boot
// noise that varies between otherwise identical VMs, and including it would
// make one image need a reference value per boot
// (sp-vm/docs/04-vm-measurements.md §3).
var normalizedRTMR0Events = map[string]bool{
	"EV_EFI_PLATFORM_FIRMWARE_BLOB":  true,
	"EV_EFI_PLATFORM_FIRMWARE_BLOB2": true,
}

// verifyTdx runs the hardware half of an Intel TDX attested root.
func (v *Verifier) verifyTdx(ev *TdxEvidence, spki *[32]byte, out *Result) error {
	// Quote integrity first, and offline: the signature and the Intel chain.
	if err := v.verifyTdxQuote(ev.Quote, out); err != nil {
		return err
	}

	body, err := tdQuoteBody(ev.Quote)
	if err != nil {
		return err
	}
	out.RawMeasurements = tdRegisters(body)
	out.ReportData = body.GetReportData()
	out.ReportDataSource = ReportDataQuote
	if spki != nil {
		out.KeyBinding = BindsPublicKey(out.ReportData, *spki)
		if !out.KeyBinding {
			return fmt.Errorf(
				"the quote's reportData does not commit to this certificate's public key (SHA-256 %x)", *spki)
		}
	}

	measurement, err := tdxMeasurement(body, ev.EventLog)
	if err != nil {
		return err
	}
	out.Measurement = measurement
	return nil
}

// tdxRevocation reports whether the quote's certificate chain is un-revoked.
//
// go-tdx-guest folds every collateral check into one error, and it surfaces CRL
// failures *before* TCB ones. Asking it once with revocation on would therefore
// report an out-of-date TCB as a revocation. So the quote is verified twice —
// with collateral and without the CRL, then with it — and only a *new* error is
// attributed to revocation. This is the comparison the platform's own TDX
// verifier makes.
//
// The first return value is false when the check could not be run at all, which
// is reported as "not checked" rather than as a clean chain.
func (v *Verifier) tdxRevocation(quote []byte) (checked, notRevoked bool) {
	options := func(crl bool) *tdxverify.Options {
		o := tdxverify.DefaultOptions()
		o.GetCollateral = true
		o.CheckRevocations = crl
		o.Now = v.clock()
		if v.TdxGetter != nil {
			o.Getter = v.TdxGetter
		}
		return o
	}

	baseline := tdxverify.RawTdxQuote(quote, options(false))
	withCRL := tdxverify.RawTdxQuote(quote, options(true))
	switch {
	case withCRL == nil:
		return true, true
	case baseline != nil && withCRL.Error() == baseline.Error():
		// The CRL introduced nothing; whatever is wrong was wrong already and
		// is not a revocation.
		return true, true
	default:
		return true, false
	}
}

// tdQuoteBody pulls the TD quote body out of a raw quote.
func tdQuoteBody(raw []byte) (*tdxpb.TDQuoteBody, error) {
	quote, err := tdxabi.QuoteToProto(raw)
	if err != nil {
		return nil, fmt.Errorf("tdx quote: %w", err)
	}
	v4, ok := quote.(*tdxpb.QuoteV4)
	if !ok {
		return nil, fmt.Errorf("tdx quote: unsupported quote format %T", quote)
	}
	body := v4.GetTdQuoteBody()
	if body == nil {
		return nil, errors.New("tdx quote: the quote carries no TD quote body")
	}
	return body, nil
}

// tdRegisters records the TD quote's own measurement registers, before any
// check decides whether they are acceptable. They are recorded even when the
// steps after this one fail: a reader comparing a denial against a reference
// value needs the numbers that were compared.
func tdRegisters(body *tdxpb.TDQuoteBody) RawMeasurements {
	out := RawMeasurements{
		TDAttributes: hex.EncodeToString(body.GetTdAttributes()),
		MRTD:         hex.EncodeToString(body.GetMrTd()),
	}
	rtmrs := body.GetRtmrs()
	for i, target := range []*string{&out.RTMR0, &out.RTMR1, &out.RTMR2, &out.RTMR3} {
		if i < len(rtmrs) {
			*target = hex.EncodeToString(rtmrs[i])
		}
	}
	return out
}

// tdxMeasurement derives the normalised mrEnclave of a TD
// (sp-vm/docs/04-vm-measurements.md §"Intel TDX").
//
// It is the quote-shaped entry point to [TDXMrEnclave], which is the formula
// itself. The two are kept apart because the delegated appraiser of SUP-648
// reaches the same formula from registers an EAT reported rather than from a
// quote body, and a second implementation of the digest would be a second
// place for the two paths to disagree.
func tdxMeasurement(body *tdxpb.TDQuoteBody, eventLog []TdxEventLogEntry) ([]byte, error) {
	if rtmrs := body.GetRtmrs(); len(rtmrs) < 4 {
		return nil, fmt.Errorf("tdx quote: the quote carries %d RTMRs, expected 4", len(rtmrs))
	}
	return TDXMrEnclave(tdRegisters(body), eventLog)
}

// replayRTMR folds an event list into a register, optionally keeping only the
// listed event types.
func replayRTMR(eventLog []TdxEventLogEntry, included map[string]bool) ([]byte, error) {
	register := make([]byte, tdxRegisterSize)
	for i, event := range eventLog {
		if included != nil && !included[event.Type] {
			continue
		}
		digest, err := hex.DecodeString(strings.TrimSpace(event.Digest))
		if err != nil {
			return nil, fmt.Errorf("tdx evidence: event %d digest is not hex: %w", i, err)
		}
		if len(digest) != tdxRegisterSize {
			return nil, fmt.Errorf("tdx evidence: event %d digest is %d bytes, expected %d",
				i, len(digest), tdxRegisterSize)
		}
		// A fresh buffer rather than append(register, …): the register is what
		// the loop carries forward, and aliasing its backing array would make
		// the replay depend on capacity.
		buf := make([]byte, 0, 2*tdxRegisterSize)
		buf = append(append(buf, register...), digest...)
		next := sha512.Sum384(buf)
		register = next[:]
	}
	return register, nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
