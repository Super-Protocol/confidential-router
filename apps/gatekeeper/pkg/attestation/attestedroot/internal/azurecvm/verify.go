// Package azurecvm verifies evidence from Azure confidential VMs (Intel TDX
// and AMD SEV-SNP) and computes its mrEnclave. It uses only the standard
// library so it builds for both GOOS=js/GOARCH=wasm and native tools.
//
// Chain of trust:
//
//	Intel/AMD ─signs─► hardware report ─report_data─► HCL runtime data (HCLAkPub, vm-configuration, user-data)
//	Microsoft ─certifies─► AK == HCLAkPub ─signs─► TPM quote (PCR4, PCR9) ◄─replay─ event log
//
// The hardware report is a TDREPORT covered by a TD quote on TDX, and a
// VCEK-signed attestation report on SEV-SNP. Verify checks everything except
// that signature and its certificate chain, which callers must verify
// separately (the TD quote with go-tdx-guest, the SEV-SNP report with the AMD
// verifier). Without that check the result proves nothing.
//
// Provenance: copied verbatim from Super-Protocol/sp-nodejs-addons
// (attestation-wasm/go/azurecvm @ da2d762), the verifier the browser
// extension's WebAssembly build runs. Keeping the two byte-identical is what
// makes the gatekeeper and the extension derive the same mrEnclave from the
// same Azure root; change it upstream first and re-copy.
package azurecvm

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"time"
)

// Evidence mirrors the IntelTDXAzureEvidence and AmdSevSnpAzureEvidence DTOs;
// the AMD certificates of the latter are not needed here.
type Evidence struct {
	HCLReport []byte
	// Quote is the TD quote of TDX evidence. SEV-SNP evidence has none: its
	// hardware report inside HCLReport is signed itself.
	Quote        []byte
	TPMAttest    []byte
	TPMSignature []byte
	EventLog     []byte
	AKCertChain  [][]byte
}

type VMConfiguration struct {
	SecureBoot     bool `json:"secureBoot"`
	TpmEnabled     bool `json:"tpmEnabled"`
	TpmPersisted   bool `json:"tpmPersisted"`
	ConsoleEnabled bool `json:"consoleEnabled"`
	// Reported on TDX only.
	InteractiveConsoleEnabled  *bool `json:"interactiveConsoleEnabled,omitempty"`
	FilteredVpciDevicesAllowed *bool `json:"filteredVpciDevicesAllowed,omitempty"`
	// Reported on SEV-SNP only.
	HardwareSealingPolicy string `json:"hardwareSealingPolicy,omitempty"`
	VMUniqueID            string `json:"vmUniqueId"`
	RootCertThumbprint    string `json:"rootCertThumbprint"`
}

type AKCertificate struct {
	Subject   string    `json:"subject"`
	Issuer    string    `json:"issuer"`
	NotBefore time.Time `json:"notBefore"`
	NotAfter  time.Time `json:"notAfter"`
	// ValidNow reports whether the whole chain is within its validity period
	// at verification time. The chain itself is verified at NotBefore.
	ValidNow bool `json:"validNow"`
}

// AKPublicKey is the HCLAkPub RSA key as it appears in the runtime data JWK.
type AKPublicKey struct {
	N string `json:"n"`
	E string `json:"e"`
}

// TDXFields are policy-relevant values of the TDREPORT.
type TDXFields struct {
	MrTd []byte
	// TdAttributes of the paravisor TD; TdDebug is its DEBUG bit. A debug TD
	// offers no confidentiality: the host can read its memory.
	TdAttributes []byte
	TdDebug      bool
}

// Result holds the verified values. Fields that are not enforced (the TDX and
// SNP policy fields, AKCertificate.ValidNow, VMConfiguration) are left to
// caller policy.
type Result struct {
	Platform Platform
	// ReportData is the 64-byte user-data bound by the HCL report.
	ReportData      []byte
	MrEnclave       []byte
	VMConfiguration VMConfiguration
	AKCertificate   AKCertificate
	// Pcr4 and Pcr9 are replayed from the event log and confirmed by the TPM
	// quote signature.
	Pcr4 []byte
	Pcr9 []byte
	// RuntimeData is the HCL runtime data JSON and AKPublicKey its HCLAkPub,
	// for an online check with Microsoft Azure Attestation.
	RuntimeData []byte
	AKPublicKey AKPublicKey
	// Exactly one of TDX and SNP is set, matching Platform.
	TDX *TDXFields
	SNP *SNPFields
}

