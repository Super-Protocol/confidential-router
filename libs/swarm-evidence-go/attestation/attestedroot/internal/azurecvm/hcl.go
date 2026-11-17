package azurecvm

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// HCL report layout, as read from vTPM NV index 0x01400001 on an Azure CVM:
//
//	[0:32]      header: "HCLA", version, report size, request type, status, reserved
//	[32:1216]   hardware report area, sized for the largest report: a SEV-SNP
//	            attestation report fills it, a TDX TDREPORT uses the first 1024 bytes
//	[1216:1236] runtime data header: data size, version, report type, hash type, length
//	[1236:...]  runtime data JSON; the hardware report's report_data is
//	            SHA-256(JSON) ‖ 32 zero bytes
const (
	hclHeaderSize       = 32
	hclHwReportAreaSize = 1184
	runtimeHeaderOffset = hclHeaderSize + hclHwReportAreaSize
	runtimeHeaderSize   = 20
	runtimeDataOffset   = runtimeHeaderOffset + runtimeHeaderSize
	igvmHashTypeSHA256  = 1
	reportDataSize      = 64
	userDataSize        = 64
)

var hclMagic = []byte("HCLA")

type hclReport struct {
	platform    Platform
	hwReport    []byte
	runtimeData []byte
	runtime     runtimeData
}

type runtimeData struct {
	Keys            []jwk           `json:"keys"`
	VMConfiguration vmConfiguration `json:"vm-configuration"`
	UserData        string          `json:"user-data"`
}

type jwk struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// Pointers distinguish a missing key from false: every flag that feeds
// mrEnclave must be present. Which keys exist depends on the platform: the
// SEV-SNP paravisor reports neither interactive-console-enabled nor
// filtered-vpci-devices-allowed.
type vmConfiguration struct {
	RootCertThumbprint         string `json:"root-cert-thumbprint"`
	ConsoleEnabled             *bool  `json:"console-enabled"`
	InteractiveConsoleEnabled  *bool  `json:"interactive-console-enabled"`
	SecureBoot                 *bool  `json:"secure-boot"`
	TpmEnabled                 *bool  `json:"tpm-enabled"`
	TpmPersisted               *bool  `json:"tpm-persisted"`
	FilteredVpciDevicesAllowed *bool  `json:"filtered-vpci-devices-allowed"`
	HardwareSealingPolicy      string `json:"hardware-sealing-policy"`
	VMUniqueID                 string `json:"vmUniqueId"`
}

