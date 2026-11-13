package swarmevidence

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// appraiseCollection appraises the composite form: a CMW collection holding a
// hardware quote, the PKI membership chain, the leader's statement about the
// requesting pod and the node's request envelope.
//
// The order of the legs is not a matter of taste. The membership chain is
// validated and matched against a pinned root first, because until it is, the
// certificates in it are attacker-supplied and appraising the evidence one of
// them carries would mean fetching artefacts an attacker named. The binding
// digest is checked before the envelope and the statement are read, because a
// quote that does not answer this request makes everything paired with it
// irrelevant.
func appraiseCollection(ctx context.Context, blob []byte, opts Options, freshness string) (SwarmClaims, error) {
	parsed, denial := parseCollection(blob)
	if denial != nil {
		return deny(freshness, denial)
	}
	if denial := requireRequestValues(opts); denial != nil {
		return deny(freshness, denial)
	}

	quote, denial := collectionQuote(parsed)
	if denial != nil {
		return deny(freshness, denial)
	}
	pool, denial := collectionPool(parsed)
	if denial != nil {
		return deny(freshness, denial)
	}

	// The envelope names the certificate that signs it, so it is read — not
	// yet trusted — before the chain is built, to know which certificate the
	// chain should be built for. Nothing from this read is believed: the
	// signature check below is under the certificate it named, so a forged
	// name selects a certificate whose key cannot have produced the signature.
	signedEnvelope, denial := collectionEnvelope(parsed)
	if denial != nil {
		return deny(freshness, denial)
	}
	nodeCertIndex, denial := nodeCertificateIndex(pool, signedEnvelope)
	if denial != nil {
		return deny(freshness, denial)
	}

	chain, matchedRoot, denial := membershipChain(pool, nodeCertIndex, opts)
	if denial != nil {
		return deny(freshness, denial)
	}

	appraiser := opts.appraiser()
	rootAppraisal, denial := appraiseRoot(ctx, chain, appraiser)
	if denial != nil {
		return deny(freshness, denial)
	}

	quoteAppraisal, denial := appraiseQuote(ctx, quote, appraiser)
	if denial != nil {
		return deny(freshness, denial)
	}
	if denial := checkBinding(quoteAppraisal, opts); denial != nil {
		return deny(freshness, denial)
	}

	envelope, denial := verifyEnvelope(signedEnvelope, chain, opts)
	if denial != nil {
		return deny(freshness, denial)
	}
	statement, denial := verifyStatement(parsed, pool, opts)
	if denial != nil {
		return deny(freshness, denial)
	}
	if denial := checkEnvelopeStatementBinding(envelope, statement); denial != nil {
		return deny(freshness, denial)
	}

	return compositeClaims(opts, freshness, quoteAppraisal, rootAppraisal,
		appraiser.Name(), matchedRoot, chain, envelope, statement), nil
}

// requireRequestValues refuses an appraisal of the composite form that was not
// told what request the evidence is supposed to answer.
//
// All three are required rather than optional-with-a-skip. The whole purpose
// of this form over the published bundle is that it binds a quote to one
// request; an appraisal that did not hold the request values could report a
// verified quote and a locked pod that belong to somebody else's request,
// which is exactly the substitution the envelope exists to rule out.
func requireRequestValues(opts Options) *Denial {
	switch {
	case len(opts.FreshnessInput) == 0:
		return denyf(StageOptions,
			"Options.FreshnessInput is required for the composite form: it is one of the three "+
				"values the binding digest commits to")
	case len(opts.RequestTarget) == 0:
		return denyf(StageOptions,
			"Options.RequestTarget is required for the composite form: without the prepared Target "+
				"octets the binding digest cannot be recomputed")
	case len(opts.RequestSubject) == 0:
		return denyf(StageOptions,
			"Options.RequestSubject is required for the composite form: without the subject octets "+
				"the appraisal cannot tell whose key the quote answers for")
	}
	return nil
}

func collectionQuote(parsed *collection) (Quote, *Denial) {
	octets, ok := parsed.octets(ElementQuote)
	if !ok {
		return Quote{}, denyf(StageBlob, "the evidence collection carries no %q element, which is REQUIRED",
			ElementQuote)
	}
	var quote Quote
	if err := json.Unmarshal(octets, &quote); err != nil {
		return Quote{}, denyf(StageBlob, "the %q element is not a readable quote: %v", ElementQuote, err)
	}
	if quote.Type == "" || quote.EvidenceBase64 == "" {
		return Quote{}, denyf(StageBlob, "the %q element declares no type or carries no evidence", ElementQuote)
	}
	return quote, nil
}

