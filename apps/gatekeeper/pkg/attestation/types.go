package attestation

import (
	"encoding/json"
	"fmt"
)

// EvidenceKind is the kind of evidence a bundle carries.
type EvidenceKind string

// The three kinds the unified /.well-known/swarm-evidence contract defines.
// Confidential Router endpoints publish DeploymentEvidence; the other two are
// accepted by the verifier for parity with the TypeScript implementation and
// rejected higher up, by policy.
const (
	KindDeploymentEvidence             EvidenceKind = "DeploymentEvidence"
	KindControlPlaneEvidence           EvidenceKind = "ControlPlaneEvidence"
	KindKubernetesControlPlaneEvidence EvidenceKind = "KubernetesControlPlaneEvidence"
)

func (k EvidenceKind) valid() bool {
	switch k {
	case KindDeploymentEvidence, KindControlPlaneEvidence, KindKubernetesControlPlaneEvidence:
		return true
	default:
		return false
	}
}

// RootCaTeeQuote is the TEE quote over the root CA key. The verifier parses and
// passes it through; validating it is a separate concern (ADR-003 §2 reserves a
// quoteVerifier hook).
type RootCaTeeQuote struct {
	Format     string          `json:"format"`
	Data       string          `json:"data"`
	Collateral json.RawMessage `json:"collateral,omitempty"`
}

// Bundle is the document served at /.well-known/swarm-evidence.
type Bundle struct {
	Version         string          `json:"version"`
	Kind            EvidenceKind    `json:"kind"`
	Hostname        string          `json:"hostname"`
	IssuedAt        string          `json:"issuedAt"`
	CertFingerprint string          `json:"certFingerprint"`
	JWS             string          `json:"jws"`
	CertChain       []string        `json:"certChain"`
	RootCaTeeQuote  *RootCaTeeQuote `json:"rootCaTeeQuote,omitempty"`
	// TLSLeaf lets verifiers without channel access bind the JWS to a concrete
	// certificate. The gatekeeper observes its own handshake and ignores it
	// (ADR-003 §1); the field exists so the producer-asserted fallback stays
	// bit-compatible with the TypeScript verifier.
	TLSLeaf string `json:"tlsLeaf,omitempty"`
}

// Payload is the verified JWS body: one of the three evidence payloads.
type Payload interface {
	// Base returns the fields every payload kind carries.
	Base() PayloadBase
	// Raw returns the exact JSON bytes the JWS was signed over.
	Raw() json.RawMessage

	sealedPayload()
}

// PayloadBase holds the fields common to every evidence payload. These are the
// only ones the verifier requires; kind-specific fields are best-effort, exactly
// as in the TypeScript verifier, so neither implementation can reject a bundle
// the other accepts.
type PayloadBase struct {
	Version         string       `json:"version"`
	Kind            EvidenceKind `json:"kind"`
	Hostname        string       `json:"hostname"`
	IssuedAt        string       `json:"issuedAt"`
	CertFingerprint string       `json:"certFingerprint"`

	raw json.RawMessage
}

// Base implements Payload.
func (p PayloadBase) Base() PayloadBase { return p }

// Raw implements Payload.
func (p PayloadBase) Raw() json.RawMessage { return p.raw }

func (p PayloadBase) sealedPayload() {}

// DeploymentEvidencePayload is what a Confidential Router endpoint publishes:
// the digest of the canonical deployment snapshot users pin, plus the snapshot.
type DeploymentEvidencePayload struct {
	PayloadBase
	EvidenceDigest string          `json:"evidenceDigest,omitempty"`
	Evidence       json.RawMessage `json:"evidence,omitempty"`
}

// ControlPlaneEvidencePayload is published by a Swarm Cloud control plane.
type ControlPlaneEvidencePayload struct {
	PayloadBase
	TopologyDigest string          `json:"topologyDigest,omitempty"`
	Topology       json.RawMessage `json:"topology,omitempty"`
}

// KubernetesControlPlaneTopologyEntry is one node of a k8s control plane.
type KubernetesControlPlaneTopologyEntry struct {
	NodeID              string  `json:"nodeId"`
	Role                string  `json:"role"`
	WgIP                *string `json:"wgIp"`
	TEE                 *string `json:"tee,omitempty"`
	NodeCertFingerprint *string `json:"nodeCertFingerprint,omitempty"`
}

