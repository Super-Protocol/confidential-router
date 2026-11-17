package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/conformance"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/internal/testca"
)

// The trust anchors the cases name.
const (
	rootName        = "swarm-cloud-conformance-root"
	foreignRootName = "some-other-cloud-root"
)

// caseSpec is one case, declared as the differences from a sound composite
// appraisal. Everything a case does not mention is the canonical case, so a
// reader sees what the case is about and a denial is attributable to exactly
// one broken fact.
type caseSpec struct {
	id          string
	description string

	// The evidence.
	challengeType   string // the quote element's `type`; defaults to the platform's
	platform        swarmevidence.Platform
	rootPlatform    swarmevidence.Platform
	membership      func(m *material) []*testca.Cert
	statement       func(s map[string]any)
	swapStatement   func(s map[string]any) // applied after the envelope binds the original
	envelope        func(e map[string]any)
	statementSigner func(m *material) *testca.Cert
	envelopeSigner  func(m *material) *testca.Cert
	omitStatement   bool
	omitEnvelope    bool
	standardWrapper bool

	// The request the relying party is holding.
	freshness, target, subject []byte
	trustedRoots               []string
	referenceValues            []string
	maxEvidenceAge             *int64

	// The quote, and the appraisal of it.
	bindingOver *bindingInputs // what the quote actually committed to, when not this request
	// eventLogDoesNotReplay gives the quote an RTMR0 the event list beside it
	// cannot explain, which is what makes the image identity underivable.
	eventLogDoesNotReplay bool
	// imageUnsigned is a case whose image identity the signed-measurement
	// registry does not vouch for.
	imageUnsigned bool
	quoteTweak    func(a *conformance.RecordedAppraisal)
	rootTweak     func(a *conformance.RecordedAppraisal)

	// recordedOnlyTweak changes what the *recorded* profile's appraiser
	// answers and leaves the delegated profiles reading the quote itself.
	//
	// It is for the two cases that are about an appraiser's own contract
	// rather than about the evidence: an appraiser that reports no image
	// identity, and one that will not name the field it read the binding
	// digest from. A production DelegatedQuoteAppraiser can be neither — it
	// derives the identity locally and reads the field out of the quote — so
	// it reaches the sound answer, and recordedOnlyNote is what the override
	// says.
	recordedOnlyTweak func(a *conformance.RecordedAppraisal)
	recordedOnlyNote  string

	// The verdict, when the case is not appraisable.
	denyStage  string
	denyReason string
}

// bindingInputs are the three values a quote's guest-chosen field commits to,
// for the cases where they are not this request's.
type bindingInputs struct{ freshness, target, subject []byte }