func collectionPool(parsed *collection) (*attestation.CertPool, *Denial) {
	octets, ok := parsed.octets(ElementMembership)
	if !ok {
		return nil, denyf(StageBlob, "the evidence collection carries no %q element, which is REQUIRED",
			ElementMembership)
	}
	pool, err := attestation.ParseCertPool(octets)
	if err != nil {
		return nil, denyf(StagePKIChain, "the %q element: %v", ElementMembership, err)
	}
	return pool, nil
}

func collectionEnvelope(parsed *collection) (string, *Denial) {
	octets, ok := parsed.octets(ElementEnvelope)
	if !ok {
		return "", nil
	}
	jws := strings.TrimSpace(string(octets))
	if jws == "" {
		return "", denyf(StageEnvelope, "the %q element is present and empty; an element the attester "+
			"does not have is omitted, never carried empty", ElementEnvelope)
	}
	return jws, nil
}

// nodeCertificateIndex picks the certificate the membership chain is built
// for: the one the envelope names, or — when the collection carries no
// envelope — the PEM file's first certificate, which is the leaf-first order
// the platform's own producers write.
func nodeCertificateIndex(pool *attestation.CertPool, signedEnvelope string) (int, *Denial) {
	if signedEnvelope == "" {
		return 0, nil
	}
	claimed, err := peekEnvelope(signedEnvelope)
	if err != nil {
		return 0, denyf(StageEnvelope, "the %q element is not a readable JWS: %v", ElementEnvelope, err)
	}
	index := pool.IndexOfFingerprint(attestation.FingerprintPrefix + claimed.NodeCertFingerprint)
	if index < 0 {
		return 0, denyf(StageEnvelope,
			"the envelope names node certificate %s, which the %q element does not carry, so the "+
				"certificate it claims to be signed by cannot be checked",
			claimed.NodeCertFingerprint, ElementMembership)
	}
	return index, nil
}

// peekEnvelope reads an unverified envelope body, for the single purpose of
// learning which certificate to check the signature against. Nothing it
// returns is a claim; see the caller.
func peekEnvelope(jws string) (NodeRequestEnvelope, error) {
	var out NodeRequestEnvelope
	segments := strings.Split(jws, ".")
	if len(segments) != 3 {
		return out, errCompactJWS
	}
	body, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return out, err
	}
	var payload envelopePayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return out, err
	}
	if err := json.Unmarshal(payload.Envelope, &out); err != nil {
		return out, err
	}
	return out, nil
}

func membershipChain(
	pool *attestation.CertPool, nodeCertIndex int, opts Options,
) (*attestation.ParsedChain, *attestation.MatchedRoot, *Denial) {
	chain, err := pool.ChainTo(nodeCertIndex, opts.now())
	if err != nil {
		return nil, nil, denyf(StagePKIChain, "%v", err)
	}
	matched, err := attestation.MatchTrustedRoot(chain.RootFingerprint, opts.PKIRoots)
	if err != nil {
		return nil, nil, denyf(StagePKIChain, "%v", err)
	}
	return chain, matched, nil
}

// appraiseQuote appraises the collection's element 1 — the per-request quote,
// whose guest-chosen field carries the binding digest rather than a key hash.
func appraiseQuote(ctx context.Context, quote Quote, appraiser QuoteAppraiser) (*QuoteAppraisal, *Denial) {
	appraisal, err := appraiser.AppraiseQuote(ctx, quote)
	if err != nil {
		return nil, denyf(StageRootQuote, "%v", err)
	}
	if appraisal == nil {
		return nil, denyf(StageRootQuote, "the quote appraiser returned no appraisal")
	}
	return appraisal, nil
}

