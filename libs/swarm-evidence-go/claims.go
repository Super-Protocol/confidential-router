package swarmevidence

import "fmt"

// ClaimsVersion is the SwarmClaims version this module emits. It is the
// contract a policy, an EAR mapping and the conformance vectors are written
// against, so it is a claim of its own rather than a build detail.
const ClaimsVersion = "1"

// Platform is the attester's TEE and the cloud it runs in, in the spelling the
// claim set uses. It is the discriminator a policy reads before any other
// claim, because which claims are meaningful depends on it: on the two Azure
// branches the hardware measurement describes Microsoft's paravisor and the
// image identity comes from the vTPM instead.
type Platform string

// The five platforms Super Swarm evidence can come from. They are the
// TeeEvidence types of the platform's own schema, not a new taxonomy.
const (
	PlatformTDXQemu  Platform = "tdx-qemu"
	PlatformTDXGCP   Platform = "tdx-gcp"
	PlatformTDXAzure Platform = "tdx-azure"
	PlatformSNPQemu  Platform = "snp-qemu"
	PlatformSNPAzure Platform = "snp-azure"
)

// TCBStatus is an appraiser's verdict about the platform's trusted computing
// base. The value is the appraiser's own vocabulary and is only meaningful
// beside [SwarmClaims.QuoteAppraiser]: Intel Trust Authority answers in
// Intel's terms, and the built-in appraiser answers with the three values
// below, of which TCBUnknown is the default — it consults no collateral unless
// asked to, so claiming anything else would be an unearned reassurance.
type TCBStatus string

// The built-in appraiser's TCB vocabulary.
const (
	// TCBUnknown means no collateral was consulted. It is not a clean bill of
	// health, and a policy that treats it as one has mis-read this claim.
	TCBUnknown TCBStatus = "unknown"
	// TCBOK means the vendor collateral was fetched and the chain was clean.
	TCBOK TCBStatus = "ok"
	// TCBRevokedOrIndeterminate means the collateral check did not come back
	// clean. The two are reported together because the vendor libraries fold a
	// revoked certificate and an unreadable CRL into the same answer.
	TCBRevokedOrIndeterminate TCBStatus = "revoked-or-indeterminate"
)

// MrEnclaveSource names what vouched for the image identity.
type MrEnclaveSource string

const (
	// SourceRegistry means Super Protocol signed this measurement, checked
	// against a key pinned in this module. It is the closed chain.
	SourceRegistry MrEnclaveSource = "registry"
	// SourceReferenceValues means the caller's own reference values admitted
	// it — the CoRIM of SUP-640, or an operator's pin. It proves strictly less:
	// that the VM ran the image whoever configured the verifier decided to
	// accept, rather than one Super Protocol published. Every hardware leg of
	// the appraisal still had to pass.
	SourceReferenceValues MrEnclaveSource = "reference-values"
)

// ChannelBinding records how the signed evidence was tied to a concrete TLS
// certificate, for the bundle form of the evidence.
type ChannelBinding string

const (
	// BindingObserved means the fingerprint came from the verifier's own TLS
	// handshake.
	BindingObserved ChannelBinding = "observed"
	// BindingProducerAsserted means the evidence's own copy of the certificate
	// was hashed instead, because the verifier had no channel access. It binds
	// the statement to a certificate the producer named, not to the connection
	// the claims will be acted on — a policy that requires channel binding
	// must refuse it.
	BindingProducerAsserted ChannelBinding = "producer-asserted"
)

// NetworkType is which Super Protocol network a PKI root declares it belongs
// to. It is reported and never enforced: the live Swarm stand's root declares
// "untrusted", and a verifier that refused it would look exactly like a broken
// one.
type NetworkType string

// The two network classes a root's own certificate extension can state.
const (
	NetworkTrusted   NetworkType = "trusted"
	NetworkUntrusted NetworkType = "untrusted"
)

