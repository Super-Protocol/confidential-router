package azurecvm

import (
	"encoding/binary"
	"fmt"
)

// Platform is the confidential-computing technology of an Azure CVM. Both run
// the same Microsoft paravisor and vTPM; they differ in the hardware report
// embedded in the HCL report and in how that report is signed.
type Platform int

const (
	PlatformTDX Platform = iota + 1
	PlatformSNP
)

const (
	igvmReportTypeSNP = 2
	igvmReportTypeTDX = 4

	tdReportSize       = 1024
	tdReportTypeTDX    = 0x81
	tdReportDataOffset = 128

	snpReportSize             = 1184
	snpReportDataOffset       = 0x50
	snpMinReportVersion       = 2
	snpSignatureAlgoECDSAP384 = 1
)

func (p Platform) String() string {
	switch p {
	case PlatformTDX:
		return "TDX"
	case PlatformSNP:
		return "SEV-SNP"
	default:
		return fmt.Sprintf("Platform(%d)", int(p))
	}
}

func (p Platform) igvmReportType() uint32 {
	switch p {
	case PlatformTDX:
		return igvmReportTypeTDX
	case PlatformSNP:
		return igvmReportTypeSNP
	default:
		return 0
	}
}

func (p Platform) hwReportName() string {
	if p == PlatformSNP {
		return "SEV-SNP report"
	}
	return "TDREPORT"
}

func (p Platform) hwReportSize() int {
	if p == PlatformSNP {
		return snpReportSize
	}
	return tdReportSize
}

func (p Platform) reportDataOffset() int {
	if p == PlatformSNP {
		return snpReportDataOffset
	}
	return tdReportDataOffset
}

func (p Platform) checkHwReport(report []byte) error {
	switch p {
	case PlatformTDX:
		if report[0] != tdReportTypeTDX {
			return fmt.Errorf("TDREPORT type is %#x, expected TDX (%#x)", report[0], tdReportTypeTDX)
		}
	case PlatformSNP:
		if version := binary.LittleEndian.Uint32(report[0:4]); version < snpMinReportVersion {
			return fmt.Errorf("SEV-SNP report version is %d, expected at least %d", version, snpMinReportVersion)
		}
		if algo := binary.LittleEndian.Uint32(report[0x34:0x38]); algo != snpSignatureAlgoECDSAP384 {
			return fmt.Errorf("SEV-SNP report signature algorithm is %d, expected ECDSA P-384 (%d)", algo, snpSignatureAlgoECDSAP384)
		}
	default:
		return fmt.Errorf("unsupported platform %s", p)
	}
	return nil
}

// vmConfigFlags lists the vm-configuration flags that feed mrEnclave. The
// SEV-SNP paravisor does not report the last two TDX flags, so mrEnclave
// differs between platforms even for the same image.
func (p Platform) vmConfigFlags() []vmConfigFlag {
	if p == PlatformSNP {
		return []vmConfigFlag{flagSecureBoot, flagTpmEnabled, flagConsoleEnabled}
	}
	return []vmConfigFlag{flagSecureBoot, flagTpmEnabled, flagConsoleEnabled, flagInteractiveConsole, flagFilteredVpci}
}
