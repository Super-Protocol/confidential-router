package swarmevidence

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// QuoteAppraiser appraises the hardware quote a Super Swarm attester enrolled
// with. It is the one leg of the appraisal a relying party may delegate, which
// is why it is an interface and the rest is not: Intel Trust Authority can
// appraise a TD quote's authenticity, and it structurally cannot do anything
// else this module does — replay an RTMR0 event list, normalise it into an
// image identity, validate the PKI chain, or read a control-plane statement.
//
// An implementation must fail closed. Reporting QuoteVerified true on evidence
// it could not check would defeat every claim downstream of it.
type QuoteAppraiser interface {
	// Name identifies the appraiser in the `quote_appraiser` claim, and is
	// what makes the `tcb_status` claim beside it readable.
	Name() string

	// AppraiseRootQuote appraises the TEE evidence a Super Swarm PKI root
	// certificate carries, and the binding between that evidence and the
	// certificate's own public key.
	//
	// It returns an error only when it could not reach an answer — absent or
	// unreadable evidence, a vendor chain that does not check out, collateral
	// it had to consult and could not. A negative answer that a policy should
	// decide on, such as an image nothing vouches for, is a populated
	// QuoteAppraisal with MrEnclaveApproved false.
	AppraiseRootQuote(ctx context.Context, cert *x509.Certificate) (*QuoteAppraisal, error)

	// AppraiseQuote appraises a quote that stands on its own — the composite
	// form's element 1, taken per request, whose guest-chosen field carries
	// the relying party's binding digest instead of a certificate key hash.
	//
	// The same rule about errors applies. In addition the appraisal MUST
	// report BindingData and BindingDataSource: the field the digest is
	// compared against is not the same one on every platform, and an
	// implementation that reported the Azure paravisor's REPORT_DATA as if it
	// were guest-chosen would have the relying party compare against a value
	// no attester can control. Reporting neither denies; reporting the wrong
	// one is the failure this split exists to make impossible to write by
	// accident.
	AppraiseQuote(ctx context.Context, quote Quote) (*QuoteAppraisal, error)
}

// BindingDataSource names which of a platform's fields an appraiser read the
// guest-chosen 64 octets from.
type BindingDataSource string

// The two places a guest-chosen field lives.
const (
	// BindingFromReportData is the quote's own REPORT_DATA / REPORTDATA, on
	// the bare-metal and GCP branches.
	BindingFromReportData BindingDataSource = "report-data"
	// BindingFromHCLUserData is the HCL report's user-data, on both Azure
	// branches: there the hardware report data is the paravisor's
	// SHA-256(runtime data JSON) ‖ 0³² and is not guest-chosen at all
	// (sp-vm/docs/08-azure-attestation.md).
	BindingFromHCLUserData BindingDataSource = "hcl-user-data"
)

// QuoteAppraisal is what a [QuoteAppraiser] established about one attester.
type QuoteAppraisal struct {
	Platform          Platform
	QuoteVerified     bool
	TCBStatus         TCBStatus
	CollateralChecked bool
	// KeyBinding is whether the quote's report data commits to the root
	// certificate's SubjectPublicKeyInfo. It is meaningless for a standalone
	// quote, which commits to a request rather than to a key.
	KeyBinding bool
	// NetworkType is what the root declares about its own network.
	NetworkType NetworkType

	// BindingData is the guest-chosen field the relying party's own binding
	// digest is compared against, and BindingDataSource says which field that
	// is. Both are populated by AppraiseQuote and left empty by
	// AppraiseRootQuote, whose binding is to a key rather than to a request.
	BindingData       []byte
	BindingDataSource BindingDataSource

	Measurements     Measurements
	PlatformSecurity PlatformSecurity

	MrEnclave         string
	MrEnclaveApproved bool
	MrEnclaveSource   MrEnclaveSource
	SpvmBuild         string

	// Logs are the steps the appraiser ran, in order, so a negative answer can
	// be read without re-running it under a debugger.
	Logs []string
}

