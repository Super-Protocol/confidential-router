package attestedroot

import (
	"crypto/sha256"
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
func (v *Verifier) verifyTdx(ev *TdxEvidence, ext *RootExtensions, out *Result) error {
	// Quote integrity first, and offline: the signature and the Intel chain.
	// Collateral (TCB status, CRLs) is a separate, network-dependent step, and
	// go-tdx-guest treats a missing collateral fetch as a verification failure —
	// which would make an offline gatekeeper unable to see a sound quote at all.
	options := tdxverify.DefaultOptions()
	options.GetCollateral = false
	options.CheckRevocations = false
	options.Now = v.clock()
	if v.TdxGetter != nil {
		options.Getter = v.TdxGetter
	}
	if err := tdxverify.RawTdxQuote(ev.Quote, options); err != nil {
		return fmt.Errorf("tdx quote: %w", err)
	}
	out.ReportIntegrity = true

	body, err := tdQuoteBody(ev.Quote)
	if err != nil {
		return err
	}
	out.ReportData = body.GetReportData()
	out.KeyBinding = BindsPublicKey(out.ReportData, ext.SPKIDigest)
	if !out.KeyBinding {
		return fmt.Errorf(
			"the quote's reportData does not commit to this certificate's public key (SHA-256 %x)", ext.SPKIDigest)
	}

	if v.CheckRevocations {
		out.RevocationChecked, out.NotRevoked = v.tdxRevocation(ev.Quote)
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

// tdxMeasurement derives the normalised mrEnclave of a TD
// (sp-vm/docs/04-vm-measurements.md §"Intel TDX").
//
// The event list is checked against the register it claims to explain before
// any of it is used: a list that does not replay to the quote's RTMR0 describes
// some other boot, and normalising it would silently measure a VM nobody
// attested.
func tdxMeasurement(body *tdxpb.TDQuoteBody, eventLog []TdxEventLogEntry) ([]byte, error) {
	attributes := body.GetTdAttributes()
	if len(attributes) != tdAttributesSize {
		return nil, fmt.Errorf("tdx quote: TDATTRIBUTES is %d bytes, expected %d", len(attributes), tdAttributesSize)
	}
	mrtd := body.GetMrTd()
	rtmrs := body.GetRtmrs()
	if len(rtmrs) < 4 {
		return nil, fmt.Errorf("tdx quote: the quote carries %d RTMRs, expected 4", len(rtmrs))
	}
	for name, value := range map[string][]byte{
		"MRTD": mrtd, "RTMR0": rtmrs[0], "RTMR1": rtmrs[1], "RTMR2": rtmrs[2], "RTMR3": rtmrs[3],
	} {
		if len(value) != tdxRegisterSize {
			return nil, fmt.Errorf("tdx quote: %s is %d bytes, expected %d", name, len(value), tdxRegisterSize)
		}
	}
	if len(eventLog) == 0 {
		return nil, errors.New("tdx evidence: the quote has no RTMR0 event list, so RTMR0 cannot be normalised")
	}

	replayed, err := replayRTMR(eventLog, nil)
	if err != nil {
		return nil, err
	}
	if !equalBytes(replayed, rtmrs[0]) {
		return nil, fmt.Errorf("tdx evidence: the event list replays to %x, but the quote's RTMR0 is %x",
			replayed, rtmrs[0])
	}
	normalized, err := replayRTMR(eventLog, normalizedRTMR0Events)
	if err != nil {
		return nil, err
	}

	sum := sha256.New()
	for _, part := range [][]byte{attributes, mrtd, normalized, rtmrs[1], rtmrs[2], rtmrs[3]} {
		sum.Write(part)
	}
	return sum.Sum(nil), nil
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
