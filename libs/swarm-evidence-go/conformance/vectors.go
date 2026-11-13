package conformance

import (
	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// CompositeVectorsDir is where the composite-evidence corpus lives, relative
// to the repository root. It sits beside the bundle corpus rather than inside
// either Go module, because the vectors are the contract for three consumers —
// the TypeScript libs/attestation, the gatekeeper and this module — and an
// embed directive cannot reach outside its own package directory.
const CompositeVectorsDir = VectorsDir + "/composite"

// CompositeManifest is `composite/manifest.json`: the appraiser profiles and
// the cases.
type CompositeManifest struct {
	Version     string `json:"version"`
	Description string `json:"description"`
	Generator   string `json:"generator"`
	// ReferenceNow is the instant every certificate validity window is
	// centred on.
	ReferenceNow string `json:"referenceNow"`
	// RootsFile is the trust anchors file, relative to `vectors/`.
	RootsFile string `json:"rootsFile"`
	// Appraisers are the quote appraisers every case is replayed through.
	Appraisers []AppraiserProfile  `json:"appraisers"`
	Cases      []CompositeCaseFile `json:"cases"`
}

// AppraiserProfile configures one quote appraiser the corpus is replayed
// through.
//
// Everything a delegated appraiser needs is here and nothing is in code: the
// token format, the issuer, the verification key, the claim names and the
// octet encoding. That is the swap acceptance of SUP-648 stated as data — two
// profiles that differ in all of them appraise the same cases into the same
// claims, and neither is named anywhere in an implementation.
type AppraiserProfile struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Kind is "recorded" — the appraisal read straight out of the fixture,
	// standing for the offline built-in appraiser — or "eat", which reads it
	// out of a signed Entity Attestation Token.
	Kind string `json:"kind"`

	// TokenFormat, Issuer and VerificationKey apply to the "eat" kind.
	TokenFormat     string  `json:"tokenFormat,omitempty"`
	Issuer          string  `json:"issuer,omitempty"`
	VerificationKey *EATKey `json:"verificationKey,omitempty"`
	// OctetEncoding is how octet-valued claims are spelled in this profile's
	// tokens: "hex" or "base64url". Verifiers disagree about this, and a
	// corpus in which both spellings appraise identically is what shows the
	// disagreement is configuration.
	OctetEncoding string `json:"octetEncoding,omitempty"`
	// ClaimNames maps each logical appraisal field to this profile's claim
	// path, dotted for nested claims.
	ClaimNames map[string]string `json:"claimNames,omitempty"`

	// Platforms are the attester platforms this appraiser covers. A case
	// whose quote is outside them records no token for this profile, and the
	// appraiser refuses with OutsideCoverage — the honest coverage of a
	// stand-in Verifier, asserted rather than documented.
	Platforms       []string         `json:"platforms,omitempty"`
	OutsideCoverage *CoverageRefusal `json:"outsideCoverage,omitempty"`
}

// CoverageRefusal is what an appraiser answers for evidence it structurally
// cannot appraise. It is a typed denial, never a partial verdict.
type CoverageRefusal struct {
	Stage  string `json:"stage"`
	Reason string `json:"reason"`
}

// EATKey is a pinned verification key.
type EATKey struct {
	KID string `json:"kid"`
	PEM string `json:"pem"`
}

// CompositeCaseFile is one case of the composite manifest.
type CompositeCaseFile struct {
	ID          string           `json:"id"`
	Description string           `json:"description"`
	Request     CompositeRequest `json:"request"`
	// EvidenceFile is the CMW collection presented to the appraisal, relative
	// to `vectors/`; AppraisalFile is the recorded quote appraisal, in the
	// neutral form and in each profile's token spelling.
	EvidenceFile  string          `json:"evidenceFile"`
	AppraisalFile string          `json:"appraisalFile"`
	Expect        CompositeExpect `json:"expect"`
}

// CompositeRequest is what the relying party is holding when it appraises:
// the three values the binding digest commits to, the pinned roots, its own
// reference values and its clock.
type CompositeRequest struct {
	// FreshnessInput is hex; Target and Subject are unpadded base64url. All
	// three are the octets the attester was given, verbatim.
	FreshnessInput string   `json:"freshnessInput"`
	Target         string   `json:"target"`
	Subject        string   `json:"subject"`
	TrustedRoots   []string `json:"trustedRoots"`
	Now            string   `json:"now"`
	// MaxEvidenceAge is in milliseconds; absent disables the check.
	MaxEvidenceAge  *int64   `json:"maxEvidenceAge,omitempty"`
	ReferenceValues []string `json:"referenceValues,omitempty"`
}

