package attestedroot

import (
	"errors"
	"fmt"

	tdxverify "github.com/google/go-tdx-guest/verify"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot/internal/azurecvm"
)

// verifyAzure runs the hardware half of an Azure confidential-VM root.
//
// An Azure CVM is attested in two layers, and both must hold:
//
//  1. the hardware report — a SEV-SNP report signed through AMD's chain, or a
//     TDREPORT covered by an Intel-signed TD quote — whose reportData commits
//     to the paravisor's runtime data (the vTPM key, the VM configuration and
//     the enrolling CA's user-data);
//  2. the vTPM: Microsoft certifies the attestation key named in that runtime
//     data, the key signs a quote over PCR4 and PCR9 bound to the same
//     user-data, and the firmware event log replays to those PCRs.
//
// azurecvm checks layer 2 and every binding between the two; the hardware
// signature of layer 1 is checked here with the same vendor libraries the QEMU
// branches use. The measurement is azurecvm's mrEnclave —
// SHA-256(vm-config flags ‖ PCR4′ ‖ PCR9′), the image's boot chain — because on
// Azure the hardware measurement is Microsoft's paravisor, not the image.
//
// Microsoft Azure Attestation, which the browser extension additionally asks,
// is an online service and is not consulted: this check stays offline, the
// same rule the QEMU branches follow for collateral.
func (v *Verifier) verifyAzure(ev *AzureEvidence, kind EvidenceType, ext *RootExtensions, out *Result) error {
	platform := azurecvm.PlatformSNP
	if kind == EvidenceTdxAzure {
		platform = azurecvm.PlatformTDX
	}

	cvm, err := azurecvm.Verify(azurecvm.Evidence{
		HCLReport:    ev.HCLReport,
		Quote:        ev.Quote,
		TPMAttest:    ev.TPMAttest,
		TPMSignature: ev.TPMSignature,
		EventLog:     ev.EventLog,
		AKCertChain:  ev.AKCertChain,
	}, platform, v.clock())
	if err != nil {
		return fmt.Errorf("azure %s evidence: %w", platform, err)
	}
	out.logf("vTPM quote verified against Microsoft's attestation key chain (%s); PCR4 and PCR9 replay from the event log",
		cvm.AKCertificate.Subject)

	switch platform {
	case azurecvm.PlatformSNP:
		if cvm.SNP == nil {
			return errors.New("azure SEV-SNP evidence: no SEV-SNP report in the HCL report")
		}
		if _, err := v.verifySnpReport(cvm.SNP.Report, ev.Certs, out); err != nil {
			return err
		}
	case azurecvm.PlatformTDX:
		if err := v.verifyTdxQuote(ev.Quote, out); err != nil {
			return err
		}
	}

	// The CA's key is bound through the HCL user-data, which both the hardware
	// report (via the runtime data hash) and the vTPM quote commit to.
	out.ReportData = cvm.ReportData
	out.KeyBinding = BindsPublicKey(out.ReportData, ext.SPKIDigest)
	if !out.KeyBinding {
		return fmt.Errorf(
			"the HCL report's user-data does not commit to this certificate's public key (SHA-256 %x)", ext.SPKIDigest)
	}

	out.Measurement = cvm.MrEnclave
	return nil
}

// verifyTdxQuote checks a TD quote's signature and Intel chain, offline, and
// records integrity and the optional revocation check on out. Shared by the
// QEMU and Azure TDX branches.
func (v *Verifier) verifyTdxQuote(quote []byte, out *Result) error {
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
	if err := tdxverify.RawTdxQuote(quote, options); err != nil {
		return fmt.Errorf("tdx quote: %w", err)
	}
	out.ReportIntegrity = true
	if v.CheckRevocations {
		out.RevocationChecked, out.NotRevoked = v.tdxRevocation(quote)
	}
	return nil
}
