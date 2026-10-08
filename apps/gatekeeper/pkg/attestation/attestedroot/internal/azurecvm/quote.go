package azurecvm

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

const (
	quoteHeaderSize   = 48
	quoteBodySize     = 584
	quoteVersion4     = 4
	quoteTeeTypeTDX   = 0x81
	tdAttributesSize  = 8
	tdxMeasurementLen = 48
	tdAttributesDebug = 0x01
)

// quoteField locates the same value in the TD quote v4 body and in TDREPORT.
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

// matchQuoteToTDReport checks that the quote was issued for this TDREPORT, so
// that the Intel signature on the quote extends to the HCL runtime data.
func matchQuoteToTDReport(quote []byte, tdReport []byte) error {
	if len(quote) < quoteHeaderSize+quoteBodySize {
		return fmt.Errorf("TD quote has %d bytes, expected at least %d", len(quote), quoteHeaderSize+quoteBodySize)
	}
	if version := binary.LittleEndian.Uint16(quote[0:2]); version != quoteVersion4 {
		return fmt.Errorf("TD quote version is %d, expected %d", version, quoteVersion4)
	}
	if teeType := binary.LittleEndian.Uint32(quote[4:8]); teeType != quoteTeeTypeTDX {
		return fmt.Errorf("TD quote TEE type is %#x, expected TDX (%#x)", teeType, quoteTeeTypeTDX)
	}

	body := quote[quoteHeaderSize : quoteHeaderSize+quoteBodySize]
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