func parseHCLReport(raw []byte, want Platform) (hclReport, error) {
	if len(raw) < runtimeDataOffset {
		return hclReport{}, fmt.Errorf("HCL report has %d bytes, expected at least %d", len(raw), runtimeDataOffset)
	}
	if !bytes.Equal(raw[:4], hclMagic) {
		return hclReport{}, fmt.Errorf("HCL report has invalid magic %x", raw[:4])
	}

	header := raw[runtimeHeaderOffset:runtimeDataOffset]
	dataSize := binary.LittleEndian.Uint32(header[0:4])
	reportType := binary.LittleEndian.Uint32(header[8:12])
	hashType := binary.LittleEndian.Uint32(header[12:16])
	runtimeSize := binary.LittleEndian.Uint32(header[16:20])
	// The platform must be the one the evidence type claims: otherwise the
	// platform signature checked by the caller would not cover this report.
	if reportType != want.igvmReportType() {
		return hclReport{}, fmt.Errorf("HCL report type is %d, expected %s (%d)", reportType, want, want.igvmReportType())
	}
	if hashType != igvmHashTypeSHA256 {
		return hclReport{}, fmt.Errorf("HCL report data hash type is %d, expected SHA-256 (%d)", hashType, igvmHashTypeSHA256)
	}
	if uint64(dataSize) != uint64(runtimeHeaderSize)+uint64(runtimeSize) {
		return hclReport{}, fmt.Errorf("HCL runtime data size %d does not match header size %d", runtimeSize, dataSize)
	}
	if uint64(runtimeDataOffset)+uint64(runtimeSize) > uint64(len(raw)) {
		return hclReport{}, fmt.Errorf("HCL runtime data of %d bytes exceeds the report", runtimeSize)
	}
	// The NV index is larger than the report; bytes after report size are padding.
	if reportSize := binary.LittleEndian.Uint32(raw[8:12]); uint64(reportSize) != uint64(runtimeDataOffset)+uint64(runtimeSize) {
		return hclReport{}, fmt.Errorf("HCL report size %d does not match its runtime data", reportSize)
	}

	report := hclReport{
		platform:    want,
		hwReport:    raw[hclHeaderSize : hclHeaderSize+want.hwReportSize()],
		runtimeData: raw[runtimeDataOffset : runtimeDataOffset+int(runtimeSize)],
	}
	if err := want.checkHwReport(report.hwReport); err != nil {
		return hclReport{}, err
	}

	reportData := report.reportData()
	runtimeHash := sha256.Sum256(report.runtimeData)
	if !bytes.Equal(reportData[:sha256.Size], runtimeHash[:]) {
		return hclReport{}, fmt.Errorf("%s report_data does not match SHA-256 of HCL runtime data", want.hwReportName())
	}
	if !bytes.Equal(reportData[sha256.Size:], make([]byte, reportDataSize-sha256.Size)) {
		return hclReport{}, fmt.Errorf("%s report_data has non-zero bytes after the runtime data hash", want.hwReportName())
	}

	if err := json.Unmarshal(report.runtimeData, &report.runtime); err != nil {
		return hclReport{}, fmt.Errorf("HCL runtime data is not valid JSON: %w", err)
	}
	return report, nil
}

func (r hclReport) reportData() []byte {
	offset := r.platform.reportDataOffset()
	return r.hwReport[offset : offset+reportDataSize]
}

func (r hclReport) userData() ([]byte, error) {
	userData, err := hex.DecodeString(r.runtime.UserData)
	if err != nil {
		return nil, fmt.Errorf("HCL runtime user-data is not valid hex: %w", err)
	}
	if len(userData) != userDataSize {
		return nil, fmt.Errorf("HCL runtime user-data has %d bytes, expected %d", len(userData), userDataSize)
	}
	return userData, nil
}

func (r hclReport) key(kid string) (jwk, error) {
	var found []jwk
	for _, key := range r.runtime.Keys {
		if key.Kid == kid {
			found = append(found, key)
		}
	}
	if len(found) != 1 {
		return jwk{}, fmt.Errorf("HCL runtime data has %d keys with kid %q, expected 1", len(found), kid)
	}
	return found[0], nil
}

type vmConfigFlag struct {
	name  string
	value func(c vmConfiguration) *bool
}

var (
	flagSecureBoot         = vmConfigFlag{"secure-boot", func(c vmConfiguration) *bool { return c.SecureBoot }}
	flagTpmEnabled         = vmConfigFlag{"tpm-enabled", func(c vmConfiguration) *bool { return c.TpmEnabled }}
	flagConsoleEnabled     = vmConfigFlag{"console-enabled", func(c vmConfiguration) *bool { return c.ConsoleEnabled }}
	flagInteractiveConsole = vmConfigFlag{"interactive-console-enabled", func(c vmConfiguration) *bool { return c.InteractiveConsoleEnabled }}
	flagFilteredVpci       = vmConfigFlag{"filtered-vpci-devices-allowed", func(c vmConfiguration) *bool { return c.FilteredVpciDevicesAllowed }}
)

// vmConfigFlags returns the VM configuration flags that feed mrEnclave, one
// byte (0 or 1) each, in the platform's fixed order.
func (c vmConfiguration) vmConfigFlags(platform Platform) ([]byte, error) {
	fields := platform.vmConfigFlags()
	flags := make([]byte, 0, len(fields))
	for _, field := range fields {
		value := field.value(c)
		if value == nil {
			return nil, fmt.Errorf("HCL vm-configuration is missing %q", field.name)
		}
		if *value {
			flags = append(flags, 1)
		} else {
			flags = append(flags, 0)
		}
	}
	return flags, nil
}
