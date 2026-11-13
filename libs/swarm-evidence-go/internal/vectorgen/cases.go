package main

import (
	"encoding/json"
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

	// The recorded appraisal.
	bindingOver *bindingInputs // what the quote actually committed to, when not this request
	quoteTweak  func(a *conformance.RecordedAppraisal)
	rootTweak   func(a *conformance.RecordedAppraisal)

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
			"guest-chosen. Outside the stand-in Verifier's coverage.",
		platform: swarmevidence.PlatformTDXAzure,
	}, {
		id: "composite-full-snp-qemu",
		description: "Bare-metal SEV-SNP: the image identity comes from the report's MEASUREMENT " +
			"rather than from TDX registers. A Verifier that appraises Intel TEEs only has no stage 1 " +
			"for it at all.",
		platform: swarmevidence.PlatformSNPQemu,
	}, {
		id:          "composite-full-snp-azure",
		description: "Azure SEV-SNP: the HCL user-data binding again, on the other vendor's branch.",
		platform:    swarmevidence.PlatformSNPAzure,
	}, {
		id: "composite-snp-attested-root",
		description: "A membership root whose own TEE evidence is SEV-SNP, beside a TDX per-request " +
			"quote. The stand-in Verifier covers the quote and not the root, and a path that cannot " +
			"appraise the root must deny rather than report an unanchored chain.",
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
		platform: swarmevidence.PlatformTDXQemu,
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
		referenceValues: []string{imageIdentity},
		quoteTweak: func(a *conformance.RecordedAppraisal) {
			a.MrEnclaveSource = swarmevidence.SourceReferenceValues
		},
	}, {
		id: "composite-quote-only-verifier-no-image-identity",
		description: "A Verifier that appraises the quote and nothing else: it reports the registers " +
			"and no image identity, because mrEnclave needs the RTMR0 event log replayed and " +
			"normalised. Neither `mrenclave` nor `mrenclave_approved` may then appear — a policy " +
			"reading `mrenclave_approved: false` would believe something was checked.",
		platform: swarmevidence.PlatformTDXQemu,
		quoteTweak: func(a *conformance.RecordedAppraisal) {
			a.MrEnclave = ""
			a.MrEnclaveApproved = false
			a.MrEnclaveSource = ""
			a.SpvmBuild = ""
		},
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
		quoteTweak: func(a *conformance.RecordedAppraisal) {
			a.BindingDataSource = ""
		},
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
		description: "The RTMR0 event log the collection carries does not replay to the quote's " +
			"RTMR0, so no image identity can be derived from it. The appraiser reports a failure to " +
			"reach an answer, which is a denial and not an unapproved image.",
		platform: swarmevidence.PlatformTDXQemu,
		quoteTweak: func(a *conformance.RecordedAppraisal) {
			*a = conformance.RecordedAppraisal{
				Error: "the RTMR0 event log does not replay to the quote's RTMR0: " +
					"replayed 9e1f…, the quote carries " + hexFill("r0", 48),
			}
		},
		denyStage:  "root-quote",
		denyReason: "event log does not replay",
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

// imageIdentity is the normalised image identity every case's quote reports.
var imageIdentity = hexFill("5c", 32)

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
		quote:      baseQuote(challengeTypeOf(spec)),
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

	// The recorded appraisal: what the quote committed to, and what an
	// appraiser establishes about it.
	binding := bindingInputs{freshness, target, subject}
	if spec.bindingOver != nil {
		binding = *spec.bindingOver
	}
	quoteAppraisal := recordedQuote(spec.platform, bindingDigest(binding.freshness, binding.target, binding.subject))
	if spec.quoteTweak != nil {
		spec.quoteTweak(&quoteAppraisal)
	}
	rootPlatform := spec.rootPlatform
	if rootPlatform == "" {
		rootPlatform = swarmevidence.PlatformTDXQemu
	}
	rootAppraisal := recordedRoot(rootPlatform)
	if spec.rootTweak != nil {
		spec.rootTweak(&rootAppraisal)
	}
	tokens, err := m.recordTokens(profiles, rootAppraisal, quoteAppraisal)
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
				FreshnessInput:  hexOf(freshness),
				Target:          b64(target),
				Subject:         b64(subject),
				TrustedRoots:    trustedRoots,
				Now:             referenceNow,
				MaxEvidenceAge:  spec.maxEvidenceAge,
				ReferenceValues: spec.referenceValues,
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
	quote, root        conformance.RecordedAppraisal
	statement          map[string]any
	envelope           map[string]any
	signer, node       *testca.Cert
	profiles           []conformance.AppraiserProfile
	hasStatement       bool
	hasEnvelope        bool
}