// checkBinding is the step that makes this quote an answer to this request.
//
// The digest is recomputed locally from the three values the relying party is
// holding and compared with the guest-chosen field the appraiser read out of
// the quote — never with a field an intermediary reported. On the Azure nested
// form that field is the HCL user-data, not the raw REPORT_DATA, which is the
// paravisor's SHA-256(runtime data JSON) ‖ 0³² and carries nothing the guest
// chose; an appraiser that confused the two would compare against a value no
// attester can control, which is why the source is reported and checked.
func checkBinding(appraisal *QuoteAppraisal, opts Options) *Denial {
	if len(appraisal.BindingData) == 0 {
		return denyf(StageBinding,
			"the appraiser reported no guest-chosen field for %s, so the binding digest has nothing "+
				"to be compared against", orUnknownPlatform(appraisal.Platform))
	}
	if appraisal.BindingDataSource == "" {
		return denyf(StageBinding,
			"the appraiser did not say which field it read the binding digest from; on the Azure "+
				"nested form the raw REPORT_DATA is the paravisor's and is not guest-chosen")
	}
	want, err := BindingDigest(opts.FreshnessInput, opts.RequestTarget, opts.RequestSubject,
		len(appraisal.BindingData))
	if err != nil {
		return denyf(StageBinding, "%v", err)
	}
	if subtle.ConstantTimeCompare(want, appraisal.BindingData) != 1 {
		return denyf(StageBinding,
			"the quote's %s is %x, and this request's binding digest is %x: this quote does not "+
				"answer this request",
			appraisal.BindingDataSource, appraisal.BindingData, want)
	}
	return nil
}

// verifyEnvelope checks the node's request envelope against the certificate it
// names and against the request the relying party is holding.
func verifyEnvelope(
	signedEnvelope string, chain *attestation.ParsedChain, opts Options,
) (*NodeRequestEnvelope, *Denial) {
	if signedEnvelope == "" {
		return nil, nil
	}
	body, err := attestation.VerifyCompactJWS(signedEnvelope, chain)
	if err != nil {
		return nil, denyf(StageEnvelope, "the envelope's signature: %v", err)
	}
	var payload envelopePayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, denyf(StageEnvelope, "the envelope payload is not JSON: %v", err)
	}
	if payload.Version != "1" || payload.Kind != EnvelopeKind {
		return nil, denyf(StageEnvelope, "the envelope payload is version %q kind %q, expected \"1\" %q",
			payload.Version, payload.Kind, EnvelopeKind)
	}
	var envelope NodeRequestEnvelope
	if err := json.Unmarshal(payload.Envelope, &envelope); err != nil {
		return nil, denyf(StageEnvelope, "the envelope is not readable: %v", err)
	}
	if envelope.Version != 1 {
		return nil, denyf(StageEnvelope, "envelope version %d is not implemented by this build", envelope.Version)
	}

	hash, err := jcsSHA256(payload.Envelope)
	if err != nil {
		return nil, denyf(StageEnvelope, "the envelope could not be canonicalised: %v", err)
	}
	if hash != payload.EnvelopeHash {
		return nil, denyf(StageEnvelope,
			"the signed envelope_hash %s is not the hash of the envelope beside it (%s)",
			payload.EnvelopeHash, hash)
	}

	// The certificate the chain was built for is the one the envelope named,
	// and the signature above verified under it — so a node cannot attribute
	// its signature to another node's certificate, which a policy keyed on
	// node_cert_fingerprint would otherwise believe.
	if leaf := attestation.FingerprintPrefix + envelope.NodeCertFingerprint; leaf != chain.LeafFingerprint {
		return nil, denyf(StageEnvelope, "envelope node_cert_fingerprint %s is not the chain leaf %s",
			envelope.NodeCertFingerprint, chain.LeafFingerprint)
	}

	if denial := checkEnvelopeRequest(&envelope, opts); denial != nil {
		return nil, denial
	}
	if denial := checkIssuedAt("envelope", envelope.IssuedAt, opts); denial != nil {
		return nil, denial
	}
	return &envelope, nil
}

// checkEnvelopeRequest holds the envelope against the request values the
// relying party already has. Comparing an envelope only against itself would
// prove nothing about *this* request.
func checkEnvelopeRequest(envelope *NodeRequestEnvelope, opts Options) *Denial {
	if want := sha256Base64URL(opts.RequestSubject); envelope.SubjectHash != want {
		return denyf(StageEnvelope,
			"envelope subject_hash %s does not match this request's subject (%s)", envelope.SubjectHash, want)
	}
	// Compared verbatim, never re-prepared: a Target a verifier recoded would
	// differ from the octets the attester hashed into the binding digest.
	if want := base64.RawURLEncoding.EncodeToString(opts.FreshnessInput); envelope.Freshness != want {
		return denyf(StageEnvelope,
			"envelope freshness %s is not the freshness this appraisal was asked to bind (%s): the "+
				"envelope answers some other challenge", envelope.Freshness, want)
	}
	if want := base64.RawURLEncoding.EncodeToString(opts.RequestTarget); envelope.Target != want {
		return denyf(StageEnvelope, "envelope target %s is not this request's target (%s)", envelope.Target, want)
	}
	return nil
}

