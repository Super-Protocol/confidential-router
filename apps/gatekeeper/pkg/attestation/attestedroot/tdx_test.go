package attestedroot

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"strings"
	"testing"

	tdxpb "github.com/google/go-tdx-guest/proto/tdx"
)

// tdxEvent is one synthetic event: a type and the digest extended for it.
type tdxEvent struct {
	kind   string
	digest []byte
}

func digestOf(seed byte) []byte {
	out := make([]byte, tdxRegisterSize)
	for i := range out {
		out[i] = seed
	}
	return out
}

// replay is the register the events fold into, so the test computes its
// expectations the same way the specification states them rather than by
// copying the implementation's output.
func replay(events []tdxEvent, only map[string]bool) []byte {
	register := make([]byte, tdxRegisterSize)
	for _, event := range events {
		if only != nil && !only[event.kind] {
			continue
		}
		next := sha512.Sum384(append(register, event.digest...))
		register = next[:]
	}
	return register
}

func tdxBody(t *testing.T, rtmr0 []byte) *tdxpb.TDQuoteBody {
	t.Helper()
	return &tdxpb.TDQuoteBody{
		TdAttributes: make([]byte, tdAttributesSize),
		MrTd:         digestOf(0x11),
		Rtmrs:        [][]byte{rtmr0, digestOf(0x22), digestOf(0x33), digestOf(0x44)},
		ReportData:   make([]byte, 64),
	}
}

func tdxEntries(events []tdxEvent) []TdxEventLogEntry {
	out := make([]TdxEventLogEntry, 0, len(events))
	for _, event := range events {
		out = append(out, TdxEventLogEntry{Type: event.kind, Digest: hex.EncodeToString(event.digest)})
	}
	return out
}

// TestTdxMeasurementNormalizesRTMR0 checks the two halves of the TDX formula:
// the event list must replay to the register the quote carries, and the value
// that goes into the digest is the firmware-blob-only replay.
func TestTdxMeasurementNormalizesRTMR0(t *testing.T) {
	events := []tdxEvent{
		{kind: "EV_EFI_PLATFORM_FIRMWARE_BLOB", digest: digestOf(0x01)},
		{kind: "EV_SEPARATOR", digest: digestOf(0x02)},
		{kind: "EV_EFI_PLATFORM_FIRMWARE_BLOB2", digest: digestOf(0x03)},
		{kind: "EV_EVENT_TAG", digest: digestOf(0x04)},
	}
	body := tdxBody(t, replay(events, nil))

	got, err := tdxMeasurement(body, tdxEntries(events))
	if err != nil {
		t.Fatalf("tdxMeasurement: %v", err)
	}

	normalized := replay(events, normalizedRTMR0Events)
	sum := sha256.New()
	for _, part := range [][]byte{
		body.GetTdAttributes(), body.GetMrTd(), normalized,
		body.GetRtmrs()[1], body.GetRtmrs()[2], body.GetRtmrs()[3],
	} {
		sum.Write(part)
	}
	if want := sum.Sum(nil); hex.EncodeToString(got) != hex.EncodeToString(want) {
		t.Errorf("mrEnclave = %x, want %x", got, want)
	}

	// The dynamic events must not reach the digest, which is the whole point of
	// normalising: the same image booted twice measures the same.
	if hex.EncodeToString(normalized) == hex.EncodeToString(body.GetRtmrs()[0]) {
		t.Fatal("the test's normalised RTMR0 is the full one, so it proves nothing")
	}
}

// TestTdxMeasurementRejectsAnEventListThatDoesNotReplay is the check that keeps
// the normalisation honest: an event list nothing attests could otherwise
// declare any firmware it liked.
func TestTdxMeasurementRejectsAnEventListThatDoesNotReplay(t *testing.T) {
	events := []tdxEvent{{kind: "EV_EFI_PLATFORM_FIRMWARE_BLOB", digest: digestOf(0x01)}}
	body := tdxBody(t, digestOf(0x99))

	_, err := tdxMeasurement(body, tdxEntries(events))
	if err == nil {
		t.Fatal("an event list that does not reproduce RTMR0 was accepted")
	}
	if !strings.Contains(err.Error(), "RTMR0") {
		t.Errorf("error = %v, want it to name RTMR0", err)
	}
}

// TestTdxMeasurementRejectsMalformedQuotes covers the shapes that would
// otherwise silently produce a short digest.
func TestTdxMeasurementRejectsMalformedQuotes(t *testing.T) {
	events := []tdxEvent{{kind: "EV_EFI_PLATFORM_FIRMWARE_BLOB", digest: digestOf(0x01)}}
	entries := tdxEntries(events)

	t.Run("no event list", func(t *testing.T) {
		if _, err := tdxMeasurement(tdxBody(t, replay(events, nil)), nil); err == nil {
			t.Fatal("a quote with no event list was accepted")
		}
	})
	t.Run("a short MRTD", func(t *testing.T) {
		body := tdxBody(t, replay(events, nil))
		body.MrTd = body.MrTd[:8]
		if _, err := tdxMeasurement(body, entries); err == nil {
			t.Fatal("a short MRTD was accepted")
		}
	})
	t.Run("too few RTMRs", func(t *testing.T) {
		body := tdxBody(t, replay(events, nil))
		body.Rtmrs = body.Rtmrs[:2]
		if _, err := tdxMeasurement(body, entries); err == nil {
			t.Fatal("a quote with two RTMRs was accepted")
		}
	})
	t.Run("a digest that is not hex", func(t *testing.T) {
		body := tdxBody(t, replay(events, nil))
		if _, err := tdxMeasurement(body, []TdxEventLogEntry{{Type: "EV_SEPARATOR", Digest: "zz"}}); err == nil {
			t.Fatal("a non-hex event digest was accepted")
		}
	})
}