func cases() []caseSpec {
	foreign := func(m *material) *testca.Cert { return m.foreignNode }

	return []caseSpec{{
		id: "composite-full-tdx-qemu",
		description: "The form this module exists for: a bare-metal TDX quote bound to one credential " +
			"request, the node's envelope, and the leader's statement about the pod that asked.",
		platform: swarmevidence.PlatformTDXQemu,
	}, {
		id:          "composite-full-tdx-gcp",
		description: "The same collection on GCP TDX — the other platform a quote-only Verifier covers.",
		platform:    swarmevidence.PlatformTDXGCP,
	}, {
		id: "composite-full-tdx-azure",
		description: "Azure TDX: the binding lives in the 64-octet HCL user-data, because the hardware " +
			"REPORT_DATA there is the paravisor's SHA-256(runtime data JSON) ‖ 0³² and is not " +
			"guest-chosen. Outside the delegated path's coverage.",
		platform: swarmevidence.PlatformTDXAzure,
	}, {
		id: "composite-full-snp-qemu",
		description: "Bare-metal SEV-SNP: the image identity is rebuilt from the published firmware " +
			"of the build the VM booted, which no quote-only Verifier reports. The delegated path " +
			"denies at `coverage`, which says nothing about the evidence.",
		platform: swarmevidence.PlatformSNPQemu,
	}, {
		id:          "composite-full-snp-azure",
		description: "Azure SEV-SNP: the HCL user-data binding again, on the other vendor's branch.",
		platform:    swarmevidence.PlatformSNPAzure,
	}, {
		id: "composite-snp-attested-root",
		description: "A membership root whose own TEE evidence is SEV-SNP, beside a TDX per-request " +
			"quote. The delegated path delegates the per-request quote and appraises the membership " +
			"root offline — the root's quote is part of the Super Swarm chain, not of the request — " +
			"so a root the relying party's Verifier could not appraise changes nothing.",
		platform:     swarmevidence.PlatformTDXQemu,
		rootPlatform: swarmevidence.PlatformSNPQemu,
	}, {
		id: "composite-minimal",
		description: "The two REQUIRED elements alone. No statement and no envelope, so no pod claim " +
			"is reported — an absent claim was not established.",
		platform:      swarmevidence.PlatformTDXQemu,
		omitStatement: true,
		omitEnvelope:  true,
	}, {
		id: "composite-envelope-without-statement",
		description: "An envelope with nothing to pair: the node vouches that this quote answers this " +
			"request, and no leader statement is carried, so `envelope_ok` is reported and the pod " +
			"claims are not.",
		platform:      swarmevidence.PlatformTDXQemu,
		omitStatement: true,
	}, {
		id: "composite-gpu-attested",
		description: "The envelope carries a GPU attestation token hash, which is the only thing that " +
			"can set `gpu_attested`: the binding digest owns all 64 octets of the guest-chosen field, " +
			"so a token hash cannot ride in the quote beside it.",
		platform: swarmevidence.PlatformTDXQemu,
		envelope: func(e map[string]any) {
			e["gpu_attestation_token_sha256"] = b64(sha256Of([]byte("nvidia attestation token")))
		},
	}, {
		id: "composite-unlabelled-statement-signer",
		description: "The statement is signed by a leaf carrying no challenge extension — a chain " +
			"from outside this PKI, or one issued before the authority recorded the enrolment. The " +
			"appraisal still verifies the signature and still reports " +
			"`statement_signer_binding: unknown`, because a policy that requires a hardware-bound " +
			"signer has to be able to tell an unlabelled leaf from a claim this build did not " +
			"produce. Nothing here is refused: what the binding is worth is the policy's decision.",
		platform:        swarmevidence.PlatformTDXQemu,
		statementSigner: func(m *material) *testca.Cert { return m.unlabelledSigner },
		membership: func(m *material) []*testca.Cert {
			return []*testca.Cert{m.node, m.unlabelledSigner, m.inter, m.root}
		},
	}, {
		id: "composite-standard-cmw-wrapper",
		description: "The same parts under the CMW JSON collection of draft-ietf-rats-msg-wrap. The " +
			"relying party runs one Verifier of its own choosing, and a collection carrying the same " +
			"parts must appraise into the same claims whoever forwarded it.",
		platform:        swarmevidence.PlatformTDXQemu,
		standardWrapper: true,
	}, {
		id: "composite-unlocked-cluster-space",
		description: "The cluster space is not locked. That is a claim and not a denial: whether an " +
			"unlocked space may receive a credential is the relying party's policy, and deciding it " +
			"here would make the verdict unarguable.",
		platform: swarmevidence.PlatformTDXQemu,
		statement: func(s map[string]any) {
			space := s["cluster_space"].(map[string]any)
			space["locked"] = false
			// An absent fact is an explicit null on this wire, so that a
			// policy can tell "never locked" from "this producer did not
			// report it".
			space["locked_at"] = nil
		},
	}, {
		id: "composite-pss-privileged",
		description: "The pod runs under the `privileged` Pod Security Standard. Reported, never " +
			"judged — the five predicates live in the bank's policy module.",
		platform: swarmevidence.PlatformTDXQemu,
		statement: func(s map[string]any) {
			s["pod_security"].(map[string]any)["enforce"] = "privileged"
		},
	}, {
		id: "composite-mrenclave-unapproved",
		description: "The registry answered, and the answer was `not one of ours`. " +
			"`mrenclave_approved: false` is a statement a policy decides on, spelled differently " +
			"from a claim nobody looked at.",
		platform:      swarmevidence.PlatformTDXQemu,
		imageUnsigned: true,
		quoteTweak: func(a *conformance.RecordedAppraisal) {
			a.MrEnclaveApproved = false
			a.MrEnclaveSource = ""
		},
	}, {
		id: "composite-mrenclave-from-reference-values",
		description: "The image is admitted by the relying party's own reference values rather than " +
			"by a Super Protocol signature. It proves strictly less, and `mrenclave_source` is what " +
			"says so.",
		platform:        swarmevidence.PlatformTDXQemu,
		imageUnsigned:   true,
		referenceValues: []string{tdxImageIdentity},
		quoteTweak: func(a *conformance.RecordedAppraisal) {
			a.MrEnclaveSource = swarmevidence.SourceReferenceValues
		},
	}, {
		id: "composite-quote-only-verifier-no-image-identity",
		description: "An appraiser that appraises the quote and nothing else: it reports the " +
			"registers and no image identity, because mrEnclave needs the RTMR0 event log replayed " +
			"and normalised. Neither `mrenclave` nor `mrenclave_approved` may then appear — a policy " +
			"reading `mrenclave_approved: false` would believe something was checked. The delegated " +
			"profiles are the other half of the same point: handed the same quote, they replay the " +
			"event list themselves and do report an identity.",
		platform: swarmevidence.PlatformTDXQemu,
		recordedOnlyTweak: func(a *conformance.RecordedAppraisal) {
			a.MrEnclave = ""
			a.MrEnclaveApproved = false
			a.MrEnclaveSource = ""
			a.SpvmBuild = ""
		},
		recordedOnlyNote: "the delegated path derives the image identity from the quote's own RTMR0 " +
			"event list, so it reports one where a quote-only appraiser cannot",
	}, {
		id: "composite-deny-wrong-target",
		description: "The quote commits to another Target: the attester answered a different request, " +
			"and nothing paired with it is relevant.",
		platform:    swarmevidence.PlatformTDXQemu,
		bindingOver: &bindingInputs{requestFreshness, []byte("https://vault.bank.example/v1/hr-db"), requestSubject},
		denyStage:   "binding",
		denyReason:  "does not answer this request",
	}, {
		id: "composite-deny-replayed-nonce",
		description: "The quote commits to an earlier challenge's freshness element. A replayed quote " +
			"is a quote about some other moment.",
		platform:    swarmevidence.PlatformTDXQemu,
		bindingOver: &bindingInputs{bytes(0x11, 32), requestTarget, requestSubject},
		denyStage:   "binding",
		denyReason:  "does not answer this request",
	}, {
		id: "composite-deny-modified-cekpub",
		description: "CEKpub was modified in flight: the quote commits to the key the attester was " +
			"given, the relying party holds another, and the binding digest is what notices.",
		platform: swarmevidence.PlatformTDXQemu,
		bindingOver: &bindingInputs{
			requestFreshness, requestTarget,
			[]byte("\x30\x59\x30\x13an attacker's SubjectPublicKeyInfo"),
		},
		denyStage:  "binding",
		denyReason: "does not answer this request",
	}, {
		id: "composite-deny-binding-source-unreported",
		description: "An appraiser that reads the guest-chosen field and will not say which field it " +
			"read. On the Azure nested form the raw REPORT_DATA is the paravisor's, so a comparison " +
			"against an unnamed field proves nothing.",
		platform: swarmevidence.PlatformTDXQemu,
		recordedOnlyTweak: func(a *conformance.RecordedAppraisal) {
			a.BindingDataSource = ""
		},
		recordedOnlyNote: "the delegated path reads the guest-chosen field out of the quote itself " +
			"and always names which field that was, so it cannot be the appraiser this case is about",
		denyStage:  "binding",
		denyReason: "did not say which field",
	}, {
		id: "composite-deny-envelope-foreign-subject",
		description: "The envelope's `subject_hash` is some other public key's: the node vouched for " +
			"a request that is not this one.",
		platform: swarmevidence.PlatformTDXQemu,
		envelope: func(e map[string]any) {
			e["subject_hash"] = b64(sha256Of([]byte("some other public key")))
		},
		denyStage:  "envelope",
		denyReason: "subject_hash",
	}, {
		id:          "composite-deny-envelope-replayed-nonce",
		description: "The envelope answers an earlier challenge, while the quote answers this one.",
		platform:    swarmevidence.PlatformTDXQemu,
		envelope: func(e map[string]any) {
			e["freshness"] = b64(bytes(0x11, 32))
		},
		denyStage:  "envelope",
		denyReason: "answers some other challenge",
	}, {
		id: "composite-deny-envelope-foreign-target",
		description: "The envelope names another Vault target than the one being appraised — the " +
			"draft's foreign additional-authenticated-data case, in this profile's spelling.",
		platform: swarmevidence.PlatformTDXQemu,
		envelope: func(e map[string]any) {
			e["target"] = b64([]byte("https://vault.bank.example/v1/hr-db"))
		},
		denyStage:  "envelope",
		denyReason: "envelope target",
	}, {
		id: "composite-deny-envelope-foreign-node-certificate",
		description: "The envelope is signed by a node certificate of another cloud, under a root " +
			"nobody pinned, and the membership element does not carry it.",
		platform:       swarmevidence.PlatformTDXQemu,
		envelopeSigner: foreign,
		envelope: func(e map[string]any) {
			e["node_cert_fingerprint"] = "" // filled in with the foreign node's, below
		},
		denyStage:  "envelope",
		denyReason: "does not carry",
	}, {
		id: "composite-deny-statement-of-another-pod",
		description: "The attester substitution the envelope exists to catch: a sound statement about " +
			"a locked neighbour, attached to a quote taken over this requester's own key. Every other " +
			"check passes, and only the envelope's `statement_hash` contradicts the pairing.",
		platform: swarmevidence.PlatformTDXQemu,
		swapStatement: func(s map[string]any) {
			s["pod"].(map[string]any)["uid"] = "pod-locked-neighbour"
		},
		denyStage:  "envelope",
		denyReason: "statement_hash",
	}, {
		id: "composite-deny-substituted-statement-signer",
		description: "The statement is signed outside the pinned PKI. A leader's signature is only " +
			"worth the chain behind it.",
		platform:        swarmevidence.PlatformTDXQemu,
		statementSigner: foreign,
		denyStage:       "statement",
		denyReason:      "chains to a pinned root",
	}, {
		id: "composite-deny-chain-to-another-pki-root",
		description: "The membership chain validates — to a root of another cloud. The relying party " +
			"pinned one anchor, and the system trust store is never consulted.",
		platform:       swarmevidence.PlatformTDXQemu,
		membership:     func(m *material) []*testca.Cert { return []*testca.Cert{m.foreignNode, m.foreignRoot} },
		envelopeSigner: foreign,
		envelope: func(e map[string]any) {
			e["node_cert_fingerprint"] = ""
		},
		statementSigner: foreign,
		denyStage:       "pki-chain",
		denyReason:      "not in trusted store",
	}, {
		id: "composite-deny-statement-without-envelope",
		description: "A statement with no envelope binding it to this request. It is the substitution " +
			"shape itself, and not one of the three collections the profile pins.",
		platform:     swarmevidence.PlatformTDXQemu,
		omitEnvelope: true,
		denyStage:    "envelope",
		denyReason:   "carries a statement and no envelope binding it to this request",
	}, {
		id: "composite-deny-gpu-token-with-invalid-envelope",
		description: "A GPU token hash inside an envelope the named certificate did not sign. The " +
			"appraisal denies, so `gpu_attested` is never set — a token hash beside an envelope that " +
			"did not verify vouches for nothing.",
		platform:       swarmevidence.PlatformTDXQemu,
		envelopeSigner: func(m *material) *testca.Cert { return m.signer },
		envelope: func(e map[string]any) {
			e["gpu_attestation_token_sha256"] = b64(sha256Of([]byte("nvidia attestation token")))
		},
		denyStage:  "envelope",
		denyReason: "signature",
	}, {
		id: "composite-deny-event-log-does-not-replay",
		description: "The RTMR0 event list the quote carries does not replay to the quote's own " +
			"RTMR0, so no image identity can be derived from it. The appraiser reports a failure to " +
			"reach an answer, which is a denial and not an unapproved image — and both paths reach " +
			"it from the evidence rather than from a recorded verdict.",
		platform:              swarmevidence.PlatformTDXQemu,
		eventLogDoesNotReplay: true,
		denyStage:             "root-quote",
		denyReason:            "replays to",
	}, {
		id: "composite-deny-stale-evidence",
		description: "The signed objects are older than the relying party accepts. Both carry an " +
			"`issued_at`, and the envelope is the one checked first, so that is where the window " +
			"the caller configured refuses.",
		platform:       swarmevidence.PlatformTDXQemu,
		maxEvidenceAge: ptr(int64(60_000)),
		denyStage:      "envelope",
		denyReason:     "exceeds the",
	}}
}