// CompositeExpect is the verdict and the claim set a case pins.
//
// `claims` is the whole document, compared member by member — the acceptance
// this corpus exists for. Two members are not compared literally:
// `quote_appraiser` is written as the placeholder "<appraiser>" and resolves
// to the profile under test, and `denial.reason` is dropped before the
// comparison, because only `stage` and `reasonContains` are normative here as
// everywhere else in this corpus.
type CompositeExpect struct {
	OK             bool           `json:"ok"`
	Stage          string         `json:"stage,omitempty"`
	ReasonContains string         `json:"reasonContains,omitempty"`
	Claims         map[string]any `json:"claims"`
	// Appraisers overrides the expectation for the named profiles. An absent
	// entry means the profile must reach exactly the expectation above —
	// which is the whole point: the claim set is the appraiser's, and
	// swapping appraisers may not change it.
	Appraisers map[string]*CompositeExpect `json:"appraisers,omitempty"`
}

// AppraiserPlaceholder is what a case writes where the running appraiser's
// own name belongs.
const AppraiserPlaceholder = "<appraiser>"

// AppraisalFile is one case's recorded quote appraisal: the membership root's
// own quote, the per-request quote, and the same two facts re-encoded as a
// token per EAT profile.
//
// Recording the appraisal rather than a hardware quote is deliberate and is
// the corpus's one documented limit: no fixture can carry a TDX or SEV-SNP
// signature over a request this repository invented, so what the corpus pins
// is everything downstream of the quote appraisal — the binding, the chain,
// the envelope, the statement and the claim set — against a quote appraisal
// that is held fixed. The vendor-signature half is covered where real
// recorded evidence exists, in attestation/attestedroot.
type AppraisalFile struct {
	Description string            `json:"description"`
	Root        RecordedAppraisal `json:"root"`
	Quote       RecordedAppraisal `json:"quote"`
	// EAT holds, per appraiser profile name, the same two appraisals as
	// signed tokens. A profile missing from the map does not cover this
	// case's platform.
	EAT map[string]RecordedTokens `json:"eat,omitempty"`
}

// RecordedTokens is one profile's pair of tokens for a case.
type RecordedTokens struct {
	Root  string `json:"root"`
	Quote string `json:"quote"`
}

// RecordedAppraisal is a quote appraisal in the neutral spelling: the claim
// set's own field names, so a reader comparing a token with it is reading one
// mapping rather than two.
type RecordedAppraisal struct {
	// Error is what an appraiser that could not reach an answer reports.
	// Non-empty makes every other member meaningless: a refusal is never a
	// partial pass.
	Error string `json:"error,omitempty"`

	Platform          swarmevidence.Platform  `json:"platform,omitempty"`
	QuoteVerified     bool                    `json:"quote_verified"`
	TCBStatus         swarmevidence.TCBStatus `json:"tcb_status,omitempty"`
	CollateralChecked bool                    `json:"collateral_checked"`
	// KeyBinding is whether the quote commits to the certificate's key. It is
	// the root appraisal's business; a per-request quote commits to a request
	// instead.
	KeyBinding  bool                      `json:"key_binding"`
	NetworkType swarmevidence.NetworkType `json:"network_type,omitempty"`
	// BindingData is the guest-chosen field, hex, and BindingDataSource says
	// which field it was read from.
	BindingData       string                          `json:"binding_data,omitempty"`
	BindingDataSource swarmevidence.BindingDataSource `json:"binding_data_source,omitempty"`

	Measurements     swarmevidence.Measurements     `json:"measurements,omitzero"`
	PlatformSecurity swarmevidence.PlatformSecurity `json:"platform_security,omitzero"`

	MrEnclave         string                        `json:"mrenclave,omitempty"`
	MrEnclaveApproved bool                          `json:"mrenclave_approved"`
	MrEnclaveSource   swarmevidence.MrEnclaveSource `json:"mrenclave_source,omitempty"`
	SpvmBuild         string                        `json:"spvm_build,omitempty"`
}

// CompositeRootsFile is `composite/roots.json`, the same shape the bundle
// corpus uses.
type CompositeRootsFile struct {
	Version     string `json:"version"`
	Description string `json:"description"`
	Roots       []struct {
		Name        string `json:"name"`
		Fingerprint string `json:"fingerprint"`
		PEM         string `json:"pem"`
	} `json:"roots"`
}
