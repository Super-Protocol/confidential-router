package verifier

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// AttestedRootVerifier is the seam the attested-root anchor is plugged in
// through, so a test — and the offline demo — can supply a verdict without a
// firmware download.
type AttestedRootVerifier interface {
	Verify(ctx context.Context, cert *x509.Certificate) (*attestedroot.Result, error)
}

// newAttestedRootVerifier builds the real one from a config, or nil when the
// anchor is off.
func newAttestedRootVerifier(cfg *config.Config) AttestedRootVerifier {
	if cfg == nil || !cfg.AttestedRootsEnabled() {
		return nil
	}
	return &attestedroot.Verifier{
		Registry:         &attestedroot.HTTPRegistry{BaseURL: cfg.AttestedRootsRegistryBaseURL()},
		Artifacts:        &attestedroot.HTTPArtifactSource{Client: &http.Client{Timeout: 2 * time.Minute}},
		CacheTTL:         cfg.AttestedRootsCacheTTL(),
		CheckRevocations: cfg.AttestedRootsCheckRevocations(),
	}
}

// attestRoot decides whether the chain's terminal certificate may be trusted on
// its own TEE evidence, and records what it found on the report.
//
// It is only ever reached for a chain that has already *validated* and failed
// only on membership of the manual store — the same precondition that gates the
// dashboard's "add this root" affordance. Before that point `certChain` is an
// attacker-controlled array whose last element is a root in name only.
//
// The returned root is nil when the certificate is not attested, including when
// the check could not be completed; the caller then falls through to today's
// untrusted-root denial with the reason appended.
func (v *Verifier) attestRoot(ctx context.Context, report *status.Report) *attestation.TrustedRoot {
	if v.attested == nil || report.UntrustedRootPEM == "" {
		return nil
	}
	block, _ := pem.Decode([]byte(report.UntrustedRootPEM))
	if block == nil {
		return nil
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		// A root on a curve crypto/x509 does not know cannot be a Super Swarm
		// one: the platform issues RSA and P-256 CAs.
		return nil
	}

	result, err := v.attested.Verify(ctx, cert)
	if err != nil || result == nil {
		return nil
	}
	report.AttestedRoot = toStatusAttestedRoot(result)

	if !result.Attested {
		return nil
	}
	// The network type is the platform's own trusted/untrusted network split,
	// not a judgement about the CA, and the live Swarm stand's root declares
	// `untrusted`. Rejecting it by default would make the anchor useless
	// exactly where it is needed, so the declaration is surfaced and only
	// enforced when the operator asks for it.
	if v.cfg.AttestedRootsRequireNetworkType() == config.NetworkTypeTrusted &&
		result.NetworkType != attestedroot.NetworkTrusted {
		report.AttestedRoot.Attested = false
		report.AttestedRoot.Reason = "the root declares network type " +
			quoteOrNone(string(result.NetworkType)) + ", and attestedRoots.requireNetworkType is \"trusted\""
		return nil
	}

	return &attestation.TrustedRoot{
		Name: attestedRootName(result),
		PEM:  report.UntrustedRootPEM,
	}
}

// attestedRootName is what the verdict line calls a root nobody named. The
// measurement is in it because that is the thing an operator compares against
// the registry, and it is what makes two Swarm clouds distinguishable.
func attestedRootName(result *attestedroot.Result) string {
	return "attested:" + result.MeasurementHex()
}

func toStatusAttestedRoot(result *attestedroot.Result) *status.AttestedRoot {
	return &status.AttestedRoot{
		Attested:          result.Attested,
		Reason:            result.Reason,
		EvidenceType:      result.EvidenceTypeName,
		NetworkType:       string(result.NetworkType),
		ReportIntegrity:   result.ReportIntegrity,
		RevocationChecked: result.RevocationChecked,
		NotRevoked:        result.NotRevoked,
		CPUGeneration:     result.CPUGeneration,
		KeyBinding:        result.KeyBinding,
		KeyDigest:         result.SPKIDigestHex(),
		Measurement:       result.MeasurementHex(),
		InRegistry:        result.InRegistry,
		VMPL:              result.SecurityFields.VMPL,
		DebugAllowed:      result.SecurityFields.DebugAllowed,
		CiphertextHiding:  result.SecurityFields.CiphertextHiding,
		PageSwapDisabled:  result.SecurityFields.PageSwapDisabled,
		SnpFirmwareTCB:    result.SecurityFields.SnpFirmwareTCB,
		ReportVersion:     result.SecurityFields.ReportVersion,
		Logs:              result.Logs,
	}
}

func quoteOrNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return `"` + s + `"`
}