// Measurements are the raw hardware registers an appraisal read, hex-encoded
// exactly as the quote carries them.
//
// A reference-value set names these directly — a CoRIM publishes
// {TDATTRIBUTES, MRTD, RTMR1, RTMR2, RTMR3}, because raw RTMR0 accumulates
// boot events and is not usable as one — and the normalised
// [SwarmClaims.MrEnclave] is derived from them. Which members are populated
// depends on [SwarmClaims.Platform].
type Measurements struct {
	TDAttributes string `json:"tdattributes,omitempty"`
	MRTD         string `json:"mrtd,omitempty"`
	RTMR0        string `json:"rtmr0,omitempty"`
	RTMR1        string `json:"rtmr1,omitempty"`
	RTMR2        string `json:"rtmr2,omitempty"`
	RTMR3        string `json:"rtmr3,omitempty"`
	// LaunchDigest is the SEV-SNP report's MEASUREMENT field.
	LaunchDigest string `json:"launch_digest,omitempty"`
}

// PlatformSecurity are the report fields that describe how the VM was allowed
// to run. They are reported and never judged: whether ciphertext hiding being
// off disqualifies a cloud is the policy's decision, and deciding it here would
// make the verdict unarguable.
type PlatformSecurity struct {
	// VMPL is the privilege level the report was produced at; 0 is highest.
	VMPL uint32 `json:"vmpl"`
	// DebugAllowed means the host may decrypt the guest. It is the one field
	// whose bad value nobody sensibly tolerates.
	DebugAllowed bool `json:"debug_allowed"`
	// CiphertextHiding and PageSwapDisabled are hardening options a policy may
	// or may not require.
	CiphertextHiding bool `json:"ciphertext_hiding"`
	PageSwapDisabled bool `json:"page_swap_disabled"`
	// SnpFirmwareTCB is the SNP firmware security-version number from the
	// launch TCB.
	SnpFirmwareTCB uint8 `json:"snp_firmware_tcb"`
	// ReportVersion is the attestation report format version.
	ReportVersion uint32 `json:"report_version"`
	// CPUGeneration is the vendor CPU line the verified chain belongs to.
	CPUGeneration string `json:"cpu_generation,omitempty"`
}