// imageIdentity is the image identity the SEV-SNP and Azure cases record. On
// those branches it is rebuilt from published firmware or read out of the
// vTPM, and no fixture here does either, so it is declared.
var imageIdentity = hexFill("5c", 32)

// tdxImageIdentity is what the TDX cases' quotes actually normalise to.
//
// Every TDX case carries the same registers and the same RTMR0 event list, so
// one value is what the signed-measurement registry and the relying party's
// own reference values are about. It is computed from the quote rather than
// declared beside it, because the delegated path derives it from the same
// quote: a declared one would let the formula, the event replay or the claim
// mapping change without a vector noticing.
var tdxImageIdentity = mustTDXImageIdentity()

func mustTDXImageIdentity() string {
	quote, err := newTDXQuote(swarmevidence.PlatformTDXQemu, make([]byte, bindingDigestOctets), false)
	if err != nil {
		panic("vectorgen: building the canonical TDX quote: " + err.Error())
	}
	identity, err := quote.mrEnclave()
	if err != nil {
		panic("vectorgen: deriving the canonical image identity: " + err.Error())
	}
	return identity
}

// bindingDigestOctets is the size of the guest-chosen field the binding
// digest fills on the TDX branches.
const bindingDigestOctets = 64

// buildQuote assembles the quote one case presents, and the serialised
// TeeEvidence its quote element carries.
//
// The TDX branches carry a real message: the registers, the event list that
// explains RTMR0 and the guest-chosen field holding this request's binding
// digest, all of which a delegated appraisal reads out of the quote in hand.
// The others carry the smallest well-formed message of their branch — there
// is nothing on them for a quote-only Verifier to read, and the refusal the
// corpus records must come from the platform rather than from evidence that
// failed to parse.
func buildQuote(spec caseSpec, reportData []byte) (*tdxQuote, []byte, error) {
	if !isTDX(spec.platform) {
		return nil, nonTDXEvidence(spec.platform), nil
	}
	quote, err := newTDXQuote(spec.platform, reportData, spec.eventLogDoesNotReplay)
	if err != nil {
		return nil, nil, err
	}
	evidence, err := quote.evidence()
	if err != nil {
		return nil, nil, err
	}
	return quote, evidence, nil
}

