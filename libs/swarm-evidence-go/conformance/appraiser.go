package conformance

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// NewAppraiser builds the quote appraiser one profile describes for one case.
//
// There is one EAT implementation in this module, and it is the one a bank
// runs: an "eat" profile configures [swarmevidence.DelegatedQuoteAppraiser]
// out of the manifest — the token format, the issuer, the pinned key and the
// claim mapping — and the corpus then exercises the production JWS check, the
// production claim mapping and the production image-identity derivation.
// Adding a third profile is a change to the vectors; it is not a change to
// any code here, which is the property SUP-648's swap acceptance rests on.
//
// Two things the delegated appraiser needs come from the case rather than
// from the profile, because they are the relying party's configuration and
// not the Verifier's: the signed-measurement registry, which the case states
// by recording whether it vouches for the image, and the relying party's own
// reference values.
func NewAppraiser(
	profile AppraiserProfile, vector CompositeCaseFile, file AppraisalFile, now time.Time,
) (swarmevidence.QuoteAppraiser, error) {
	switch profile.Kind {
	case "recorded":
		return &recordedAppraiser{name: profile.Name, root: file.Root, quote: file.Quote}, nil
	case "eat":
		return newDelegatedAppraiser(profile, vector, file, now)
	default:
		return nil, fmt.Errorf("profile %q has unknown kind %q", profile.Name, profile.Kind)
	}
}

// newDelegatedAppraiser configures the production delegated appraiser from a
// profile.
//
// The membership root's own embedded quote stays with the recorded offline
// appraisal, and that is the architecture rather than a shortcut: the bank's
// Verifier appraises the per-request quote of the evidence collection, and
// the PKI root's quote is part of the membership chain, which is Super
// Swarm-specific and therefore ours to check
// ([swarmevidence.DelegatedQuoteAppraiser.RootAppraiser]).
func newDelegatedAppraiser(
	profile AppraiserProfile, vector CompositeCaseFile, file AppraisalFile, now time.Time,
) (swarmevidence.QuoteAppraiser, error) {
	if profile.VerificationKey == nil {
		return nil, fmt.Errorf("profile %q has no verification key", profile.Name)
	}
	if len(profile.Platforms) == 0 {
		// Coverage is not optional: it is what a case's expectation is
		// written against, and a profile that declared none would be read as
		// "covers nothing" by the generator and as "covers everything" by a
		// reader of the manifest.
		//
		// What it is not is a knob: the coverage the appraiser enforces is
		// the delegated path's own (DelegatedQuoteAppraiser.AppraiseQuote), so
		// a profile declaring *less* than that would still be handed its
		// covered platforms and would deny for want of a recorded token
		// rather than at `coverage`. Modelling a Verifier with a narrower
		// coverage is a change to that appraiser, not to a vector.
		return nil, fmt.Errorf("profile %q declares no platforms", profile.Name)
	}
	tokens, ok := file.EAT[profile.Name]
	if !ok {
		// The profile records nothing for this case at all. An empty token
		// map is how a coverage limit is stated — the appraiser denies before
		// it asks a Verifier anything — so a *missing* entry is a corpus that
		// was not regenerated rather than a statement about coverage.
		return nil, fmt.Errorf("profile %q records no tokens for this case", profile.Name)
	}
	return &swarmevidence.DelegatedQuoteAppraiser{
		AppraiserName: profile.Name,
		Tokens:        &swarmevidence.RecordedTokens{Tokens: tokens.Tokens},
		Token: swarmevidence.TokenVerification{
			Format: swarmevidence.TokenFormat(profile.TokenFormat),
			Issuer: profile.Issuer,
			Keys: &swarmevidence.PinnedKeys{Keys: []swarmevidence.PinnedKey{{
				KeyID: profile.VerificationKey.KID,
				PEM:   profile.VerificationKey.PEM,
			}}},
		},
		Mapping:       profile.ClaimMapping,
		RootAppraiser: &recordedAppraiser{name: profile.Name, root: file.Root, quote: file.Quote},
		Registry: &declaredRegistry{
			signed:   vector.Request.RegistrySignedMeasurements,
			evidence: evidenceTypeOf(file.Quote.Platform),
		},
		ReferenceValues: swarmevidence.ReferenceValues{MrEnclaves: vector.Request.ReferenceValues},
		Now:             func() time.Time { return now },
	}, nil
}