// expectation writes what the profile says this evidence establishes.
//
// It is assembled from the case's own declarations — the appraisal it
// records, the certificates it chains through, the statement it carries — and
// never from the verifier: a corpus whose expectations came out of the code
// under test would pass by construction.
func (m *material) expectation(spec caseSpec, in expectationInputs) (conformance.CompositeExpect, error) {
	if spec.denyStage != "" {
		return conformance.CompositeExpect{
			OK:             false,
			Stage:          spec.denyStage,
			ReasonContains: spec.denyReason,
			Claims:         denialClaims(in.freshness, spec.denyStage),
		}, nil
	}

	claims := map[string]any{
		"schema_version":         swarmevidence.ClaimsVersion,
		"freshness_input":        hexOf(in.freshness),
		"binding_ok":             true,
		"binding_subject_digest": hexOf(sha256Of(in.subject)),

		"platform":           string(in.quote.Platform),
		"quote_verified":     in.quote.QuoteVerified,
		"quote_appraiser":    conformance.AppraiserPlaceholder,
		"tcb_status":         string(in.quote.TCBStatus),
		"collateral_checked": in.quote.CollateralChecked,

		"pki_root_fingerprint": m.root.Fingerprint(),
		"pki_chain_ok":         true,
		"root_quote_ok":        in.root.QuoteVerified && in.root.KeyBinding,
		"network_type":         string(in.root.NetworkType),
	}
	measurements, err := document(in.quote.Measurements)
	if err != nil {
		return conformance.CompositeExpect{}, err
	}
	if len(measurements) > 0 {
		claims["measurements"] = measurements
	}
	security, err := document(in.quote.PlatformSecurity)
	if err != nil {
		return conformance.CompositeExpect{}, err
	}
	if len(security) > 0 {
		claims["platform_security"] = security
	}

	// An image identity is reported only when something established one. A
	// quote-only Verifier cannot, and `mrenclave_approved: false` would tell
	// a policy that a registry answered.
	if in.quote.MrEnclave != "" || in.quote.MrEnclaveApproved {
		claims["mrenclave"] = in.quote.MrEnclave
		claims["mrenclave_approved"] = in.quote.MrEnclaveApproved
		if in.quote.MrEnclaveSource != "" {
			claims["mrenclave_source"] = string(in.quote.MrEnclaveSource)
		}
	}
	if in.quote.SpvmBuild != "" {
		claims["spvm_build"] = in.quote.SpvmBuild
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

	expect := conformance.CompositeExpect{OK: true, Claims: claims}

	// A profile that does not cover this case's platforms refuses, and the
	// refusal is part of the contract: the coverage difference between paths
	// is asserted here rather than described in a document.
	for _, profile := range in.profiles {
		if profile.Kind != "eat" || profile.OutsideCoverage == nil {
			continue
		}
		if covers(profile, string(in.root.Platform)) && covers(profile, string(in.quote.Platform)) {
			continue
		}
		if expect.Appraisers == nil {
			expect.Appraisers = map[string]*conformance.CompositeExpect{}
		}
		expect.Appraisers[profile.Name] = &conformance.CompositeExpect{
			OK:             false,
			Stage:          profile.OutsideCoverage.Stage,
			ReasonContains: "outside that coverage",
			Claims:         denialClaims(in.freshness, profile.OutsideCoverage.Stage),
		}
	}
	return expect, nil
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

// recordedQuote is a per-request quote appraisal on one platform: the
// registers that platform reports, and the guest-chosen field the binding
// digest is compared against.
func recordedQuote(platform swarmevidence.Platform, binding []byte) conformance.RecordedAppraisal {
	appraisal := conformance.RecordedAppraisal{
		Platform:          platform,
		QuoteVerified:     true,
		TCBStatus:         swarmevidence.TCBOK,
		CollateralChecked: true,
		BindingData:       hexOf(binding),
		BindingDataSource: swarmevidence.BindingFromReportData,
		MrEnclave:         imageIdentity,
		MrEnclaveApproved: true,
		MrEnclaveSource:   swarmevidence.SourceRegistry,
		SpvmBuild:         "build-448-release",
	}
	if platform == swarmevidence.PlatformTDXAzure || platform == swarmevidence.PlatformSNPAzure {
		// On the Azure nested form the hardware report data is the
		// paravisor's, so the guest-chosen field is the HCL user-data.
		appraisal.BindingDataSource = swarmevidence.BindingFromHCLUserData
	}
	appraisal.Measurements, appraisal.PlatformSecurity = platformFacts(platform)
	return appraisal
}

// recordedRoot is the appraisal of the membership root's own TEE evidence:
// the step that makes the attestation about this certificate authority rather
// than about some VM.
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
		SpvmBuild:         "build-448-release",
	}
	appraisal.Measurements, appraisal.PlatformSecurity = platformFacts(platform)
	return appraisal
}

// platformFacts are the registers and the report fields each platform
// reports. Which members are populated is the platform's, which is why a
// policy reads `platform` before any of them.
func platformFacts(platform swarmevidence.Platform) (swarmevidence.Measurements, swarmevidence.PlatformSecurity) {
	switch platform {
	case swarmevidence.PlatformSNPQemu, swarmevidence.PlatformSNPAzure:
		return swarmevidence.Measurements{
				LaunchDigest: hexFill("1d", 48),
			}, swarmevidence.PlatformSecurity{
				VMPL:             0,
				DebugAllowed:     false,
				CiphertextHiding: true,
				PageSwapDisabled: true,
				SnpFirmwareTCB:   23,
				ReportVersion:    3,
				CPUGeneration:    "Genoa",
			}
	default:
		return swarmevidence.Measurements{
				TDAttributes: "0000001000000000",
				MRTD:         hexFill("4d", 48),
				RTMR0:        hexFill("r0", 48),
				RTMR1:        hexFill("r1", 48),
				RTMR2:        hexFill("r2", 48),
				RTMR3:        hexFill("r3", 48),
			}, swarmevidence.PlatformSecurity{
				ReportVersion: 4,
				CPUGeneration: "Emerald Rapids",
			}
	}
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