func isTDX(platform swarmevidence.Platform) bool {
	return platform == swarmevidence.PlatformTDXQemu || platform == swarmevidence.PlatformTDXGCP
}

// registrySigned is the relying party's view of the signed-measurement
// registry: the image identities Super Protocol vouches for.
//
// It is part of the case rather than of the appraiser because an appraiser
// that derives the image identity itself must then ask who vouches for it,
// and the two paths must be asked the same question. A case whose image
// nobody signed declares none.
func registrySigned(spec caseSpec, appraisal conformance.RecordedAppraisal) []string {
	if spec.imageUnsigned || appraisal.MrEnclave == "" {
		return nil
	}
	return []string{appraisal.MrEnclave}
}

// builtCase is everything one case contributes to the corpus.
type builtCase struct {
	file       conformance.CompositeCaseFile
	collection map[string]any
	appraisals conformance.AppraisalFile
}

func (m *material) build(spec caseSpec, profiles []conformance.AppraiserProfile) (*builtCase, error) {
	freshness := orBytes(spec.freshness, requestFreshness)
	target := orBytes(spec.target, requestTarget)
	subject := orBytes(spec.subject, requestSubject)

	// The quote the collection carries, and what it commits to. It is built
	// first because the appraisal below is read out of it rather than
	// declared beside it: the registers, the event list and the guest-chosen
	// field are the quote's, so a case cannot record an appraisal of a quote
	// it did not present.
	binding := bindingInputs{freshness, target, subject}
	if spec.bindingOver != nil {
		binding = *spec.bindingOver
	}
	bound := bindingDigest(binding.freshness, binding.target, binding.subject)
	quote, evidence, err := buildQuote(spec, bound)
	if err != nil {
		return nil, err
	}

	// The statement the node saw, which the envelope binds.
	statement := baseStatement()
	if spec.statement != nil {
		spec.statement(statement)
	}
	statementHash, err := jcsHash(statement)
	if err != nil {
		return nil, err
	}

	envelope := m.baseEnvelope()
	envelope["subject_hash"] = b64(sha256Of(subject))
	envelope["freshness"] = b64(freshness)
	envelope["target"] = b64(target)
	if spec.omitStatement {
		delete(envelope, "statement_hash")
	} else {
		envelope["statement_hash"] = statementHash
	}
	envelopeSigner := m.node
	if spec.envelopeSigner != nil {
		envelopeSigner = spec.envelopeSigner(m)
	}
	if spec.envelope != nil {
		spec.envelope(envelope)
	}
	// An envelope names its signer by fingerprint; a case that swapped the
	// signer names the certificate that actually signed, so the denial is
	// about what the case is about and not about a mismatched name.
	if fingerprint, ok := envelope["node_cert_fingerprint"].(string); ok && fingerprint == "" {
		envelope["node_cert_fingerprint"] = b64(sha256Of(envelopeSigner.DER))
	}

	// The statement actually carried, which for a substitution case is not
	// the one the envelope bound.
	carried := statement
	if spec.swapStatement != nil {
		carried = cloneMap(statement)
		spec.swapStatement(carried)
	}

	statementSigner := m.signer
	if spec.statementSigner != nil {
		statementSigner = spec.statementSigner(m)
	}

	built := collection{
		quote:      baseQuote(challengeTypeOf(spec), evidence),
		membership: m.membershipOf(spec),
		standard:   spec.standardWrapper,
	}
	if !spec.omitStatement {
		if built.statement, err = signStatement(statementSigner, carried); err != nil {
			return nil, err
		}
	}
	if !spec.omitEnvelope {
		if built.envelope, err = signEnvelope(envelopeSigner, envelope); err != nil {
			return nil, err
		}
	}
	document, err := built.render()
	if err != nil {
		return nil, err
	}

	// The appraisal of that quote. Two viewpoints come out of it: what the
	// delegated profiles establish, which is everything the quote itself
	// carries, and what the recorded profile's appraiser answered — the same
	// thing, unless the case is about an appraiser that answers less.
	delegatedAppraisal, err := recordedQuote(spec, quote, bound)
	if err != nil {
		return nil, err
	}
	if spec.quoteTweak != nil {
		spec.quoteTweak(&delegatedAppraisal)
	}
	quoteAppraisal := delegatedAppraisal
	if spec.recordedOnlyTweak != nil {
		spec.recordedOnlyTweak(&quoteAppraisal)
	}
	rootPlatform := spec.rootPlatform
	if rootPlatform == "" {
		rootPlatform = swarmevidence.PlatformTDXQemu
	}
	rootAppraisal := recordedRoot(rootPlatform)
	if spec.rootTweak != nil {
		spec.rootTweak(&rootAppraisal)
	}
	// A Verifier that appraised the quote reports a TCB verdict whatever the
	// local steps that follow conclude, so a case whose appraisal is itself a
	// refusal still records the verdict the token carried.
	tokenTCBStatus := delegatedAppraisal.TCBStatus
	if tokenTCBStatus == "" {
		tokenTCBStatus = swarmevidence.TCBOK
	}
	tokens, err := m.recordTokens(profiles, quote, tokenTCBStatus)
	if err != nil {
		return nil, err
	}

	trustedRoots := spec.trustedRoots
	if trustedRoots == nil {
		trustedRoots = []string{rootName}
	}
	expect, err := m.expectation(spec, expectationInputs{
		freshness:    freshness,
		subject:      subject,
		quote:        quoteAppraisal,
		delegated:    delegatedAppraisal,
		root:         rootAppraisal,
		statement:    carried,
		envelope:     envelope,
		signer:       statementSigner,
		node:         envelopeSigner,
		profiles:     profiles,
		hasStatement: !spec.omitStatement,
		hasEnvelope:  !spec.omitEnvelope,
	})
	if err != nil {
		return nil, err
	}

	return &builtCase{
		collection: document,
		appraisals: conformance.AppraisalFile{
			Description: "The quote appraisal " + spec.id + " is appraised against, in the neutral " +
				"spelling and in each EAT profile's.",
			Root:  rootAppraisal,
			Quote: quoteAppraisal,
			EAT:   tokens,
		},
		file: conformance.CompositeCaseFile{
			ID:          spec.id,
			Description: spec.description,
			Request: conformance.CompositeRequest{
				FreshnessInput:             hexOf(freshness),
				Target:                     b64(target),
				Subject:                    b64(subject),
				TrustedRoots:               trustedRoots,
				Now:                        referenceNow,
				MaxEvidenceAge:             spec.maxEvidenceAge,
				ReferenceValues:            spec.referenceValues,
				RegistrySignedMeasurements: registrySigned(spec, delegatedAppraisal),
			},
			EvidenceFile:  "composite/collections/" + spec.id + ".json",
			AppraisalFile: "composite/appraisals/" + spec.id + ".json",
			Expect:        expect,
		},
	}, nil
}

