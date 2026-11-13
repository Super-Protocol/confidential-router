package swarmevidence

import (
	"time"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
)

// Options configures one appraisal. Everything a verdict depends on is here
// rather than in package state, so two relying parties with different trust
// anchors can appraise the same evidence in the same process and get the
// answers their own configurations imply.
type Options struct {
	// Subject is what the evidence must be about: the hostname an evidence
	// bundle is published for.
	//
	// It is required for the bundle form. An appraisal that did not know what
	// it was looking at could report a sound chain and a verified quote
	// belonging to some other endpoint, which is the substitution the claim
	// set exists to rule out. The composite form answers the same question
	// with RequestSubject and RequestTarget instead, because what it is about
	// is a credential request rather than a served hostname.
	Subject string

	// RequestTarget and RequestSubject are the other two values the composite
	// form's binding digest commits to, beside FreshnessInput.
	//
	// RequestTarget is the prepared TACRA Target octets; RequestSubject is the
	// retrieval subject — the DER CertificationRequest for enrolment, the DER
	// SubjectPublicKeyInfo of CEKpub for retrieval. Both are supplied
	// **verbatim**, as the octets the attester was given: this module never
	// re-prepares a Target and never re-encodes a subject, because a verifier
	// that did would compute a digest no conformant attester produces.
	//
	// Both are required for the composite form, together with FreshnessInput.
	// An appraisal that did not hold the request values could report a
	// verified quote and a locked pod belonging to somebody else's request.
	RequestTarget  []byte
	RequestSubject []byte

	// PKIRoots are the Super Swarm PKI roots the relying party pinned. The
	// chain must terminate at one of them, matched by the SHA-256 of its DER;
	// the system trust store is never consulted, because Swarm Cloud roots are
	// not publicly trusted and the point is that the relying party chose the
	// anchor.
	//
	// An empty set is legal and denies everything at the pki-chain stage.
	PKIRoots []attestation.TrustedRoot

	// ReferenceValues are the image identities the relying party accepts
	// besides the ones Super Protocol signed — the CoRIM of SUP-640.
	ReferenceValues ReferenceValues

	// FreshnessInput is the freshness element the attester was challenged
	// with, verbatim: the 32-octet Handle for the TACRA Vault profile's
	// `present-nonce`, the 8-octet big-endian timestamp for
	// `absent-timestamp`. It is echoed into the claim set and is the first of
	// the three values the composite form's binding digest commits to.
	//
	// Its size is the Freshness Kind's and is not this module's to fix, so no
	// particular length is required; what is fixed is the size of the quote
	// field the resulting digest goes into, which selects the hash
	// ([BindingDigest]).
	FreshnessInput []byte

	// QuoteAppraiser appraises the hardware quote. Nil selects
	// [BuiltinQuoteAppraiser], which uses the CPU vendors' own libraries and
	// the signed-measurement registry; the Intel Trust Authority adapter of
	// SUP-648 is the other implementation.
	QuoteAppraiser QuoteAppraiser

	// MaxEvidenceAge rejects evidence whose signed issuedAt is older than
	// this. Zero disables the check — which is the right default only when
	// FreshnessInput carries the anti-replay weight instead.
	MaxEvidenceAge time.Duration

	// ObservedTLSFingerprint is the `sha256/<base64url>` digest of the
	// certificate the relying party saw on the connection the claims will be
	// acted on. Supplying it is what earns [BindingObserved]; without it the
	// bundle form falls back to the producer-asserted binding, which a policy
	// that cares about channel binding must refuse.
	ObservedTLSFingerprint string

	// Now overrides the clock, for appraising against a fixed date.
	Now time.Time
}

// ReferenceValues is the relying party's own statement about which images and
// builds are acceptable, independent of Super Protocol's registry.
//
// It is deliberately only an input to the *source* of the approval claim, never
// to a predicate: the core reports MrEnclaveApproved and MrEnclaveSource, and
// the policy decides what to do with an image admitted by reference values
// rather than by a signature.
type ReferenceValues struct {
	// MrEnclaves are normalised image identities, in any spelling
	// [attestedroot.ParseMeasurement] accepts.
	MrEnclaves []string
}

// appraiser is the configured quote appraiser, or the built-in one.
func (o Options) appraiser() QuoteAppraiser {
	if o.QuoteAppraiser != nil {
		return o.QuoteAppraiser
	}
	return &BuiltinQuoteAppraiser{ReferenceValues: o.ReferenceValues, Now: o.now}
}

func (o Options) now() time.Time {
	if o.Now.IsZero() {
		return time.Now()
	}
	return o.Now
}