// verifyStatement checks the leader's statement about the requesting pod.
//
// The statement names no signer, so the signer is found: every certificate in
// the membership PEM file that chains to a pinned root is a candidate, and the
// one whose key the signature verifies under is the leader's. Trying
// candidates is safe — a signature only verifies under the key that produced
// it — and it is what lets one PEM file carry both the node's certificate and
// the per-leader signer's, which are different leaves of the same PKI
// (SUP-636).
func verifyStatement(
	parsed *collection, pool *attestation.CertPool, opts Options,
) (*verifiedStatement, *Denial) {
	octets, ok := parsed.octets(ElementStatement)
	if !ok {
		return nil, nil
	}
	jws := strings.TrimSpace(string(octets))
	if jws == "" {
		return nil, denyf(StageStatement, "the %q element is present and empty; an element the "+
			"attester does not have is omitted, never carried empty", ElementStatement)
	}

	body, signer, denial := verifyUnderPool(jws, pool, opts)
	if denial != nil {
		return nil, denial
	}

	var payload statementPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, denyf(StageStatement, "the statement payload is not JSON: %v", err)
	}
	if payload.Version != "1" || payload.Kind != StatementKind {
		return nil, denyf(StageStatement, "the statement payload is version %q kind %q, expected \"1\" %q",
			payload.Version, payload.Kind, StatementKind)
	}
	var statement WorkloadStatement
	if err := json.Unmarshal(payload.Statement, &statement); err != nil {
		return nil, denyf(StageStatement, "the statement is not readable: %v", err)
	}
	if statement.Version != 1 {
		return nil, denyf(StageStatement, "statement version %d is not implemented by this build",
			statement.Version)
	}

	hash, err := jcsSHA256(payload.Statement)
	if err != nil {
		return nil, denyf(StageStatement, "the statement could not be canonicalised: %v", err)
	}
	if hash != payload.StatementHash {
		return nil, denyf(StageStatement,
			"the signed statement_hash %s is not the hash of the statement beside it (%s)",
			payload.StatementHash, hash)
	}
	if denial := checkIssuedAt("statement", statement.IssuedAt, opts); denial != nil {
		return nil, denial
	}
	return &verifiedStatement{statement: &statement, hash: hash, signer: signer}, nil
}

// verifiedStatement is a statement that verified, together with the two things
// about it the rest of the appraisal needs: the hash the envelope must name,
// recomputed rather than taken from the signature, and who signed it.
type verifiedStatement struct {
	statement *WorkloadStatement
	hash      string
	signer    string
}

// verifyUnderPool finds the certificate in the pool whose chain reaches a
// pinned root and whose key the JWS verifies under, and returns the payload
// and that certificate's fingerprint.
func verifyUnderPool(
	jws string, pool *attestation.CertPool, opts Options,
) ([]byte, string, *Denial) {
	var chainErr, signatureErr error
	for i := range pool.Len() {
		chain, err := pool.ChainTo(i, opts.now())
		if err != nil {
			chainErr = err
			continue
		}
		if _, err := attestation.MatchTrustedRoot(chain.RootFingerprint, opts.PKIRoots); err != nil {
			chainErr = err
			continue
		}
		body, err := attestation.VerifyCompactJWS(jws, chain)
		if err != nil {
			signatureErr = err
			continue
		}
		return body, chain.LeafFingerprint, nil
	}
	switch {
	case signatureErr != nil:
		return nil, "", denyf(StageStatement,
			"no certificate in the %q element that chains to a pinned root signed this statement "+
				"(last signature failure: %v)", ElementMembership, signatureErr)
	case chainErr != nil:
		return nil, "", denyf(StageStatement,
			"no certificate in the %q element chains to a pinned root: %v", ElementMembership, chainErr)
	default:
		return nil, "", denyf(StageStatement, "the %q element carries no usable signer certificate",
			ElementMembership)
	}
}