func (m *material) membershipOf(spec caseSpec) []*testca.Cert {
	if spec.membership != nil {
		return spec.membership(m)
	}
	return []*testca.Cert{m.node, m.signer, m.inter, m.root}
}

// expectationInputs is everything the declared claim set is assembled from.
type expectationInputs struct {
	freshness, subject []byte
	// quote is what the recorded profile's appraiser answered, and delegated
	// what the quote itself establishes. They differ only for the two cases
	// that are about an appraiser's own contract.
	quote, delegated conformance.RecordedAppraisal
	root             conformance.RecordedAppraisal
	statement        map[string]any
	envelope         map[string]any
	signer, node     *testca.Cert
	profiles         []conformance.AppraiserProfile
	hasStatement     bool
	hasEnvelope      bool
}

// expectation writes what the profile says this evidence establishes.
//
// It is assembled from the case's own declarations — the quote it presents,
// the certificates it chains through, the statement it carries — and never
// from the verifier: a corpus whose expectations came out of the code under
// test would pass by construction.
func (m *material) expectation(spec caseSpec, in expectationInputs) (conformance.CompositeExpect, error) {
	expect := conformance.CompositeExpect{
		OK:             false,
		Stage:          spec.denyStage,
		ReasonContains: spec.denyReason,
		Claims:         denialClaims(in.freshness, spec.denyStage),
	}
	if spec.denyStage == "" {
		claims, err := m.soundClaims(in, in.quote)
		if err != nil {
			return conformance.CompositeExpect{}, err
		}
		expect = conformance.CompositeExpect{OK: true, Claims: claims}
	}

	// Where a delegated profile reaches another answer, the override says
	// which and why. There are exactly two reasons, and both are properties
	// of the delegated path rather than of this case: a platform it does not
	// cover, and an appraiser contract it cannot have.
	for _, profile := range in.profiles {
		if profile.Kind != "eat" {
			continue
		}
		override, err := m.delegatedExpectation(spec, in, profile)
		if err != nil {
			return conformance.CompositeExpect{}, err
		}
		if override == nil {
			continue
		}
		if expect.Appraisers == nil {
			expect.Appraisers = map[string]*conformance.CompositeExpect{}
		}
		expect.Appraisers[profile.Name] = override
	}
	return expect, nil
}