// recordedAppraiser replays the appraisal the fixture records, in the neutral
// spelling. It stands for the offline built-in appraiser: everything the
// corpus pins is downstream of this answer, so holding the answer fixed is
// what makes the rest of the appraisal comparable across paths.
type recordedAppraiser struct {
	name        string
	root, quote RecordedAppraisal
}

func (a *recordedAppraiser) Name() string { return a.name }

func (a *recordedAppraiser) AppraiseRootQuote(
	context.Context, *x509.Certificate,
) (*swarmevidence.QuoteAppraisal, error) {
	return a.root.appraisal()
}

func (a *recordedAppraiser) AppraiseQuote(
	context.Context, swarmevidence.Quote,
) (*swarmevidence.QuoteAppraisal, error) {
	return a.quote.appraisal()
}

// declaredRegistry is the signed-measurement registry the case declares.
//
// The delegated path derives the image identity itself and then asks who
// vouches for it, through the same seam the offline path uses — so the corpus
// has to answer that question, and a case says so rather than an
// implementation deciding it. A registry that holds no signature answers "not
// one of ours", which is a claim a policy decides on and never a failure to
// consult it.
// The evidence type is checked and not ignored. A signature lives in the
// registry folder of the branch it was issued for, so an appraiser that
// looked up the wrong branch would find nothing — and the published registry
// would answer the same way, by 404. A corpus that accepted any branch would
// let that mistake pass as an approval.
type declaredRegistry struct {
	signed   []string
	evidence attestedroot.EvidenceType
}

func (r *declaredRegistry) Verify(
	_ context.Context, mrEnclave []byte, evidence attestedroot.EvidenceType,
) error {
	if evidence != r.evidence {
		return attestedroot.ErrNotInRegistry
	}
	identity := hex.EncodeToString(mrEnclave)
	for _, signature := range r.signed {
		if strings.EqualFold(identity, signature) {
			return nil
		}
	}
	return attestedroot.ErrNotInRegistry
}

// evidenceTypeOf names the registry folder a platform's signatures live in.
// It is an explicit switch rather than a conversion for the usual reason: an
// unknown platform must not silently become a known one.
func evidenceTypeOf(platform swarmevidence.Platform) attestedroot.EvidenceType {
	switch platform {
	case swarmevidence.PlatformSNPQemu:
		return attestedroot.EvidenceSevSnpQemu
	case swarmevidence.PlatformTDXQemu:
		return attestedroot.EvidenceTdxQemu
	case swarmevidence.PlatformTDXGCP:
		return attestedroot.EvidenceTdxGCP
	case swarmevidence.PlatformTDXAzure:
		return attestedroot.EvidenceTdxAzure
	case swarmevidence.PlatformSNPAzure:
		return attestedroot.EvidenceSevSnpAzure
	default:
		return attestedroot.EvidenceUnspecified
	}
}

// appraisal turns the neutral recorded form into what the claim core
// consumes, and keeps the one distinction the seam is about: an appraiser
// that could not reach an answer returns an error, never a populated
// appraisal.
func (r RecordedAppraisal) appraisal() (*swarmevidence.QuoteAppraisal, error) {
	if r.Error != "" {
		return nil, errors.New(r.Error)
	}
	binding, err := hex.DecodeString(r.BindingData)
	if err != nil {
		return nil, fmt.Errorf("the recorded binding data is not hex: %w", err)
	}
	return &swarmevidence.QuoteAppraisal{
		Platform:          r.Platform,
		QuoteVerified:     r.QuoteVerified,
		TCBStatus:         r.TCBStatus,
		CollateralChecked: r.CollateralChecked,
		KeyBinding:        r.KeyBinding,
		NetworkType:       r.NetworkType,
		BindingData:       binding,
		BindingDataSource: r.BindingDataSource,
		Measurements:      r.Measurements,
		PlatformSecurity:  r.PlatformSecurity,
		MrEnclave:         r.MrEnclave,
		MrEnclaveApproved: r.MrEnclaveApproved,
		MrEnclaveSource:   r.MrEnclaveSource,
		SpvmBuild:         r.SpvmBuild,
	}, nil
}