// SwarmClaims v1 is what an appraisal of Super Swarm evidence establishes, and
// nothing more. The predicates — image in the approved set, space locked, Pod
// Security Standard restricted, network type trusted, sp-vm build in the
// reference values — are deliberately absent: they are the relying party's
// policy, which is the whole point of handing it a claim set instead of a
// verdict. The core reports; the policy decides.
//
// Two rules make the document safe to write a policy against:
//
//   - A claim that is absent was not established. Only SchemaVersion is always
//     present; every other member is a pointer or omitempty, so "false" and
//     "not checked" are never spelled the same way, and a policy that forgets a
//     claim fails rather than passes. In particular MrEnclaveApproved false is
//     a statement — the registry answered, and the answer was "not one of ours"
//     — which is why it is a *bool and not a bool.
//   - A set of claims never describes a partial appraisal. When the core cannot
//     appraise the evidence it returns [Denial] and the claim set carries
//     nothing but the denial, the schema version and the freshness input it was
//     asked to bind — never some verified-looking subset of the rest.
//
// The JSON member names, not the Go field names, are the contract; they are
// published as a JSON Schema by [Schema].
type SwarmClaims struct {
	// SchemaVersion is [ClaimsVersion].
	SchemaVersion string `json:"schema_version"`

	// FreshnessInput is the freshness element the appraisal was asked to
	// bind, hex, reported verbatim.
	//
	// Its size is the Freshness Kind's, not this module's: 32 octets for the
	// TACRA Vault profile's `present-nonce` Handle, 8 for its
	// `absent-timestamp`. What is fixed at 64 octets is the quote field the
	// binding digest goes into, which is a different value.
	//
	// It is an echo of the input, never a verified claim: what proves the
	// attester saw it is BindingOK. Reporting it regardless — including on a
	// denial — is what lets a relying party match a claim set to the challenge
	// it issued.
	FreshnessInput string `json:"freshness_input,omitempty"`

	// BindingOK is whether the quote's guest-chosen field commits to
	// SHA-512(len32‖freshness‖len32‖target‖len32‖subject), and so whether this
	// quote answers this request. Absent for the bundle form, which is about a
	// served hostname and binds no request.
	BindingOK *bool `json:"binding_ok,omitempty"`
	// BindingSubjectDigest is SHA-256 of the request subject the binding
	// covers.
	BindingSubjectDigest string `json:"binding_subject_digest,omitempty"`
	// ChannelBinding is how the bundle form's signed statement was tied to a
	// concrete TLS certificate. Absent for evidence that is not channel-bound.
	ChannelBinding ChannelBinding `json:"channel_binding,omitempty"`

	// Platform is the attester's TEE and cloud.
	Platform Platform `json:"platform,omitempty"`
	// QuoteVerified is whether the hardware quote's signature and its chain to
	// the CPU vendor's root were checked and held.
	QuoteVerified *bool `json:"quote_verified,omitempty"`
	// QuoteAppraiser names what appraised the quote, which is what makes
	// TCBStatus readable.
	QuoteAppraiser string `json:"quote_appraiser,omitempty"`
	// TCBStatus is that appraiser's verdict about the platform TCB.
	TCBStatus TCBStatus `json:"tcb_status,omitempty"`
	// CollateralChecked is whether vendor collateral — CRLs, TCB info — was
	// consulted at all. False means TCBStatus says nothing.
	CollateralChecked *bool `json:"collateral_checked,omitempty"`

	// Measurements are the raw registers the appraisal read.
	Measurements Measurements `json:"measurements,omitzero"`
	// PlatformSecurity are the report's policy and TCB fields.
	PlatformSecurity PlatformSecurity `json:"platform_security,omitzero"`

	// MrEnclave is the normalised, vCPU-independent image identity
	// (sp-vm/docs/04-vm-measurements.md).
	MrEnclave string `json:"mrenclave,omitempty"`
	// MrEnclaveApproved is whether anything vouches for that image, and
	// MrEnclaveSource is what did. Approved with no source is impossible.
	MrEnclaveApproved *bool           `json:"mrenclave_approved,omitempty"`
	MrEnclaveSource   MrEnclaveSource `json:"mrenclave_source,omitempty"`
	// SpvmBuild is the sp-vm release the evidence claims the VM booted, when it
	// names one. It is producer-supplied: it located the artefacts the
	// measurement was rebuilt from, and proves nothing on its own.
	SpvmBuild string `json:"spvm_build,omitempty"`

	// PKIRootFingerprint is the `sha256/<base64url>` digest of the root the
	// chain terminated at, and PKIChainOK whether the chain validated to it.
	PKIRootFingerprint string `json:"pki_root_fingerprint,omitempty"`
	PKIChainOK         *bool  `json:"pki_chain_ok,omitempty"`
	// RootQuoteOK is whether the root certificate's own TEE evidence verified
	// and committed to that certificate's public key — the step that makes the
	// attestation about this CA rather than about some VM.
	RootQuoteOK *bool `json:"root_quote_ok,omitempty"`
	// NetworkType is what the root says about its own network, "trusted" or
	// "untrusted". Reported, never enforced: the live Swarm stand's root
	// declares "untrusted".
	NetworkType NetworkType `json:"network_type,omitempty"`

	// EvidenceDigest is the digest of the canonical deployment snapshot a user
	// pins, for evidence that carries one.
	EvidenceDigest string `json:"evidence_digest,omitempty"`

	// StatementSignerFingerprint and StatementOK describe the control-plane
	// statement's signature, chained to the pinned root through the per-leader
	// signer (SUP-636). StatementOK says the leader signed it; what says the
	// statement is about the request being appraised is EnvelopeOK, which is
	// why no statement is appraised without one — see the pod claims below.
	StatementSignerFingerprint string `json:"statement_signer_fingerprint,omitempty"`
	StatementOK                *bool  `json:"statement_ok,omitempty"`

	// EnvelopeOK, NodeCertFingerprint and GPUAttested come from the
	// node-signed NodeRequestEnvelope (SUP-637). GPUAttested derives from the
	// envelope's gpu_attestation_token_sha256 and never from the quote: the
	// TACRA digest owns all 64 bytes of report data, so there is no room beside
	// it for a GPU token hash.
	EnvelopeOK          *bool  `json:"envelope_ok,omitempty"`
	NodeCertFingerprint string `json:"node_cert_fingerprint,omitempty"`
	GPUAttested         *bool  `json:"gpu_attested,omitempty"`

	// The statement's claims about the workload (SUP-634, SUP-636).
	//
	// They are what the leader signed, and StatementOK is what makes them
	// readable. What makes them *this request's* is the node's envelope: a
	// statement is a public document, and anyone who has seen one can present
	// it beside a quote of their own — the draft's attester substitution.
	//
	// So the core never emits them on their own: **a pod claim is only ever
	// reported beside EnvelopeOK true**, because a collection carrying a
	// statement and no envelope is refused at the envelope stage. StatementOK
	// and EnvelopeOK stay separate claims — they answer different questions,
	// and a policy may want to read either — but neither of them being absent
	// can leave a policy reading pod facts that nothing binds to its request.
	PodUID         string   `json:"pod_uid,omitempty"`
	Namespace      string   `json:"namespace,omitempty"`
	ClusterSpaceID string   `json:"cluster_space_id,omitempty"`
	ImageDigests   []string `json:"image_digests,omitempty"`
	Locked         *bool    `json:"locked,omitempty"`
	LockedAt       string   `json:"locked_at,omitempty"`
	PSSEnforce     string   `json:"pss_enforce,omitempty"`

	// Denial is set, and everything above it beyond SchemaVersion and
	// FreshnessInput left empty, when the evidence could not be appraised.
	Denial *Denial `json:"denial,omitempty"`
}