// Verify runs every offline check of Azure CVM evidence for the given platform
// and computes mrEnclave. now is used only for AKCertificate.ValidNow. Any
// mismatch is an error.
func Verify(evidence Evidence, platform Platform, now time.Time) (Result, error) {
	report, err := parseHCLReport(evidence.HCLReport, platform)
	if err != nil {
		return Result{}, err
	}

	result := Result{Platform: platform}
	switch platform {
	case PlatformTDX:
		if err := matchQuoteToTDReport(evidence.Quote, report.hwReport); err != nil {
			return Result{}, err
		}
		attributes := tdAttributes(report.hwReport)
		result.TDX = &TDXFields{
			MrTd:         append([]byte{}, mrTd(report.hwReport)...),
			TdAttributes: append([]byte{}, attributes...),
			TdDebug:      attributes[0]&tdAttributesDebug != 0,
		}
	case PlatformSNP:
		if len(evidence.Quote) != 0 {
			return Result{}, fmt.Errorf("SEV-SNP evidence must not carry a TD quote")
		}
		result.SNP = snpFields(report.hwReport)
	}

	userData, err := report.userData()
	if err != nil {
		return Result{}, err
	}
	config := report.runtime.VMConfiguration
	vmConfigFlags, err := config.vmConfigFlags(platform)
	if err != nil {
		return Result{}, err
	}

	leaf, akCertificate, err := verifyAKCertChain(evidence.AKCertChain, now)
	if err != nil {
		return Result{}, err
	}
	akJWK, err := report.key("HCLAkPub")
	if err != nil {
		return Result{}, err
	}
	akKey, err := matchAKPublicKey(leaf, akJWK)
	if err != nil {
		return Result{}, err
	}

	quote, err := parseTPMSAttest(evidence.TPMAttest)
	if err != nil {
		return Result{}, err
	}
	if err := verifyTPMSignature(evidence.TPMAttest, evidence.TPMSignature, akKey); err != nil {
		return Result{}, err
	}
	userDataHash := sha256.Sum256(userData)
	if !bytes.Equal(quote.extraData, userDataHash[:]) {
		return Result{}, fmt.Errorf("TPM quote qualifying data does not match SHA-256 of the HCL user-data")
	}

	events, err := parseEventLog(evidence.EventLog)
	if err != nil {
		return Result{}, err
	}
	pcr4 := replayPCR(events, 4)
	pcr9 := replayPCR(events, 9)
	pcrDigest := sha256.Sum256(append(append([]byte{}, pcr4...), pcr9...))
	if !bytes.Equal(quote.pcrDigest, pcrDigest[:]) {
		return Result{}, fmt.Errorf("event log replay does not match the PCR digest in the TPM quote")
	}

	result.ReportData = userData
	result.MrEnclave = calculateMrEnclave(vmConfigFlags, events)
	result.VMConfiguration = VMConfiguration{
		// vmConfigFlags has checked that the mrEnclave flags are present.
		SecureBoot:                 *config.SecureBoot,
		TpmEnabled:                 *config.TpmEnabled,
		TpmPersisted:               config.TpmPersisted != nil && *config.TpmPersisted,
		ConsoleEnabled:             *config.ConsoleEnabled,
		InteractiveConsoleEnabled:  config.InteractiveConsoleEnabled,
		FilteredVpciDevicesAllowed: config.FilteredVpciDevicesAllowed,
		HardwareSealingPolicy:      config.HardwareSealingPolicy,
		VMUniqueID:                 config.VMUniqueID,
		RootCertThumbprint:         config.RootCertThumbprint,
	}
	result.AKCertificate = akCertificate
	result.Pcr4 = pcr4
	result.Pcr9 = pcr9
	result.RuntimeData = append([]byte{}, report.runtimeData...)
	result.AKPublicKey = AKPublicKey{N: akJWK.N, E: akJWK.E}
	return result, nil
}
