package attestedroot

import (
	"bytes"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"

	tdxabi "github.com/google/go-tdx-guest/abi"
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

// fullTdxBody is a TD quote body with every field the ABI encoder requires,
// so that it can be serialised into a quote and read back from it.
func fullTdxBody(rtmr0 []byte) *tdxpb.TDQuoteBody {
	return &tdxpb.TDQuoteBody{
		TeeTcbSvn:      bytes.Repeat([]byte{0x77}, 16),
		MrSeam:         digestOf(0x55),
		MrSignerSeam:   digestOf(0x66),
		SeamAttributes: make([]byte, tdAttributesSize),
		TdAttributes:   bytes.Repeat([]byte{0x10}, tdAttributesSize),
		Xfam:           make([]byte, tdAttributesSize),
		MrTd:           digestOf(0x11),
		MrConfigId:     digestOf(0x12),
		MrOwner:        digestOf(0x13),
		MrOwnerConfig:  digestOf(0x14),
		Rtmrs:          [][]byte{rtmr0, digestOf(0x22), digestOf(0x33), digestOf(0x44)},
		ReportData:     bytes.Repeat([]byte{0x99}, 64),
	}
}

// signedDataFiller is the signature section a synthetic quote carries: the
// smallest well-formed one the ABI encoder accepts. No fixture can hold an
// Intel signature over a body this test invented, and nothing here verifies
// one — these tests are about which bytes a quote format puts where.
func signedDataFiller() *tdxpb.Ecdsa256BitQuoteV4AuthData {
	const certificationDataSize = 459
	return &tdxpb.Ecdsa256BitQuoteV4AuthData{
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
	}
}

const signedDataFillerSize = 593

func rawQuoteV4(t *testing.T, body *tdxpb.TDQuoteBody) []byte {
	t.Helper()
	raw, err := tdxabi.QuoteToAbiBytes(&tdxpb.QuoteV4{
		Header: &tdxpb.Header{
			Version: 4, AttestationKeyType: 2, TeeType: 0x81,
			QeSvn: make([]byte, 2), PceSvn: make([]byte, 2),
			QeVendorId: make([]byte, 16), UserData: make([]byte, 20),
		},
		TdQuoteBody:    body,
		SignedDataSize: signedDataFillerSize,
		SignedData:     signedDataFiller(),
	})
	if err != nil {
		t.Fatalf("serialising a v4 quote: %v", err)
	}
	return raw
}

// rawQuoteV5 serialises the same body as a v5 quote of the given body type.
// Body type 3 is a TDX 1.5 TD, whose body carries tee_tcb_svn2 and
// mrservicetd after the fields body type 2 ends with.
func rawQuoteV5(t *testing.T, bodyType int32, body *tdxpb.TDQuoteBody) []byte {
	t.Helper()
	v5 := &tdxpb.TDQuoteBodyV5{
		TeeTcbSvn:      body.GetTeeTcbSvn(),
		MrSeam:         body.GetMrSeam(),
		MrSignerSeam:   body.GetMrSignerSeam(),
		SeamAttributes: body.GetSeamAttributes(),
		TdAttributes:   body.GetTdAttributes(),
		Xfam:           body.GetXfam(),
		MrTd:           body.GetMrTd(),
		MrConfigId:     body.GetMrConfigId(),
		MrOwner:        body.GetMrOwner(),
		MrOwnerConfig:  body.GetMrOwnerConfig(),
		Rtmrs:          body.GetRtmrs(),
		ReportData:     body.GetReportData(),
	}
	bodySize := int32(584)
	if bodyType == 3 {
		v5.TeeTcbSvn2 = bytes.Repeat([]byte{0x88}, 16)
		v5.MrServiceTd = digestOf(0x15)
		bodySize = 648
	}
	raw, err := tdxabi.QuoteToAbiBytes(&tdxpb.QuoteV5{
		Header: &tdxpb.Header{
			Version: 5, AttestationKeyType: 2, TeeType: 0x81,
			QeSvn: make([]byte, 2), PceSvn: make([]byte, 2),
			QeVendorId: make([]byte, 16), UserData: make([]byte, 20),
		},
		TdQuoteBodyDescriptor: &tdxpb.TDQuoteBodyDescriptor{
			TdQuoteBodyType: bodyType,
			TdQuoteBodySize: bodySize,
			TdQuoteBodyV5:   v5,
		},
		SignedDataSize: signedDataFillerSize,
		SignedData:     signedDataFiller(),
	})
	if err != nil {
		t.Fatalf("serialising a v5 quote of body type %d: %v", bodyType, err)
	}
	return raw
}

// Azure hosts have started issuing TD quote v5 (SUP-768): the same TD report
// body, moved behind a body descriptor, in one of two shapes. Which format a
// host's quoting enclave emits must not change the registers this package
// reads or the image identity it derives from them.
func TestTdQuoteBodyReadsEveryQuoteFormat(t *testing.T) {
	events := []tdxEvent{
		{kind: "EV_EFI_PLATFORM_FIRMWARE_BLOB", digest: digestOf(0x01)},
		{kind: "EV_SEPARATOR", digest: digestOf(0x02)},
		{kind: "EV_EFI_PLATFORM_FIRMWARE_BLOB2", digest: digestOf(0x03)},
	}
	source := fullTdxBody(replay(events, nil))
	want := tdRegisters(source)
	wantMeasurement, err := tdxMeasurement(source, tdxEntries(events))
	if err != nil {
		t.Fatalf("tdxMeasurement: %v", err)
	}

	for _, tt := range []struct {
		name string
		raw  []byte
	}{
		{"v4", rawQuoteV4(t, source)},
		{"v5, TDX 1.0 body", rawQuoteV5(t, 2, source)},
		{"v5, TDX 1.5 body", rawQuoteV5(t, 3, source)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			body, err := tdQuoteBody(tt.raw)
			if err != nil {
				t.Fatalf("tdQuoteBody: %v", err)
			}
			if got := tdRegisters(body); got != want {
				t.Errorf("registers = %+v, want %+v", got, want)
			}
			if !bytes.Equal(body.GetTeeTcbSvn(), source.GetTeeTcbSvn()) {
				t.Errorf("tee_tcb_svn = %x, want %x", body.GetTeeTcbSvn(), source.GetTeeTcbSvn())
			}
			if !bytes.Equal(body.GetReportData(), source.GetReportData()) {
				t.Errorf("report_data = %x, want %x", body.GetReportData(), source.GetReportData())
			}
			got, err := tdxMeasurement(body, tdxEntries(events))
			if err != nil {
				t.Fatalf("tdxMeasurement: %v", err)
			}
			if !bytes.Equal(got, wantMeasurement) {
				t.Errorf("mrEnclave = %x, want %x", got, wantMeasurement)
			}
		})
	}
}

// A quote format whose body this package cannot read must be refused before
// any register is taken from it.
func TestTdQuoteBodyRejectsUnreadableQuotes(t *testing.T) {
	source := fullTdxBody(digestOf(0x21))
	v5 := rawQuoteV5(t, 2, source)
	tests := []struct {
		name string
		raw  []byte
		want string
	}{
		{"empty", nil, "tdx quote"},
		{"version 6", withQuoteVersion(v5, 6), "tdx quote"},
		{"truncated body", v5[:48+6+500], "tdx quote"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := tdQuoteBody(tt.raw); err == nil {
				t.Fatal("tdQuoteBody accepted a quote it cannot read")
			} else if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error %q does not mention %q", err, tt.want)
			}
		})
	}
}

func withQuoteVersion(raw []byte, version uint16) []byte {
	out := append([]byte{}, raw...)
	binary.LittleEndian.PutUint16(out[0:2], version)
	return out
}