// BuiltinQuoteAppraiser appraises a quote offline with the CPU vendors' own
// libraries, rebuilds the image identity from published artefacts, and asks
// Super Protocol's signed-measurement registry whether it vouches for the
// result. It is the default, and the only implementation that covers the whole
// fleet: Intel Trust Authority appraises Intel TEEs only, and on either Azure
// branch it cannot appraise the image at all.
type BuiltinQuoteAppraiser struct {
	// Registry decides whether Super Protocol vouches for a measurement.
	// Defaults to the published registry over HTTPS.
	Registry attestedroot.Registry
	// Artifacts resolves sp-vm builds to the firmware a SEV-SNP measurement is
	// rebuilt from. Defaults to the published artefacts over HTTPS.
	Artifacts attestedroot.ArtifactSource
	// ReferenceValues are the image identities the relying party accepts
	// besides the registry-signed ones.
	ReferenceValues ReferenceValues
	// CheckRevocations additionally consults the vendor CRLs. It needs the
	// network, and it is what makes the `tcb_status` claim say anything.
	CheckRevocations bool
	// Now overrides the clock.
	Now func() time.Time

	once     sync.Once
	verifier *attestedroot.Verifier
}

// Name implements [QuoteAppraiser].
func (a *BuiltinQuoteAppraiser) Name() string { return "builtin" }

func (a *BuiltinQuoteAppraiser) inner() *attestedroot.Verifier {
	a.once.Do(func() {
		artifacts := a.Artifacts
		if artifacts == nil {
			// Rebuilding a SEV-SNP measurement downloads a firmware image, so
			// this one gets a generous timeout of its own rather than the
			// default client's none at all.
			artifacts = &attestedroot.HTTPArtifactSource{Client: &http.Client{Timeout: 2 * time.Minute}}
		}
		a.verifier = &attestedroot.Verifier{
			Registry:            a.Registry,
			Artifacts:           artifacts,
			TrustedMeasurements: a.ReferenceValues.MrEnclaves,
			CheckRevocations:    a.CheckRevocations,
			Now:                 a.Now,
		}
	})
	return a.verifier
}

// AppraiseRootQuote implements [QuoteAppraiser].
func (a *BuiltinQuoteAppraiser) AppraiseRootQuote(
	ctx context.Context, cert *x509.Certificate,
) (*QuoteAppraisal, error) {
	result, err := a.inner().Verify(ctx, cert)
	if err != nil {
		return nil, err
	}
	return appraisalFrom(result, true)
}

// AppraiseQuote implements [QuoteAppraiser].
func (a *BuiltinQuoteAppraiser) AppraiseQuote(
	ctx context.Context, quote Quote,
) (*QuoteAppraisal, error) {
	evidence, err := quote.Evidence()
	if err != nil {
		return nil, fmt.Errorf("the quote's evidence is not base64: %w", err)
	}
	result, err := a.inner().VerifyQuote(ctx, evidence)
	if err != nil {
		return nil, err
	}
	appraisal, err := appraisalFrom(result, false)
	if err != nil {
		return nil, err
	}
	appraisal.BindingData = result.ReportData
	appraisal.BindingDataSource = bindingDataSourceOf(result.ReportDataSource)
	return appraisal, nil
}

