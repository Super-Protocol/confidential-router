package swarmevidence

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/gowebpki/jcs"
)

// StatementKind and EnvelopeKind are the `kind` discriminators of the two
// signed objects the composite form carries, as SUP-636 mints them.
const (
	StatementKind = "WorkloadAttestationStatement"
	EnvelopeKind  = "NodeRequestEnvelope"
)

// WorkloadStatement is the leader's statement about one pod: what the control
// plane admitted, re-issued when its content changes and at no other time.
//
// The member names are the wire contract — snake_case, and every absent fact
// an explicit null rather than a missing key, so that a policy requiring
// `locked` true or `pod_security.enforce` "restricted" can tell "the control
// plane says no" from "this producer did not report it". The canonical
// producer is `swarm-cloud/libs/deployment-evidence-canonical`.
type WorkloadStatement struct {
	Version  int    `json:"version"`
	IssuedAt string `json:"issued_at"`
	Pod      struct {
		UID                string  `json:"uid"`
		Name               string  `json:"name"`
		Namespace          string  `json:"namespace"`
		ServiceAccountName *string `json:"service_account_name"`
		NodeName           *string `json:"node_name"`
		CreatedAt          *string `json:"created_at"`
	} `json:"pod"`
	ClusterSpace struct {
		ID        *string `json:"id"`
		ClusterID *string `json:"cluster_id"`
		Namespace string  `json:"namespace"`
		Locked    bool    `json:"locked"`
		LockedAt  *string `json:"locked_at"`
	} `json:"cluster_space"`
	Containers     []StatementContainer `json:"containers"`
	InitContainers []StatementContainer `json:"init_containers"`
	PodSecurity    struct {
		Enforce        *string `json:"enforce"`
		EnforceVersion *string `json:"enforce_version"`
		Audit          *string `json:"audit"`
		Warn           *string `json:"warn"`
	} `json:"pod_security"`
	NetworkType *string `json:"network_type"`
	SpVMBuildID *string `json:"sp_vm_build_id"`
}

// StatementContainer pairs a declared container with the digest it resolved
// to. `image` is what the tenant asked for and may be a mutable tag;
// `image_digest` is what the kubelet pulled, and is null when the producer
// could not resolve one.
type StatementContainer struct {
	Name        string  `json:"name"`
	Image       string  `json:"image"`
	ImageDigest *string `json:"image_digest"`
}

// statementPayload is the JWS body the leader signs.
type statementPayload struct {
	Version       string          `json:"version"`
	Kind          string          `json:"kind"`
	StatementHash string          `json:"statement_hash"`
	Statement     json.RawMessage `json:"statement"`
}

// NodeRequestEnvelope is the node's statement that *this* credential request
// came from *this* pod, bound to *this* quote.
//
// It is what closes the attester-substitution gap the other three elements
// leave open: each of them is independently obtainable, so a requester in an
// unlocked cluster space could pair a locked neighbour's published statement
// with a quote from its own node and nothing in the first three elements would
// contradict the pairing. The node is the only party that both authenticated
// the caller and produced the quote.
//
// `freshness` and `target` are carried verbatim — the same octets that went
// into the binding preimage, unpadded base64url — and are never re-prepared.
type NodeRequestEnvelope struct {
	Version       int    `json:"version"`
	IssuedAt      string `json:"issued_at"`
	StatementHash string `json:"statement_hash"`
	// SubjectHash is SHA-256 of the request subject octets, unpadded base64url.
	SubjectHash string `json:"subject_hash"`
	Freshness   string `json:"freshness"`
	Target      string `json:"target"`
	PodUID      string `json:"pod_uid"`
	// NodeCertFingerprint is the unpadded base64url SHA-256 of the node
	// certificate's DER — the TACRA wire form, not the `sha256/`-framed one
	// the published web bundle uses.
	NodeCertFingerprint string `json:"node_cert_fingerprint"`
	// GPUAttestationTokenSHA256 is absent, never null, on a node with no GPU:
	// a policy that requires GPU attestation must be able to tell "this node
	// has no GPU" from "this node reported nothing".
	GPUAttestationTokenSHA256 string `json:"gpu_attestation_token_sha256,omitempty"`
}

// envelopePayload is the JWS body the node signs.
type envelopePayload struct {
	Version      string          `json:"version"`
	Kind         string          `json:"kind"`
	EnvelopeHash string          `json:"envelope_hash"`
	Envelope     json.RawMessage `json:"envelope"`
}

// CanonicalJSON is the RFC 8785 (JCS) serialisation of a JSON document: the
// bytes `statement_hash` and `envelope_hash` are taken over.
//
// Exported because it is the one construction a producer in another language
// and this verifier have to agree on byte for byte — the statements are
// produced by TypeScript (`swarm-cloud/libs/deployment-evidence-canonical`)
// and read here — so it has to be testable against the shared vectors on its
// own, not only through an appraisal that would blame a signature for it.
func CanonicalJSON(document []byte) ([]byte, error) {
	canonical, err := jcs.Transform(document)
	if err != nil {
		return nil, fmt.Errorf("canonicalise: %w", err)
	}
	return canonical, nil
}

// jcsSHA256 is the digest construction both `statement_hash` and
// `envelope_hash` use: SHA-256 over the RFC 8785 canonical serialisation of
// the object, unpadded base64url.
//
// It is recomputed here rather than taken from the signature. Comparing the
// two signed hashes alone would prove that the node referred to the statement
// the leader hashed; recomputing proves it referred to the statement in hand,
// which is what a verifier holding octets off the wire actually needs.
func jcsSHA256(raw json.RawMessage) (string, error) {
	canonical, err := CanonicalJSON(raw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// sha256Base64URL is the wire encoding every octet-string digest travels in on
// the TACRA wire: unpadded base64url, with no `sha256/` framing.
func sha256Base64URL(octets []byte) string {
	sum := sha256.Sum256(octets)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