// KubernetesControlPlaneEvidencePayload is published by an RKE2 control plane.
type KubernetesControlPlaneEvidencePayload struct {
	PayloadBase
	RKE2Version        string                                `json:"rke2Version,omitempty"`
	InstallHash        string                                `json:"installHash,omitempty"`
	KubeSystemDigest   string                                `json:"kubeSystemDigest,omitempty"`
	ClusterID          string                                `json:"clusterId,omitempty"`
	ImageDigests       map[string][]string                   `json:"imageDigests,omitempty"`
	Topology           []KubernetesControlPlaneTopologyEntry `json:"topology,omitempty"`
	KubeSystemSnapshot json.RawMessage                       `json:"kubeSystemSnapshot,omitempty"`
	CollectedAt        string                                `json:"collectedAt,omitempty"`
}

// TrustedRoot is one entry of the user's trust store: a name and the root CA
// PEM it stands for.
type TrustedRoot struct {
	Name string `json:"name"`
	PEM  string `json:"pem"`
}

// Stage names the step of the pipeline a verification failed at. The set and
// the spelling are shared with the TypeScript verifier and with
// docs/adr/ADR-003 §1.
type Stage string

// The pipeline stages, in order.
const (
	StageFetch          Stage = "fetch"
	StageCertChain      Stage = "cert-chain"
	StageUntrustedRoot  Stage = "untrusted-root"
	StageJWS            Stage = "jws"
	StageTLSFingerprint Stage = "tls-fingerprint"
)

// ChannelBinding records how the signed certFingerprint was tied to a concrete
// TLS certificate.
type ChannelBinding string

const (
	// BindingObserved means the fingerprint came from the verifier's own TLS
	// handshake. This is the only binding the gatekeeper accepts in production.
	BindingObserved ChannelBinding = "observed"
	// BindingProducerAsserted means the bundle's tlsLeaf was hashed instead,
	// because the caller had no channel access. Kept for parity with browser
	// verifiers; the gatekeeper always has channel access.
	BindingProducerAsserted ChannelBinding = "producer-asserted"
)

// MatchedRoot identifies the trusted root the chain terminated at.
type MatchedRoot struct {
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
}

// Result is the verdict of a verification: the Go form of the TypeScript
// `VerifyOk | VerifyErr` union, discriminated by OK.
type Result struct {
	OK bool `json:"ok"`

	// Set when OK.
	Kind           EvidenceKind    `json:"kind,omitempty"`
	Payload        Payload         `json:"-"`
	MatchedRoot    MatchedRoot     `json:"matchedRoot,omitzero"`
	RootCaTeeQuote *RootCaTeeQuote `json:"rootCaTeeQuote,omitempty"`
	ChannelBinding ChannelBinding  `json:"channelBinding,omitempty"`

	// Set when not OK.
	Stage  Stage  `json:"stage,omitempty"`
	Reason string `json:"reason,omitempty"`

	// ObservedTLSFingerprint is the fingerprint of the leaf certificate seen on
	// the handshake this verdict was reached over, when there was one. It is
	// outside the TypeScript union because the Go verifier fetches and observes
	// in the same dial.
	ObservedTLSFingerprint string `json:"observedTlsFingerprint,omitempty"`
}

// Error renders a failed result as an error value; it returns nil when OK.
func (r Result) Error() error {
	if r.OK {
		return nil
	}
	return fmt.Errorf("%s: %s", r.Stage, r.Reason)
}

// Deployment returns the payload as DeploymentEvidence, or false for any other
// kind. It is the accessor the gatekeeper's policy layer uses, since only
// DeploymentEvidence carries an evidenceDigest to pin.
func (r Result) Deployment() (*DeploymentEvidencePayload, bool) {
	p, ok := r.Payload.(*DeploymentEvidencePayload)
	return p, ok
}

func fail(stage Stage, format string, args ...any) Result {
	return Result{OK: false, Stage: stage, Reason: fmt.Sprintf(format, args...)}
}
