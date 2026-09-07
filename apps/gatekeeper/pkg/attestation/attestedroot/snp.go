package attestedroot

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"

	"github.com/google/go-sev-guest/abi"
	"github.com/google/go-sev-guest/kds"
	spb "github.com/google/go-sev-guest/proto/sevsnp"
	"github.com/google/go-sev-guest/verify"
	sevtrust "github.com/google/go-sev-guest/verify/trust"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot/internal/snpmeasure"
)

// Guest-policy bits the platform surfaces. AMD assigns them in the SNP ABI's
// GUEST_POLICY field; go-sev-guest exposes DEBUG but not the two newer ones, so
// all three are read here from one place.
const (
	policyBitDebug            = 19
	policyBitCiphertextHiding = 24
	policyBitPageSwapDisabled = 25
)

// verifySevSnp runs the hardware half of a SEV-SNP attested root: the report's
// signature and certificate chain, the binding to the certificate's key, and
// the normalised measurement.
//
// Everything that can be decided offline is decided before anything is
// fetched, so a root that fails on its own evidence never causes a download.
func (v *Verifier) verifySevSnp(ctx context.Context, ev *SevSnpEvidence, ext *RootExtensions, out *Result) error {
	report, err := abi.ReportToProto(ev.RawReport)
	if err != nil {
		return fmt.Errorf("attestation report: %w", err)
	}

	out.ReportData = report.GetReportData()
	out.KeyBinding = BindsPublicKey(out.ReportData, ext.SPKIDigest)
	out.SecurityFields = securityFieldsOf(report)

	chain := &spb.CertificateChain{
		ArkCert:  derOf(ev.Certs[CertARK]),
		AskCert:  derOf(ev.Certs[CertASK]),
		VcekCert: derOf(ev.Certs[CertVCEK]),
	}
	if len(chain.ArkCert) == 0 || len(chain.AskCert) == 0 || len(chain.VcekCert) == 0 {
		return errors.New("attestation report: the evidence does not carry the full ARK/ASK/VCEK chain")
	}
	attestation := &spb.Attestation{Report: report, CertificateChain: chain}

	// TrustedRoots is left nil so go-sev-guest requires the supplied ARK to be
	// one of AMD's built-in roots — the trust anchor of the whole check.
	// Certificate fetching is disabled: everything needed is in the evidence,
	// and a verifier that reaches out to AMD to fill a gap would turn a
	// producer's omission into a network dependency.
	options := &verify.Options{DisableCertFetching: true, Now: v.clock()}
	if err := verify.SnpAttestation(attestation, options); err != nil {
		return fmt.Errorf("attestation report: %w", err)
	}
	out.ReportIntegrity = true
	out.CPUGeneration = productLineOf(chain.VcekCert)

	// Revocation is the one check that needs the network, and it is not part of
	// report integrity: a CRL that cannot be fetched leaves the status unknown
	// rather than turning a sound report into a bad one.
	if v.CheckRevocations {
		revoked := &verify.Options{
			DisableCertFetching: true,
			CheckRevocations:    true,
			Now:                 v.clock(),
			Getter:              v.getter(),
		}
		ok := verify.SnpAttestation(attestation, revoked) == nil
		out.RevocationChecked, out.NotRevoked = true, ok
	}

	if !out.KeyBinding {
		return fmt.Errorf(
			"the report's reportData does not commit to this certificate's public key (SHA-256 %x)", ext.SPKIDigest)
	}

	measurement, err := v.snpMeasurement(ctx, ev, report)
	if err != nil {
		return err
	}
	out.Measurement = measurement
	return nil
}

// snpMeasurement rebuilds the VM's launch digest from published artefacts and
// normalises it (sp-vm/docs/04-vm-measurements.md §"AMD SEV-SNP").
func (v *Verifier) snpMeasurement(ctx context.Context, ev *SevSnpEvidence, report *spb.Report) ([]byte, error) {
	if len(ev.CmdLineHash) != 32 {
		return nil, fmt.Errorf("evidence: cmdLineHash is %d bytes, expected 32", len(ev.CmdLineHash))
	}
	artifacts, err := v.artifacts().Artifacts(ctx, ev.Build)
	if err != nil {
		return nil, err
	}

	hashes := snpmeasure.Hashes{Kernel: artifacts.KernelHash, Initrd: artifacts.InitrdHash}
	copy(hashes.Cmdline[:], ev.CmdLineHash)

	return snpmeasure.Normalize(artifacts.Firmware, hashes, snpmeasure.Report{
		Measurement: report.GetMeasurement(),
		CPUSig:      ev.CPUSig,
		Cores:       ev.Cores,
		Build:       ev.Build,
	})
}

// securityFieldsOf lifts the report fields an operator polices out of the
// report. They are reported, never enforced here: which combination is
// acceptable is a policy question, and Rego is where it is answered.
func securityFieldsOf(report *spb.Report) SecurityFields {
	policy := report.GetPolicy()
	return SecurityFields{
		VMPL:             report.GetVmpl(),
		DebugAllowed:     policy&(1<<policyBitDebug) != 0,
		CiphertextHiding: policy&(1<<policyBitCiphertextHiding) != 0,
		PageSwapDisabled: policy&(1<<policyBitPageSwapDisabled) != 0,
		SnpFirmwareTCB:   kds.DecomposeTCBVersion(kds.TCBVersion(report.GetLaunchTcb())).SnpSpl,
		ReportVersion:    report.GetVersion(),
	}
}

// productLineOf names the AMD CPU generation of a verified chain, e.g. "Genoa".
//
// It reads the VCEK's product-name extension rather than the report's own
// CPUID fields: the chain check has already tied that certificate to a built-in
// AMD root, so it is the one statement about the CPU that something outside the
// VM vouches for. An unreadable extension costs a label, not a verdict.
func productLineOf(vcekDER []byte) string {
	cert, err := x509.ParseCertificate(vcekDER)
	if err != nil {
		return ""
	}
	extensions, err := kds.VcekCertificateExtensions(cert)
	if err != nil || extensions.ProductName == "" {
		return ""
	}
	return kds.ProductLineOfProductName(extensions.ProductName)
}

// derOf accepts a certificate in either encoding the evidence schema allows.
func derOf(cert []byte) []byte {
	if block, _ := pem.Decode(cert); block != nil && block.Type == "CERTIFICATE" {
		return block.Bytes
	}
	return cert
}

// getter returns the HTTP getter revocation checks use.
func (v *Verifier) getter() sevtrust.HTTPSGetter {
	if v.HTTPGetter != nil {
		return v.HTTPGetter
	}
	return sevtrust.DefaultHTTPSGetter()
}
