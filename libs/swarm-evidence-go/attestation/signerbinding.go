package attestation

import (
	"encoding/asn1"
	"slices"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/internal/certparse"
)

// The private OIDs the PKI authority stamps the challenge it certified a key
// against into. They are the constants of
// libs/swarm-attestation/src/signer-binding.ts, which reads them from the same
// certificates in the browser, restated here so this verifier does not depend
// on a JavaScript package.
//
// `buildCommonExtensions` in @super-protocol/pki-attestation-engine writes them
// for every certificate the authority issues, so what they say is the
// authority's own record of how it was persuaded to issue the leaf — not
// anything the requester chose.
var (
	// oidSignerChallengeType is the challenge the key holder presented.
	oidSignerChallengeType = asn1.ObjectIdentifier{1, 3, 6, 1, 3, 8888, 1, 1}
	// oidSignerChallengeSubtype is present only for a `certificate` challenge:
	// the challenge the *presented* certificate was itself issued against,
	// copied out of it. It is what keeps a certificate challenge traceable to
	// the hardware attestation that started the chain.
	oidSignerChallengeSubtype = asn1.ObjectIdentifier{1, 3, 6, 1, 3, 8888, 1, 1, 1}
	// oidSignerTEEEvidence carries the raw quote, embedded for `basic`-class
	// certificates issued against a hardware challenge.
	oidSignerTEEEvidence = asn1.ObjectIdentifier{0, 6, 9, 42, 840, 113741, 1337, 6}
)

// SignerChallengeType is an enrolment challenge the authority will write into
// the challenge-type extension.
type SignerChallengeType string

// Every challenge type the authority issues against. The five platform
// spellings are the hardware ones; `certificate` presents a certificate the
// authority already issued, `token` a bearer secret, and `untrusted` no proof
// at all.
const (
	ChallengeTDX         SignerChallengeType = "tdx"
	ChallengeTDXGoogle   SignerChallengeType = "tdx-google"
	ChallengeTDXAzure    SignerChallengeType = "tdx-azure"
	ChallengeSNP         SignerChallengeType = "sev-snp"
	ChallengeSNPAzure    SignerChallengeType = "sev-snp-azure"
	ChallengeCertificate SignerChallengeType = "certificate"
	ChallengeToken       SignerChallengeType = "token"
	ChallengeUntrusted   SignerChallengeType = "untrusted"
)

// challengeTypes is the closed set a value is matched against, and
// hardwareChallengeTypes the subset that required a fresh quote from measured
// hardware.
var (
	challengeTypes = []SignerChallengeType{
		ChallengeTDX, ChallengeTDXGoogle, ChallengeTDXAzure, ChallengeSNP, ChallengeSNPAzure,
		ChallengeCertificate, ChallengeToken, ChallengeUntrusted,
	}
	hardwareChallengeTypes = []SignerChallengeType{
		ChallengeTDX, ChallengeTDXGoogle, ChallengeTDXAzure, ChallengeSNP, ChallengeSNPAzure,
	}
)

// SignerBindingKind is what a signer's certificate proves about the key that
// signed with it, in the four values a policy matches on.
type SignerBindingKind string

const (
	// SignerBindingQuote means the authority saw a quote from measured
	// hardware whose guest-chosen field is this key's SHA-256(SPKI DER).
	SignerBindingQuote SignerBindingKind = "quote"
	// SignerBindingAttestedCertificate means the authority saw a certificate
	// it had itself issued against a hardware challenge. One step removed from
	// a fresh quote, and still rooted in one.
	SignerBindingAttestedCertificate SignerBindingKind = "attested-certificate"
	// SignerBindingSecret means the authority saw a bearer secret — a `token`
	// every node of the swarm holds — or nothing at all. The leaf chains to
	// the same root as a hardware-bound one and is otherwise
	// indistinguishable.
	SignerBindingSecret SignerBindingKind = "secret"
	// SignerBindingUnknown means the certificate carries no challenge
	// extension this build recognises: a chain from outside this PKI, one
	// issued before the authority recorded the challenge, or a certificate
	// challenge whose own subtype is not hardware. It is the fail-closed
	// value — treating an unlabelled leaf as hardware-bound is the one
	// mistake that would make this reading worse than useless.
	SignerBindingUnknown SignerBindingKind = "unknown"
)

