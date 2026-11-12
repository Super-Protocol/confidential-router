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
	// It is required. An appraisal that did not know what it was looking at
	// could report a sound chain and a verified quote belonging to some other
	// endpoint, which is the substitution the claim set exists to rule out.
	Subject string

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

	// FreshnessInput is the nonce the attester was challenged with. It is
	// echoed into the claim set verbatim and, once the composite form carries a
	// NodeRequestEnvelope, is what BindingOK is computed against.
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

func (o Options) now() time.Time {
	if o.Now.IsZero() {
		return time.Now()
	}
	return o.Now
}