// DenialStage names the step of the appraisal that refused. The set is the
// claim set's own vocabulary rather than the bundle pipeline's, because a
// relying party reads it beside the claims and not beside our code.
type DenialStage string

const (
	// StageOptions is a caller mistake: the appraisal was asked for without
	// something it cannot proceed without.
	StageOptions DenialStage = "options"
	// StageBlob is evidence that is not a shape this module can read.
	StageBlob DenialStage = "blob"
	// StagePKIChain is a certificate chain that did not validate, or that
	// terminated at a root the caller did not pin.
	StagePKIChain DenialStage = "pki-chain"
	// StageRootQuote is a root certificate whose TEE evidence could not be
	// appraised: absent, unreadable, not signed by the vendor, not committed to
	// the certificate's key — or an appraiser that could not answer.
	//
	// It is not what a *negative* answer produces. "This image is not one
	// anybody vouches for" is a claim a policy decides on, so it is reported as
	// MrEnclaveApproved false, not hidden behind a denial.
	StageRootQuote DenialStage = "root-quote"
	// StageCoverage is an attester the configured appraiser does not cover:
	// a platform whose quote it cannot appraise, or whose image identity a
	// quote alone never establishes.
	//
	// It is kept apart from root-quote because it is the one refusal that
	// says nothing about the evidence. The evidence may be perfect; the
	// relying party's Verifier simply does not reach a verdict about this
	// platform, and what clears it is a different appraiser rather than a
	// different attester. A relying party reading it knows to fall back to
	// the built-in offline appraiser instead of investigating a node.
	StageCoverage DenialStage = "coverage"
	// StageBinding is evidence that does not answer the request it was
	// presented for: a report data digest, or a channel binding, that does not
	// hold.
	StageBinding DenialStage = "binding"
	// StageEnvelope is a NodeRequestEnvelope that did not verify (SUP-637).
	StageEnvelope DenialStage = "envelope"
	// StageStatement is a control-plane statement that did not verify.
	StageStatement DenialStage = "statement"
)

// Denial is why evidence could not be appraised. It is the error value
// [AppraiseComposite] returns, so a caller may either read the claim set's
// Denial member or unwrap the error — both carry the same stage and reason.
type Denial struct {
	Stage  DenialStage `json:"stage"`
	Reason string      `json:"reason"`
}

// Error implements error.
func (d *Denial) Error() string {
	if d == nil {
		return ""
	}
	return string(d.Stage) + ": " + d.Reason
}

func denyf(stage DenialStage, format string, args ...any) *Denial {
	return &Denial{Stage: stage, Reason: fmt.Sprintf(format, args...)}
}

// deny builds the only claim set a refused appraisal may produce: the schema
// version, the freshness input the caller asked to bind, and why. Nothing else
// is filled in, so no reader can mistake a refusal for a partial pass.
func deny(freshness string, d *Denial) (SwarmClaims, error) {
	return SwarmClaims{
		SchemaVersion:  ClaimsVersion,
		FreshnessInput: freshness,
		Denial:         d,
	}, d
}

// boolOf is how a boolean claim is recorded. It exists because the pointer is
// load-bearing: a claim set says "false" by carrying false, never by leaving
// the member out.
func boolOf(value bool) *bool { return &value }