// checkEnvelopeStatementBinding is the pairing check the envelope exists for.
//
// Both halves of the composite are public documents on their own: a statement
// says "pod X is locked and runs these images" and anyone who has seen it can
// replay it; a quote says "some measured VM asked for a credential over this
// subject". Only the node can say that the pod which asked is the pod the
// statement is about.
//
// Three collections are therefore legal, and a fourth is not. Quote and
// membership alone establish no pod claims and are fine; an envelope with
// nothing to pair is fine and says so by carrying no statement_hash; both
// together are the ordinary case. A statement with **no** envelope is
// refused: it is the substitution shape itself — anyone holding a locked
// pod's published statement could present it beside a quote of their own —
// and emitting the pod claims for it would hand a policy facts that nothing
// ties to the request in hand (CTO, 2026-11-13).
func checkEnvelopeStatementBinding(envelope *NodeRequestEnvelope, statement *verifiedStatement) *Denial {
	if envelope == nil {
		if statement != nil {
			return denyf(StageEnvelope,
				"the collection carries a statement and no envelope binding it to this request: a "+
					"statement is a public document, and without the node's envelope nothing says "+
					"the pod it describes is the pod that asked")
		}
		return nil
	}
	if statement == nil {
		// An envelope with nothing to pair is legal — the profile's
		// "envelope-without-statement" case — but only when it says so.
		if envelope.StatementHash != "" {
			return denyf(StageEnvelope,
				"the envelope binds statement %s and the collection carries no %q element",
				envelope.StatementHash, ElementStatement)
		}
		return nil
	}
	if envelope.StatementHash != statement.hash {
		return denyf(StageEnvelope,
			"envelope statement_hash %s is not the supplied statement's %s: this quote was bound to "+
				"a different statement",
			envelope.StatementHash, statement.hash)
	}
	if envelope.PodUID != statement.statement.Pod.UID {
		return denyf(StageEnvelope,
			"envelope pod_uid %q is not the statement's pod %q",
			envelope.PodUID, statement.statement.Pod.UID)
	}
	return nil
}

// checkIssuedAt bounds how old a signed object may be. Both objects describe
// something that can be replaced at any moment — a pod, a request — so a
// caller minting a credential from one should always set the window; zero
// disables it, which is right only when the freshness input carries the
// anti-replay weight instead.
func checkIssuedAt(what, issuedAt string, opts Options) *Denial {
	stage := StageEnvelope
	if what == "statement" {
		stage = StageStatement
	}
	issued, err := time.Parse(time.RFC3339, issuedAt)
	if err != nil {
		return denyf(stage, "%s issued_at %q is not an RFC 3339 timestamp", what, issuedAt)
	}
	age := opts.now().Sub(issued)
	if age < -attestation.AllowedClockSkew {
		return denyf(stage, "%s issued_at is %s in the future, beyond the allowed skew", what, -age)
	}
	if opts.MaxEvidenceAge > 0 && age > opts.MaxEvidenceAge {
		return denyf(stage, "%s age %s exceeds the %s limit", what, age, opts.MaxEvidenceAge)
	}
	return nil
}

// compositeClaims assembles the claim set a completed composite appraisal
// establishes. Every member it sets was checked above; nothing is copied from
// the evidence without a signature behind it.
func compositeClaims(
	opts Options,
	freshness string,
	quote, root *QuoteAppraisal,
	appraiserName string,
	matchedRoot *attestation.MatchedRoot,
	chain *attestation.ParsedChain,
	envelope *NodeRequestEnvelope,
	statement *verifiedStatement,
) SwarmClaims {
	subjectDigest := sha256Hex(opts.RequestSubject)
	claims := SwarmClaims{
		SchemaVersion:  ClaimsVersion,
		FreshnessInput: freshness,

		BindingOK:            boolOf(true),
		BindingSubjectDigest: subjectDigest,

		Platform:          quote.Platform,
		QuoteVerified:     boolOf(quote.QuoteVerified),
		QuoteAppraiser:    appraiserName,
		TCBStatus:         quote.TCBStatus,
		CollateralChecked: boolOf(quote.CollateralChecked),
		Measurements:      quote.Measurements,
		PlatformSecurity:  quote.PlatformSecurity,
		MrEnclave:         quote.MrEnclave,
		MrEnclaveApproved: boolOf(quote.MrEnclaveApproved),
		MrEnclaveSource:   quote.MrEnclaveSource,
		SpvmBuild:         quote.SpvmBuild,

		PKIRootFingerprint: matchedRoot.Fingerprint,
		PKIChainOK:         boolOf(true),
		RootQuoteOK:        boolOf(root.QuoteVerified && root.KeyBinding),
		// The network class is the PKI root's own declaration, which is where
		// the profile puts it: the membership chain, not the per-request quote.
		NetworkType: root.NetworkType,
	}

	if envelope != nil {
		claims.EnvelopeOK = boolOf(true)
		claims.NodeCertFingerprint = chain.LeafFingerprint
		// Only ever from a verified envelope, and only ever "the node vouched
		// for a GPU attestation token with this hash" — appraising the token
		// itself is the relying party's, not this module's, business.
		claims.GPUAttested = boolOf(envelope.GPUAttestationTokenSHA256 != "")
	}

	if statement != nil {
		pod := statement.statement
		claims.StatementOK = boolOf(true)
		claims.StatementSignerFingerprint = statement.signer
		claims.PodUID = pod.Pod.UID
		claims.Namespace = pod.Pod.Namespace
		claims.ClusterSpaceID = derefString(pod.ClusterSpace.ID)
		claims.ImageDigests = imageDigestsOf(pod)
		claims.Locked = boolOf(pod.ClusterSpace.Locked)
		claims.LockedAt = derefString(pod.ClusterSpace.LockedAt)
		claims.PSSEnforce = derefString(pod.PodSecurity.Enforce)
	}
	return claims
}

