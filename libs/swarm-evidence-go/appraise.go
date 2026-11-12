package swarmevidence

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
)

// freshnessInputBytes is the length of the challenge an attester binds. The
// draft fixes it at 64 bytes, which is also the whole of a quote's report-data
// field, so nothing else can share that space (SUP-637).
const freshnessInputBytes = 64

// AppraiseComposite verifies a Super Swarm Evidence blob offline and returns
// the normative claim set, or a typed denial naming the stage that refused.
//
// The error is the claims' own [Denial] value, and the returned claim set
// carries it too, so a caller may branch on either. A refused appraisal never
// returns a partial claim set — see [SwarmClaims].
//
// # What it reads today
//
// The evidence bundle of the /.well-known/swarm-evidence contract: a certificate
// chain, a JWS over a deployment or control-plane statement, and the TEE
// evidence the chain's root carries. That is the form the fleet publishes and
// the form the shared conformance vectors pin.
//
// The *composite* form — a hardware quote beside a NodeRequestEnvelope and a
// control-plane statement, bound together by the report-data digest of SUP-637 —
// is refused at the blob stage until SUP-638 fixes its encoding and SUP-636 the
// statement and the node-local quote interface. A partial verdict over a shape
// whose binding rules are not settled would be worse than a denial: it would
// read as an appraisal.
func AppraiseComposite(ctx context.Context, blob []byte, opts Options) (SwarmClaims, error) {
	freshness, denial := freshnessOf(opts)
	if denial != nil {
		return deny("", denial)
	}
	if opts.Subject == "" {
		return deny(freshness, denyf(StageOptions,
			"Options.Subject is required: an appraisal that does not know what the evidence "+
				"is supposed to be about cannot rule out evidence about something else"))
	}

	if denial := rejectUnreadableForm(blob); denial != nil {
		return deny(freshness, denial)
	}
	return appraiseBundle(ctx, blob, opts, freshness)
}

// freshnessOf renders the challenge the claim set echoes. A wrong-sized nonce is
// a caller mistake worth refusing rather than padding: the attester binds
// exactly 64 bytes, so anything else could never have been bound.
func freshnessOf(opts Options) (string, *Denial) {
	if len(opts.FreshnessInput) == 0 {
		return "", nil
	}
	if len(opts.FreshnessInput) != freshnessInputBytes {
		return "", denyf(StageOptions, "Options.FreshnessInput is %d bytes, expected %d",
			len(opts.FreshnessInput), freshnessInputBytes)
	}
	return hex.EncodeToString(opts.FreshnessInput), nil
}

// rejectUnreadableForm refuses a blob that is not an evidence bundle, before the
// pipeline gets a chance to report it as a malformed one.
//
// Anything that is not a readable bundle is reported as the composite form
// rather than as garbage: the composite encoding is not settled (SUP-638), so
// this module cannot tell a draft composite blob from a malformed bundle, and
// guessing "malformed" would send a caller looking for a bug in their producer.
func rejectUnreadableForm(blob []byte) *Denial {
	var envelope struct {
		Version string                   `json:"version"`
		Kind    attestation.EvidenceKind `json:"kind"`
	}
	if err := json.Unmarshal(blob, &envelope); err != nil {
		return denyf(StageBlob, "the blob is not a JSON document: %v", err)
	}
	switch envelope.Kind {
	case attestation.KindDeploymentEvidence,
		attestation.KindControlPlaneEvidence,
		attestation.KindKubernetesControlPlaneEvidence:
		if envelope.Version != "1" {
			return denyf(StageBlob, "unsupported evidence bundle version %q", envelope.Version)
		}
		return nil
	default:
		return denyf(StageBlob,
			"this build appraises the /.well-known/swarm-evidence bundle form only; the composite "+
				"Super Swarm Evidence form (quote, NodeRequestEnvelope and control-plane statement) "+
				"is not implemented yet — see SUP-636 and SUP-638 — and %q is not a bundle kind",
			string(envelope.Kind))
	}
}