// SignerBinding is what a chain's leaf certificate says about how its key was
// certified.
//
// A relying party that has validated the chain still does not know *how* the
// authority was persuaded to issue the leaf, and the difference is the whole
// question for an enterprise verifier: a `tdx` leaf means a quote committed to
// this key, while a `token` leaf means a bearer secret did. Both chain to the
// same root.
type SignerBinding struct {
	// ChallengeType and ChallengeSubtype are the extension values, empty when
	// the extension is absent or carries a value outside the closed set.
	ChallengeType    SignerChallengeType
	ChallengeSubtype SignerChallengeType
	// Kind is the verdict a policy reads.
	Kind SignerBindingKind
	// HardwareBound is Kind being `quote` or `attested-certificate`, stated
	// once so no caller has to re-derive it.
	HardwareBound bool
	// TEEEvidenceEmbedded is whether the leaf carries its own TEE evidence,
	// which a relying party may appraise itself: the quote is over
	// SHA-256(SPKI) of the signing key, so the signer's platform is
	// independently appraisable (SUP-696).
	TEEEvidenceEmbedded bool
}

// ReadSignerBinding reads the challenge extensions off a validated chain's
// leaf — the certificate whose key a signature verified under.
//
// It is a *report*, never a check: nothing here refuses anything, because
// which bindings a relying party will accept is its policy and deciding it
// here would make the verdict unarguable. A chain this package did not
// validate has no business being read: the extensions are only the
// authority's record once a signature chained to a pinned root, and before
// that they are attacker-supplied text.
func ReadSignerBinding(chain *ParsedChain) SignerBinding {
	if chain == nil || len(chain.certs) == 0 {
		return SignerBinding{Kind: SignerBindingUnknown}
	}
	leaf := chain.leaf()

	binding := SignerBinding{
		ChallengeType:    readChallengeType(leaf, oidSignerChallengeType),
		ChallengeSubtype: readChallengeType(leaf, oidSignerChallengeSubtype),
	}
	_, binding.TEEEvidenceEmbedded = leaf.Extension(oidSignerTEEEvidence)

	switch {
	case binding.ChallengeType == "":
		binding.Kind = SignerBindingUnknown
	case isHardwareChallenge(binding.ChallengeType):
		binding.Kind = SignerBindingQuote
	case binding.ChallengeType == ChallengeCertificate:
		// A certificate challenge is only as strong as the certificate
		// presented. Without a hardware subtype the chain behind it is
		// unknown, so it does not count as hardware-bound.
		if isHardwareChallenge(binding.ChallengeSubtype) {
			binding.Kind = SignerBindingAttestedCertificate
		} else {
			binding.Kind = SignerBindingUnknown
		}
	default:
		binding.Kind = SignerBindingSecret
	}
	binding.HardwareBound = binding.Kind == SignerBindingQuote ||
		binding.Kind == SignerBindingAttestedCertificate
	return binding
}

// readChallengeType matches an extension value against the closed set,
// exactly and never as a substring.
//
// This is the one reading that decides whether a key counts as hardware-bound,
// so an unrecognised value has to fail closed. A substring scan would do the
// opposite: any future type whose name happens to contain `tdx` — a simulator,
// a debug mode, a platform nobody has evaluated — would be read as a genuine
// Intel TDX quote and would silently satisfy a bank's policy.
func readChallengeType(leaf *certparse.Certificate, oid asn1.ObjectIdentifier) SignerChallengeType {
	value, ok := leaf.Extension(oid)
	if !ok {
		return ""
	}
	text := SignerChallengeType(certparse.ExtensionText(value))
	if slices.Contains(challengeTypes, text) {
		return text
	}
	return ""
}

func isHardwareChallenge(challenge SignerChallengeType) bool {
	return slices.Contains(hardwareChallengeTypes, challenge)
}