// appraisalFrom turns an attested-root result into a quote appraisal, and
// decides which of its outcomes is an answer and which is a failure to reach
// one.
//
// The line matters more than it looks. An image nothing has signed yet is a
// *claim*: the hardware held up, and whether to accept an unsigned build is the
// relying party's call. A registry that could not be consulted is a failure:
// admitting the root then would hand anyone who can cut off the registry the
// power to get an unvouched-for image accepted.
func appraisalFrom(result *attestedroot.Result, requireKeyBinding bool) (*QuoteAppraisal, error) {
	if result == nil {
		return nil, errors.New("the quote appraiser returned no result")
	}
	platform, ok := platformOf(result.EvidenceType)
	if !ok {
		// Either the certificate carries no TEE evidence at all or it carries a
		// branch this build does not know. Both mean the same thing to a
		// relying party — nothing here can be appraised — and the attested-root
		// reason says which, so it is passed through rather than paraphrased.
		return nil, errors.New("the root certificate's TEE evidence cannot be appraised: " + result.Reason)
	}

	out := &QuoteAppraisal{
		Platform:          platform,
		QuoteVerified:     result.ReportIntegrity,
		TCBStatus:         tcbStatusOf(result),
		CollateralChecked: result.RevocationChecked,
		KeyBinding:        result.KeyBinding,
		NetworkType:       networkTypeOf(result.NetworkType),
		Measurements:      measurementsOf(result.RawMeasurements),
		PlatformSecurity: PlatformSecurity{
			VMPL:             result.SecurityFields.VMPL,
			DebugAllowed:     result.SecurityFields.DebugAllowed,
			CiphertextHiding: result.SecurityFields.CiphertextHiding,
			PageSwapDisabled: result.SecurityFields.PageSwapDisabled,
			SnpFirmwareTCB:   result.SecurityFields.SnpFirmwareTCB,
			ReportVersion:    result.SecurityFields.ReportVersion,
			CPUGeneration:    result.CPUGeneration,
		},
		MrEnclave: result.MeasurementHex(),
		SpvmBuild: result.Build,
		Logs:      result.Logs,
	}

	switch {
	case !result.ReportIntegrity:
		return nil, errors.New("the hardware quote did not verify: " + result.Reason)
	case requireKeyBinding && !result.KeyBinding:
		return nil, errors.New("the quote does not commit to the root certificate's public key: " + result.Reason)
	case out.MrEnclave == "":
		return nil, errors.New("no image identity could be derived: " + result.Reason)
	case result.Attested:
		out.MrEnclaveApproved = true
		out.MrEnclaveSource = sourceOf(result.MeasurementSource)
	case result.MeasurementUnknown:
		// The registry answered, and the answer was "not one of ours". That is
		// a claim, not a failure.
	default:
		return nil, errors.New("the image identity could not be appraised: " + result.Reason)
	}
	return out, nil
}

func platformOf(evidence attestedroot.EvidenceType) (Platform, bool) {
	switch evidence {
	case attestedroot.EvidenceSevSnpQemu:
		return PlatformSNPQemu, true
	case attestedroot.EvidenceTdxQemu:
		return PlatformTDXQemu, true
	case attestedroot.EvidenceTdxGCP:
		return PlatformTDXGCP, true
	case attestedroot.EvidenceTdxAzure:
		return PlatformTDXAzure, true
	case attestedroot.EvidenceSevSnpAzure:
		return PlatformSNPAzure, true
	default:
		return "", false
	}
}

// tcbStatusOf reports what the collateral check established, and reports
// nothing when it did not run. The built-in appraiser does not fetch collateral
// unless asked to, so "unknown" is the honest default rather than a gap.
func tcbStatusOf(result *attestedroot.Result) TCBStatus {
	switch {
	case !result.RevocationChecked:
		return TCBUnknown
	case result.NotRevoked:
		return TCBOK
	default:
		return TCBRevokedOrIndeterminate
	}
}

// sourceOf renames the anchor in the claim set's vocabulary. The gatekeeper
// calls the second one "operator-pinned" because an operator writes it into a
// config file; a relying party ingesting a CoRIM calls the same thing its
// reference values, and the claim set is written for the second reader.
func sourceOf(source attestedroot.MeasurementSource) MrEnclaveSource {
	if source == attestedroot.SourceRegistry {
		return SourceRegistry
	}
	return SourceReferenceValues
}

// networkTypeOf publishes the root's declared network class by an explicit
// switch rather than a string conversion, for the same reason
// channelBindingOf does: the claim set publishes a closed set, and a value the
// schema does not list would make a conforming validator reject our own
// output. A root that declares nothing reports nothing.
func networkTypeOf(network attestedroot.NetworkType) NetworkType {
	switch network {
	case attestedroot.NetworkTrusted:
		return NetworkTrusted
	case attestedroot.NetworkUntrusted:
		return NetworkUntrusted
	default:
		return ""
	}
}

func measurementsOf(raw attestedroot.RawMeasurements) Measurements {
	return Measurements{
		TDAttributes: raw.TDAttributes,
		MRTD:         raw.MRTD,
		RTMR0:        raw.RTMR0,
		RTMR1:        raw.RTMR1,
		RTMR2:        raw.RTMR2,
		RTMR3:        raw.RTMR3,
		LaunchDigest: raw.LaunchDigest,
	}
}