// delegatedExpectation is one delegated profile's override, or nil when it
// must reach exactly the expectation beside it — which is the whole point of
// the corpus and is therefore the common case.
func (m *material) delegatedExpectation(
	spec caseSpec, in expectationInputs, profile conformance.AppraiserProfile,
) (*conformance.CompositeExpect, error) {
	if !profile.Covers(string(spec.platform)) {
		if profile.OutsideCoverage == nil {
			return nil, fmt.Errorf("profile %q does not cover %s and declares no refusal for it",
				profile.Name, spec.platform)
		}
		// The platform, not the evidence: `coverage` is the one stage that
		// says nothing about the attester, and what clears it is a different
		// appraiser (DENIAL-STAGES.md).
		return &conformance.CompositeExpect{
			OK:             false,
			Stage:          profile.OutsideCoverage.Stage,
			ReasonContains: "outside the delegated path's coverage",
			Claims:         denialClaims(in.freshness, profile.OutsideCoverage.Stage),
			Note:           profile.OutsideCoverage.Reason,
		}, nil
	}
	if spec.recordedOnlyTweak == nil {
		return nil, nil
	}
	claims, err := m.soundClaims(in, in.delegated)
	if err != nil {
		return nil, err
	}
	return &conformance.CompositeExpect{OK: true, Claims: claims, Note: spec.recordedOnlyNote}, nil
}

// soundClaims is the claim set one quote appraisal establishes about this
// case's evidence.
func (m *material) soundClaims(
	in expectationInputs, quote conformance.RecordedAppraisal,
) (map[string]any, error) {
	claims := map[string]any{
		"schema_version":         swarmevidence.ClaimsVersion,
		"freshness_input":        hexOf(in.freshness),
		"binding_ok":             true,
		"binding_subject_digest": hexOf(sha256Of(in.subject)),

		"platform":           string(quote.Platform),
		"quote_verified":     quote.QuoteVerified,
		"quote_appraiser":    conformance.AppraiserPlaceholder,
		"tcb_status":         string(quote.TCBStatus),
		"collateral_checked": quote.CollateralChecked,

		"pki_root_fingerprint": m.root.Fingerprint(),
		"pki_chain_ok":         true,
		"root_quote_ok":        in.root.QuoteVerified && in.root.KeyBinding,
		"network_type":         string(in.root.NetworkType),
	}
	measurements, err := document(quote.Measurements)
	if err != nil {
		return nil, err
	}
	if len(measurements) > 0 {
		claims["measurements"] = measurements
	}
	// The claim set omits platform_security when the appraiser populated
	// none of it, and every member of it has a meaningful zero — a VMPL of 0
	// is the privileged level — so the test is the whole structure rather
	// than the encoded document.
	if quote.PlatformSecurity != (swarmevidence.PlatformSecurity{}) {
		security, err := document(quote.PlatformSecurity)
		if err != nil {
			return nil, err
		}
		claims["platform_security"] = security
	}

	// An image identity is reported only when the appraiser derived one. A
	// quote-only Verifier cannot, and `mrenclave_approved: false` would tell
	// a policy that a set of reference values answered; an approval with no
	// identity is unreadable and is left out for the same reason.
	if quote.MrEnclave != "" {
		claims["mrenclave"] = quote.MrEnclave
		claims["mrenclave_approved"] = quote.MrEnclaveApproved
		if quote.MrEnclaveSource != "" {
			claims["mrenclave_source"] = string(quote.MrEnclaveSource)
		}
	}
	if quote.SpvmBuild != "" {
		claims["spvm_build"] = quote.SpvmBuild
	}

	if in.hasEnvelope {
		claims["envelope_ok"] = true
		claims["node_cert_fingerprint"] = in.node.Fingerprint()
		_, hasToken := in.envelope["gpu_attestation_token_sha256"]
		claims["gpu_attested"] = hasToken
	}
	if in.hasStatement {
		space := in.statement["cluster_space"].(map[string]any)
		pod := in.statement["pod"].(map[string]any)

		claims["statement_ok"] = true
		claims["statement_signer_fingerprint"] = in.signer.Fingerprint()
		claims["statement_signer_binding"] = declaredSignerBinding(in.signer)
		claims["pod_uid"] = pod["uid"]
		claims["namespace"] = pod["namespace"]
		claims["locked"] = space["locked"]
		if id, ok := space["id"].(string); ok && id != "" {
			claims["cluster_space_id"] = id
		}
		if lockedAt, ok := space["locked_at"].(string); ok && lockedAt != "" {
			claims["locked_at"] = lockedAt
		}
		if enforce, ok := in.statement["pod_security"].(map[string]any)["enforce"].(string); ok && enforce != "" {
			claims["pss_enforce"] = enforce
		}
		if digests := imageDigestsOf(in.statement); len(digests) > 0 {
			claims["image_digests"] = digests
		}
	}
	return claims, nil
}