// imageDigestsOf collects the digests the statement resolved, from the
// workload's containers and its init containers alike: an init container runs
// with the same access to the cluster space as any other, so a policy that saw
// only the former would be checking half the workload.
//
// Sorted and de-duplicated, so the claim is a set rather than a transcript of
// the producer's iteration order.
func imageDigestsOf(statement *WorkloadStatement) []string {
	var digests []string
	for _, container := range slices.Concat(statement.Containers, statement.InitContainers) {
		if container.ImageDigest != nil && *container.ImageDigest != "" {
			digests = append(digests, *container.ImageDigest)
		}
	}
	slices.Sort(digests)
	return slices.Compact(digests)
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func orUnknownPlatform(platform Platform) string {
	if platform == "" {
		return "this platform"
	}
	return string(platform)
}

// Quote is the composite form's element 1: the hardware quote as the node's
// platform plug-in produces it, with the binding digest in the guest-chosen
// field.
//
// It is the platform's own `PkiChallenge` shape rather than a new one, so the
// node emits one object for both the PKI enrolment it already does and the
// per-request evidence this module appraises.
type Quote struct {
	// Type is the challenge type: "tdx", "tdx-google", "tdx-azure",
	// "sev-snp" or "sev-snp-azure".
	Type string `json:"type"`
	// EvidenceBase64 is the serialised TeeEvidence, standard base64.
	EvidenceBase64 string `json:"evidenceBase64"`
	// NetworkID is the swarm the node enrolled into, when the producer names
	// one. Producer-supplied and not a claim.
	NetworkID string `json:"networkID,omitempty"`
	// NvidiaTokens are the GPU attestation tokens the node holds. They are
	// carried here for a relying party that wants to appraise them itself;
	// this module reads GPU attestation only from the envelope's hash, because
	// the quote has no room beside the binding digest to commit to one.
	NvidiaTokens map[string]string `json:"nvidiaTokens,omitempty"`
}

// Evidence decodes the serialised TeeEvidence the quote carries.
func (q Quote) Evidence() ([]byte, error) {
	return base64.StdEncoding.DecodeString(q.EvidenceBase64)
}

// bindingDataSourceOf renames the attested-root field in the claim core's
// vocabulary, by an explicit switch: a source this build does not know must
// not be reported as one it does, because checkBinding treats an empty source
// as "the appraiser did not say" and denies.
func bindingDataSourceOf(source attestedroot.ReportDataSource) BindingDataSource {
	switch source {
	case attestedroot.ReportDataQuote:
		return BindingFromReportData
	case attestedroot.ReportDataHCLUserData:
		return BindingFromHCLUserData
	default:
		return ""
	}
}

// sha256Hex is how the claim set spells a digest of request material:
// lowercase hex, which is what the schema's patterns pin for
// `binding_subject_digest` and `freshness_input`. It is deliberately not the
// unpadded base64url the TACRA wire uses — a claim set is read by a policy
// author, and the two encodings are kept apart so neither is mistaken for the
// other.
func sha256Hex(octets []byte) string {
	sum := sha256.Sum256(octets)
	return hex.EncodeToString(sum[:])
}

// errCompactJWS is the shape failure both JWS readers report.
var errCompactJWS = errors.New("a compact JWS must have exactly 3 segments")