// appraiseBundle appraises the bundle form: the signed statement and its chain,
// then the TEE evidence the chain's root carries.
//
// The two halves are deliberately in that order. Before the chain validates and
// terminates at a pinned root, its last element is an attacker-controlled
// certificate that is a root in name only, and appraising the evidence it
// carries would mean fetching artefacts an attacker named.
func appraiseBundle(ctx context.Context, blob []byte, opts Options, freshness string) (SwarmClaims, error) {
	verdict := attestation.VerifyBundle(blob, attestation.Params{
		Hostname:               opts.Subject,
		TrustedRoots:           opts.PKIRoots,
		ObservedTLSFingerprint: opts.ObservedTLSFingerprint,
		MaxBundleAge:           opts.MaxEvidenceAge,
		Now:                    opts.now(),
	})
	if !verdict.OK {
		return deny(freshness, denyf(denialStageOf(verdict.Stage), "%s", verdict.Reason))
	}

	appraiser := opts.QuoteAppraiser
	if appraiser == nil {
		appraiser = &BuiltinQuoteAppraiser{ReferenceValues: opts.ReferenceValues, Now: opts.now}
	}
	appraisal, denial := appraiseRoot(ctx, verdict.Chain, appraiser)
	if denial != nil {
		return deny(freshness, denial)
	}

	claims := SwarmClaims{
		SchemaVersion:  ClaimsVersion,
		FreshnessInput: freshness,
		ChannelBinding: channelBindingOf(verdict.ChannelBinding),

		Platform:          appraisal.Platform,
		QuoteVerified:     boolOf(appraisal.QuoteVerified),
		QuoteAppraiser:    appraiser.Name(),
		TCBStatus:         appraisal.TCBStatus,
		CollateralChecked: boolOf(appraisal.CollateralChecked),
		Measurements:      appraisal.Measurements,
		PlatformSecurity:  appraisal.PlatformSecurity,
		MrEnclave:         appraisal.MrEnclave,
		MrEnclaveApproved: boolOf(appraisal.MrEnclaveApproved),
		MrEnclaveSource:   appraisal.MrEnclaveSource,
		SpvmBuild:         appraisal.SpvmBuild,

		PKIRootFingerprint: verdict.MatchedRoot.Fingerprint,
		PKIChainOK:         boolOf(true),
		RootQuoteOK:        boolOf(appraisal.QuoteVerified && appraisal.KeyBinding),
		NetworkType:        appraisal.NetworkType,

		// The bundle's JWS verified under the chain's leaf key, and the chain
		// terminated at a pinned root: that is the statement signature, and
		// the leaf is its signer. The per-leader signer of SUP-636 is the
		// composite form's answer to the same question.
		StatementSignerFingerprint: verdict.Chain.LeafFingerprint,
		StatementOK:                boolOf(true),
	}
	if payload, ok := verdict.Deployment(); ok {
		claims.EvidenceDigest = payload.EvidenceDigest
	}
	return claims, nil
}

// appraiseRoot appraises the TEE evidence the chain's terminal certificate
// carries.
func appraiseRoot(
	ctx context.Context, chain *attestation.ParsedChain, appraiser QuoteAppraiser,
) (*QuoteAppraisal, *Denial) {
	cert, err := x509.ParseCertificate(chain.RootDER)
	if err != nil {
		// crypto/x509 rejects secp256k1 outright, and the platform issues RSA
		// and P-256 CAs — so a root whose key it cannot read is not one of
		// ours, which is a denial rather than a parser limitation to work
		// around.
		return nil, denyf(StageRootQuote, "the pinned root certificate is not readable: %v", err)
	}

	appraisal, err := appraiser.AppraiseRootQuote(ctx, cert)
	if err != nil {
		return nil, denyf(StageRootQuote, "%v", err)
	}
	if appraisal == nil {
		return nil, denyf(StageRootQuote, "the quote appraiser returned no appraisal")
	}
	if !appraisal.KeyBinding {
		return nil, denyf(StageBinding,
			"the hardware quote does not commit to the pinned root certificate's public key, "+
				"so it attests some VM rather than this certificate authority")
	}
	return appraisal, nil
}

// channelBindingOf translates the pipeline's binding mode, by an explicit
// switch rather than a string conversion: the claim set publishes a closed set,
// and a mode the schema does not list would make a conforming validator reject
// our own output. An unrecognised one is reported as no binding at all, which
// fails closed for a policy that requires one.
func channelBindingOf(binding attestation.ChannelBinding) ChannelBinding {
	switch binding {
	case attestation.BindingObserved:
		return BindingObserved
	case attestation.BindingProducerAsserted:
		return BindingProducerAsserted
	default:
		return ""
	}
}

// denialStageOf translates a bundle-pipeline stage into the claim set's
// vocabulary. The two vocabularies are kept apart on purpose: the pipeline's
// names are about our implementation (ADR-003 §1), and a relying party reads a
// denial beside the claims, not beside our code.
func denialStageOf(stage attestation.Stage) DenialStage {
	switch stage {
	case attestation.StageFetch:
		return StageBlob
	case attestation.StageCertChain, attestation.StageUntrustedRoot:
		return StagePKIChain
	case attestation.StageJWS:
		return StageStatement
	case attestation.StageTLSFingerprint:
		return StageBinding
	default:
		return StageBlob
	}
}