// declaredSignerBinding is what the statement signer's certificate records
// about the key that signed, read off the template the case minted it from.
//
// It is written out here rather than taken from the package under test, like
// every other expectation in this generator: the mapping from a challenge the
// authority certified against to the word a policy matches on is the contract,
// and a corpus that asked the verifier for it would assert nothing.
func declaredSignerBinding(signer *testca.Cert) string {
	hardware := map[string]bool{
		"tdx": true, "tdx-google": true, "tdx-azure": true,
		"sev-snp": true, "sev-snp-azure": true,
	}
	switch challenge := signer.Template.ChallengeType; {
	case hardware[challenge]:
		return string(swarmevidence.SignerBindingQuote)
	case challenge == "certificate" && hardware[signer.Template.ChallengeSubtype]:
		return string(swarmevidence.SignerBindingAttestedCertificate)
	case challenge == "certificate" || challenge == "":
		// A certificate challenge with no hardware behind it says as little
		// as no extension at all, and both fail closed.
		return string(swarmevidence.SignerBindingUnknown)
	default:
		return string(swarmevidence.SignerBindingSecret)
	}
}

// denialClaims is the only claim set a refused appraisal may produce: the
// schema version, the freshness input the caller asked to bind, and why.
// Nothing else, so no reader can mistake a refusal for a partial pass.
func denialClaims(freshness []byte, stage string) map[string]any {
	return map[string]any{
		"schema_version":  swarmevidence.ClaimsVersion,
		"freshness_input": hexOf(freshness),
		"denial":          map[string]any{"stage": stage},
	}
}

// imageDigestsOf collects the digests a statement resolved, from its
// containers and its init containers alike, sorted and de-duplicated: the
// claim is a set, not a transcript of the producer's iteration order.
func imageDigestsOf(statement map[string]any) []string {
	var digests []string
	for _, key := range []string{"containers", "init_containers"} {
		list, _ := statement[key].([]any)
		for _, raw := range list {
			container, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if digest, ok := container["image_digest"].(string); ok && digest != "" {
				digests = append(digests, digest)
			}
		}
	}
	slices.Sort(digests)
	return slices.Compact(digests)
}

// recordedQuote is the per-request quote appraisal a case is appraised
// against.
//
// On the TDX branches it is read out of the quote the case presents — the
// registers it carries, the identity its event list normalises to, the
// guest-chosen field it commits to — so the recorded profile and a delegated
// one are answering about the same quote rather than about a quote and a
// story told beside it. On the others it is declared: nothing here rebuilds a
// SEV-SNP launch measurement from published firmware or reads an Azure vTPM.
func recordedQuote(spec caseSpec, quote *tdxQuote, binding []byte) (conformance.RecordedAppraisal, error) {
	appraisal := conformance.RecordedAppraisal{
		Platform:          spec.platform,
		QuoteVerified:     true,
		TCBStatus:         swarmevidence.TCBOK,
		CollateralChecked: true,
		BindingData:       hexOf(binding),
		BindingDataSource: swarmevidence.BindingFromReportData,
		MrEnclaveApproved: true,
		MrEnclaveSource:   swarmevidence.SourceRegistry,
	}
	if spec.platform == swarmevidence.PlatformTDXAzure || spec.platform == swarmevidence.PlatformSNPAzure {
		// On the Azure nested form the hardware report data is the
		// paravisor's, so the guest-chosen field is the HCL user-data.
		appraisal.BindingDataSource = swarmevidence.BindingFromHCLUserData
	}
	if quote == nil {
		appraisal.MrEnclave = imageIdentity
		// Only the SEV-SNP evidence names the sp-vm release it booted, and
		// only a verified AMD chain names a CPU line and a report version, so
		// those three are recorded on these branches and nowhere else.
		appraisal.SpvmBuild = "build-448-release"
		appraisal.Measurements, appraisal.PlatformSecurity = platformFacts(spec.platform)
		return appraisal, nil
	}

	if quote.eventLogDoesNotReplay {
		// The appraiser could not reach an answer, which is the whole
		// appraisal: a refusal is never a partial pass. The wording is the
		// one a reader of this corpus will see from the delegated path, so
		// the two profiles deny for the same stated reason.
		replayed, err := replayRTMR(quote.eventLog, nil)
		if err != nil {
			return appraisal, err
		}
		return conformance.RecordedAppraisal{
			Error: fmt.Sprintf("tdx evidence: the event list replays to %s, but the quote's RTMR0 is %s",
				hexOf(replayed), quote.rtmr0),
		}, nil
	}

	identity, err := quote.mrEnclave()
	if err != nil {
		return appraisal, err
	}
	appraisal.MrEnclave = identity
	appraisal.Measurements = quote.measurements()
	return appraisal, nil
}

