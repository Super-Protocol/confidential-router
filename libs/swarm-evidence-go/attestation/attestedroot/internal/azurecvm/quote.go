package azurecvm

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

const (
	quoteHeaderSize = 48
	// quoteBodySize is the TD quote body of a TDX 1.0 TD. It is the whole body
	// of a v4 quote and of a v5 quote of body type quoteBodyTypeTDX10, and the
	// prefix of the longer TDX 1.5 body.
	quoteBodySize = 584
	// quoteBodySizeTDX15 is the body of a v5 quote of body type
	// quoteBodyTypeTDX15: the TDX 1.0 body plus tee_tcb_svn2 (16) and
	// mrservicetd (48).
	quoteBodySizeTDX15 = 648
	// quoteBodyDescriptorSize is the body type (2 bytes) and body size
	// (4 bytes) a v5 quote carries between the header and the body.
	quoteBodyDescriptorSize = 6
	quoteVersion4           = 4
	quoteVersion5           = 5
	quoteBodyTypeTDX10      = 2
	quoteBodyTypeTDX15      = 3
	quoteTeeTypeTDX         = 0x81
	tdAttributesSize        = 8
	tdxMeasurementLen       = 48
	tdAttributesDebug       = 0x01
)

// quoteField locates the same value in the TD quote body and in TDREPORT.
type quoteField struct {
	name         string
	bodyOffset   int
	reportOffset int
	size         int
}

// TDREPORT: REPORTMACSTRUCT at 0 (report_data at 128), TEE_TCB_INFO at 256,
// TDINFO at 512.
var quoteFields = []quoteField{
	{"tee_tcb_svn", 0, 256 + 8, 16},
	{"mrseam", 16, 256 + 24, 48},
	{"mrsignerseam", 64, 256 + 72, 48},
	{"seam_attributes", 112, 256 + 120, 8},
	{"td_attributes", 120, 512, 8},
	{"xfam", 128, 512 + 8, 8},
	{"mrtd", 136, 512 + 16, 48},
	{"mrconfigid", 184, 512 + 64, 48},
	{"mrowner", 232, 512 + 112, 48},
	{"mrownerconfig", 280, 512 + 160, 48},
	{"rtmrs", 328, 512 + 208, 192},
	{"report_data", 520, tdReportDataOffset, reportDataSize},
}

// tdQuoteBody checks the TD quote header and returns the first quoteBodySize
// bytes of the quote body, which is where every quoteField lives.
//
// Intel issues the same body under two quote formats, and an Azure host emits
// whichever its quoting enclave supports:
//
//	v4: header(48) ‖ body(584) ‖ signature section
//	v5: header(48) ‖ body type(2) ‖ body size(4) ‖ body(584 or 648) ‖ signature section
//
// v5 moved no field inside the body: body type 2 is the v4 body byte for byte,
// and body type 3 (a TDX 1.5 TD) keeps that layout and appends tee_tcb_svn2 and
// mrservicetd. Only the body's offset moves, by the six bytes of the body
// descriptor — so the offsets above hold for every format accepted here. The
// body type is checked rather than inferred so that a body this package cannot
// parse by those offsets (an SGX report, a future TD report) is rejected
// instead of read at the wrong offsets.
func tdQuoteBody(quote []byte) ([]byte, error) {
	if len(quote) < quoteHeaderSize {
		return nil, fmt.Errorf("TD quote has %d bytes, expected at least %d", len(quote), quoteHeaderSize)
	}
	version := binary.LittleEndian.Uint16(quote[0:2])
	if version != quoteVersion4 && version != quoteVersion5 {
		return nil, fmt.Errorf("TD quote version is %d, expected %d or %d", version, quoteVersion4, quoteVersion5)
	}
	if teeType := binary.LittleEndian.Uint32(quote[4:8]); teeType != quoteTeeTypeTDX {
		return nil, fmt.Errorf("TD quote TEE type is %#x, expected TDX (%#x)", teeType, quoteTeeTypeTDX)
	}

	bodyOffset, bodySize := quoteHeaderSize, quoteBodySize
	if version == quoteVersion5 {
		if len(quote) < quoteHeaderSize+quoteBodyDescriptorSize {
			return nil, fmt.Errorf("TD quote has %d bytes, expected at least %d",
				len(quote), quoteHeaderSize+quoteBodyDescriptorSize)
		}
		descriptor := quote[quoteHeaderSize : quoteHeaderSize+quoteBodyDescriptorSize]
		bodyType := binary.LittleEndian.Uint16(descriptor[0:2])
		switch bodyType {
		case quoteBodyTypeTDX10:
			bodySize = quoteBodySize
		case quoteBodyTypeTDX15:
			bodySize = quoteBodySizeTDX15
		default:
			return nil, fmt.Errorf("TD quote body type is %d, expected %d (TDX 1.0) or %d (TDX 1.5)",
				bodyType, quoteBodyTypeTDX10, quoteBodyTypeTDX15)
		}
		// The declared size must be the one the body type prescribes: a quote
		// whose framing disagrees with its own body type is not a quote whose
		// fields can be read by offset.
		if declared := binary.LittleEndian.Uint32(descriptor[2:6]); int(declared) != bodySize {
			return nil, fmt.Errorf("TD quote body of type %d declares %d bytes, expected %d",
				bodyType, declared, bodySize)
		}
		bodyOffset = quoteHeaderSize + quoteBodyDescriptorSize
	}
	if len(quote) < bodyOffset+bodySize {
		return nil, fmt.Errorf("TD quote has %d bytes, expected at least %d", len(quote), bodyOffset+bodySize)
	}
	return quote[bodyOffset : bodyOffset+quoteBodySize], nil
}

// matchQuoteToTDReport checks that the quote was issued for this TDREPORT, so
// that the Intel signature on the quote extends to the HCL runtime data.
//
// The two fields a TDX 1.5 body adds after quoteBodySize are not compared: this
// package reads no value from them, and every value it does report — mrTd,
// tdAttributes and the report_data that carries the binding — is inside the
// compared prefix.
func matchQuoteToTDReport(quote []byte, tdReport []byte) error {
	body, err := tdQuoteBody(quote)
	if err != nil {
		return err
	}
	for _, field := range quoteFields {
		fromQuote := body[field.bodyOffset : field.bodyOffset+field.size]
		fromReport := tdReport[field.reportOffset : field.reportOffset+field.size]
		if !bytes.Equal(fromQuote, fromReport) {
			return fmt.Errorf("TD quote %s does not match the TDREPORT in the HCL report", field.name)
		}
	}
	return nil
}

func tdAttributes(tdReport []byte) []byte {
	return tdReport[512 : 512+tdAttributesSize]
}

func mrTd(tdReport []byte) []byte {
	return tdReport[512+16 : 512+16+tdxMeasurementLen]
}