// recordedRoot is the appraisal of the membership root's own TEE evidence:
// the step that makes the attestation about this certificate authority rather
// than about some VM.
//
// It stays recorded on every path. The membership root's quote is part of the
// Super Swarm chain rather than of the credential request, so the delegated
// appraiser hands it to the built-in offline appraiser too
// (DelegatedQuoteAppraiser.RootAppraiser) and the corpus stands in for that
// one appraiser once.
func recordedRoot(platform swarmevidence.Platform) conformance.RecordedAppraisal {
	appraisal := conformance.RecordedAppraisal{
		Platform:          platform,
		QuoteVerified:     true,
		TCBStatus:         swarmevidence.TCBOK,
		CollateralChecked: true,
		KeyBinding:        true,
		NetworkType:       swarmevidence.NetworkUntrusted,
		MrEnclave:         hexFill("ca", 32),
		MrEnclaveApproved: true,
		MrEnclaveSource:   swarmevidence.SourceRegistry,
	}
	if platform == swarmevidence.PlatformSNPQemu || platform == swarmevidence.PlatformSNPAzure {
		appraisal.SpvmBuild = "build-448-release"
	}
	appraisal.Measurements, appraisal.PlatformSecurity = platformFacts(platform)
	return appraisal
}

// platformFacts are the registers and the report fields each platform
// reports. Which members are populated is the platform's, which is why a
// policy reads `platform` before any of them.
//
// The TDX branches report no platform-security fields at all: the version and
// the CPU line in that structure come from an AMD report and the VCEK chain
// behind it, and a corpus that recorded them for a TD would be pinning
// something no appraiser produces.
func platformFacts(platform swarmevidence.Platform) (swarmevidence.Measurements, swarmevidence.PlatformSecurity) {
	// Assigned to locals rather than returned as two composite literals: the
	// two are indented differently by different releases of gofmt, so the
	// literal form makes the file's formatting depend on which Go a
	// contributor happens to have.
	if platform == swarmevidence.PlatformSNPQemu || platform == swarmevidence.PlatformSNPAzure {
		measurements := swarmevidence.Measurements{
			LaunchDigest: hexFill("1d", 48),
		}
		security := swarmevidence.PlatformSecurity{
			VMPL:             0,
			DebugAllowed:     false,
			CiphertextHiding: true,
			PageSwapDisabled: true,
			SnpFirmwareTCB:   23,
			ReportVersion:    3,
			CPUGeneration:    "Genoa",
		}
		return measurements, security
	}

	measurements := swarmevidence.Measurements{
		TDAttributes: "0000001000000000",
		MRTD:         hexFill("4d", 48),
		RTMR0:        hexFill("r0", 48),
		RTMR1:        hexFill("r1", 48),
		RTMR2:        hexFill("r2", 48),
		RTMR3:        hexFill("r3", 48),
	}
	return measurements, swarmevidence.PlatformSecurity{}
}

// challengeTypeOf is the quote element's own `type`: the platform's
// `PkiChallenge` spelling, which is the producer's and not the claim set's.
func challengeTypeOf(spec caseSpec) string {
	if spec.challengeType != "" {
		return spec.challengeType
	}
	switch spec.platform {
	case swarmevidence.PlatformTDXGCP:
		return "tdx-google"
	case swarmevidence.PlatformTDXAzure:
		return "tdx-azure"
	case swarmevidence.PlatformSNPQemu:
		return "sev-snp"
	case swarmevidence.PlatformSNPAzure:
		return "sev-snp-azure"
	default:
		return "tdx"
	}
}

// document renders a value the way the claim set publishes it, so a member
// the claim set omits is omitted from the expectation too.
func document(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// hexFill spells a measurement of n octets, from a two-character seed, so the
// registers of a case are told apart at a glance in a diff.
func hexFill(seed string, octets int) string {
	seed = strings.Map(func(r rune) rune {
		if strings.ContainsRune("0123456789abcdef", r) {
			return r
		}
		// A seed like "r0" names the register it fills; map the letter into
		// the hex alphabet rather than inventing a second spelling.
		return 'a' + (r % 6)
	}, seed)
	if seed == "" {
		seed = "00"
	}
	out := strings.Repeat(seed, octets)
	return out[:octets*2]
}

func orBytes(value, fallback []byte) []byte {
	if len(value) == 0 {
		return fallback
	}
	return value
}

func ptr[T any](value T) *T { return &value }
