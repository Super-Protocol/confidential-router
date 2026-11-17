package main

import (
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/gowebpki/jcs"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/internal/testca"
)

// The instant every certificate validity window is centred on, and the one the
// cases are appraised at. It is the bundle corpus's `referenceNow`, so a
// reader comparing the two corpora is looking at the same clock.
const (
	referenceNow = "2026-01-15T12:00:00.000Z"
	issuedAt     = "2026-01-15T11:55:00.000Z"
	notBefore    = "2026-01-01T00:00:00.000Z"
	notAfter     = "2027-01-01T00:00:00.000Z"
)

// The request the composite cases answer: the TACRA Vault profile's 32-octet
// `present-nonce` Handle, the prepared Target octets, and the DER
// SubjectPublicKeyInfo of CEKpub. All three are supplied verbatim and are
// never re-prepared or re-encoded — a verifier that recoded one of them would
// compute a digest no conformant attester produces.
var (
	requestFreshness = bytes(0x5a, 32)
	requestTarget    = []byte("https://vault.bank.example/v1/payments-db")
	requestSubject   = []byte("\x30\x59\x30\x13CEKpub SubjectPublicKeyInfo DER")
)

// material is the fixture PKI and the key material every case is built from.
// It is minted once per run, from the committed keys and fixed serials, so
// re-running the generator produces byte-identical vectors.
type material struct {
	root, inter, node, signer   *testca.Cert
	unlabelledSigner            *testca.Cert
	foreignRoot, foreignNode    *testca.Cert
	verifierAKey, verifierBKey  *testca.Key
	keysDir, vectorsDir, outDir string
}

func newMaterial(keysDir, vectorsDir string) (*material, error) {
	m := &material{
		keysDir:    keysDir,
		vectorsDir: vectorsDir,
		outDir:     filepath.Join(vectorsDir, "composite"),
	}

	from, err := time.Parse(time.RFC3339, notBefore)
	if err != nil {
		return nil, err
	}
	until, err := time.Parse(time.RFC3339, notAfter)
	if err != nil {
		return nil, err
	}

	ca := func(cn string, serial int64) testca.Template {
		return testca.Template{
			CommonName: cn, NotBefore: from, NotAfter: until,
			IsCA: true, MaxPathLen: -1, Serial: big.NewInt(serial),
			KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		}
	}
	// A device-enrolled end-entity leaf: the authority certified the key
	// against a quote from the measured image, and records that challenge in
	// the extension the signer-binding claim is read from (SUP-697). Both the
	// node's leaf and the per-leader signer's carry it, and neither carries
	// anything that says which of the two it is — the PKI draws no such
	// distinction (SUP-696).
	ee := func(cn string, serial int64) testca.Template {
		return testca.Template{
			CommonName: cn, NotBefore: from, NotAfter: until,
			MaxPathLen: -1, Serial: big.NewInt(serial),
			KeyUsage:      x509.KeyUsageDigitalSignature,
			ChallengeType: "tdx",
		}
	}
	// An end-entity leaf with no challenge extension at all: a chain from
	// outside this PKI, or one issued before the authority recorded the
	// challenge. The corpus carries it so that `unknown` is pinned as a
	// produced value rather than as prose.
	unlabelled := func(cn string, serial int64) testca.Template {
		template := ee(cn, serial)
		template.ChallengeType = ""
		return template
	}

	issue := func(name string, template testca.Template, issuer *testca.Cert) (*testca.Cert, error) {
		key, err := m.key(name)
		if err != nil {
			return nil, err
		}
		return testca.Issue(template, key, issuer)
	}

	if m.root, err = issue("composite-root", ca("Swarm Cloud Conformance Root", 1), nil); err != nil {
		return nil, err
	}
	if m.inter, err = issue("composite-intermediate",
		ca("Swarm Cloud Conformance Intermediate", 2), m.root); err != nil {
		return nil, err
	}
	if m.node, err = issue("composite-node", ee("node-01.swarm-cloud-test", 3), m.inter); err != nil {
		return nil, err
	}
	if m.signer, err = issue("composite-signer", ee("leader.swarm-cloud-test", 4), m.inter); err != nil {
		return nil, err
	}
	// Minted from the signer's own key: the case it serves is about what the
	// *certificate* records, so the key being the same keeps the difference
	// down to the one extension.
	if m.unlabelledSigner, err = issue("composite-signer",
		unlabelled("leader.swarm-cloud-test", 7), m.inter); err != nil {
		return nil, err
	}
	if m.foreignRoot, err = issue("composite-foreign-root", ca("Some Other Cloud Root", 5), nil); err != nil {
		return nil, err
	}
	if m.foreignNode, err = issue("composite-foreign-node",
		ee("node-01.other-cloud", 6), m.foreignRoot); err != nil {
		return nil, err
	}
	if m.verifierAKey, err = m.key("eat-verifier-a"); err != nil {
		return nil, err
	}
	if m.verifierBKey, err = m.key("eat-verifier-b"); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *material) key(name string) (*testca.Key, error) {
	raw, err := os.ReadFile(filepath.Join(m.keysDir, name+".key.pem"))
	if err != nil {
		return nil, fmt.Errorf("read fixture key %q: %w", name, err)
	}
	key, err := testca.KeyFromPEM(raw)
	if err != nil {
		return nil, fmt.Errorf("parse fixture key %q: %w", name, err)
	}
	return key, nil
}

// publicKeyPEM is how an appraiser profile pins the key its recorded EATs are
// signed with: the verification key is configuration, never code.
func publicKeyPEM(key *testca.Key) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return "", err
	}
	return string(pemEncode("PUBLIC KEY", der)), nil
}

// statement is the leader's statement about the requesting pod. Cases mutate a
// copy of it, so a case can break exactly one fact and leave the rest sound.
func baseStatement() map[string]any {
	return map[string]any{
		"version":   1,
		"issued_at": issuedAt,
		"pod": map[string]any{
			"uid":                  "pod-7f3a",
			"name":                 "payments-api-0",
			"namespace":            "tenant-acme",
			"service_account_name": "payments",
			"node_name":            "node-01",
			"created_at":           "2026-01-15T11:40:00.000Z",
		},
		"cluster_space": map[string]any{
			"id":         "space-42",
			"cluster_id": "cluster-7",
			"namespace":  "tenant-acme",
			"locked":     true,
			"locked_at":  "2026-01-15T11:45:00.000Z",
		},
		"containers": []any{map[string]any{
			"name":         "api",
			"image":        "ghcr.io/acme/payments@sha256:" + digestHex("a1"),
			"image_digest": "sha256:" + digestHex("a1"),
		}},
		"init_containers": []any{map[string]any{
			"name":         "migrate",
			"image":        "ghcr.io/acme/migrate@sha256:" + digestHex("b2"),
			"image_digest": "sha256:" + digestHex("b2"),
		}},
		"pod_security": map[string]any{
			"enforce":         "restricted",
			"enforce_version": "v1.31",
			"audit":           "restricted",
			"warn":            "restricted",
		},
		"network_type":   "untrusted",
		"sp_vm_build_id": "build-448-release",
	}
}

func (m *material) baseEnvelope() map[string]any {
	return map[string]any{
		"version":               1,
		"issued_at":             issuedAt,
		"statement_hash":        "",
		"subject_hash":          b64(sha256Of(requestSubject)),
		"freshness":             b64(requestFreshness),
		"target":                b64(requestTarget),
		"pod_uid":               "pod-7f3a",
		"node_cert_fingerprint": b64(sha256Of(m.node.DER)),
	}
}

// baseQuote is the collection's quote element: the producer's own challenge
// spelling, and the serialised TeeEvidence itself.
//
// The evidence is a real message — a parseable TeeEvidence whose registers,
// RTMR0 event list and guest-chosen field are the ones the case is about —
// because the delegated path reads all three out of the quote in hand rather
// than out of anything an intermediary says about it. A placeholder here
// would mean the corpus could only ever be replayed through an appraiser that
// does not look at the evidence.
func baseQuote(challengeType string, evidence []byte) map[string]any {
	return map[string]any{
		"type":           challengeType,
		"evidenceBase64": base64.StdEncoding.EncodeToString(evidence),
		"networkID":      "swarm-cloud-conformance",
	}
}

// collection renders the CMW collection a case presents, in whichever of the
// two serialisations the case asks for.
type collection struct {
	quote      map[string]any
	membership []*testca.Cert
	statement  string // compact JWS, empty when the element is absent
	envelope   string // compact JWS, empty when the element is absent
	standard   bool
	version    int
}

func (c collection) render() (map[string]any, error) {
	var pems string
	for _, cert := range c.membership {
		pems += cert.PEM
	}

	elements := []map[string]any{{
		"type":       swarmevidence.ElementQuote,
		"media_type": "application/vnd.super-protocol.swarm-quote+json",
		"encoding":   "json",
		"value":      c.quote,
	}, {
		"type":       swarmevidence.ElementMembership,
		"media_type": "application/x-pem-file",
		"encoding":   "base64url",
		"value":      b64([]byte(pems)),
	}}
	if c.statement != "" {
		elements = append(elements, map[string]any{
			"type":       swarmevidence.ElementStatement,
			"media_type": "application/jose",
			"encoding":   "json",
			"value":      c.statement,
		})
	}
	if c.envelope != "" {
		elements = append(elements, map[string]any{
			"type":       swarmevidence.ElementEnvelope,
			"media_type": "application/jose",
			"encoding":   "json",
			"value":      c.envelope,
		})
	}

	if !c.standard {
		version := c.version
		if version == 0 {
			version = 1
		}
		return map[string]any{"collection": "swarm-evidence", "v": version, "elements": elements}, nil
	}

	// The standard CMW JSON collection of draft-ietf-rats-msg-wrap: the
	// collection type in `__cmwc_t`, and one `[media-type, base64url]` record
	// per element.
	out := map[string]any{"__cmwc_t": "application/vnd.super-protocol.swarm-evidence+json;v=1"}
	for _, element := range elements {
		var octets []byte
		switch value := element["value"].(type) {
		case string:
			if element["encoding"] == "base64url" {
				decoded, err := base64.RawURLEncoding.DecodeString(value)
				if err != nil {
					return nil, err
				}
				octets = decoded
			} else {
				octets = []byte(value)
			}
		default:
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, err
			}
			octets = encoded
		}
		out[element["type"].(string)] = []any{element["media_type"], b64(octets)}
	}
	return out, nil
}

// signStatement and signEnvelope mint the two signed objects the way SUP-636
// mints them: a compact JWS over `{version, kind, <object>_hash, <object>}`,
// where the hash is SHA-256 over the RFC 8785 canonical form of the object
// beside it.
func signStatement(signer *testca.Cert, statement map[string]any) (string, error) {
	hash, err := jcsHash(statement)
	if err != nil {
		return "", err
	}
	return signer.SignJWS(map[string]any{
		"version":        "1",
		"kind":           swarmevidence.StatementKind,
		"statement_hash": hash,
		"statement":      statement,
	})
}

func signEnvelope(signer *testca.Cert, envelope map[string]any) (string, error) {
	hash, err := jcsHash(envelope)
	if err != nil {
		return "", err
	}
	return signer.SignJWS(map[string]any{
		"version":       "1",
		"kind":          swarmevidence.EnvelopeKind,
		"envelope_hash": hash,
		"envelope":      envelope,
	})
}

// bindingDigest is the profile's preimage and hash, written out here rather
// than called from the package the vectors appraise: a corpus that computed
// its expectations with the code under test would assert nothing.
func bindingDigest(freshness, target, subject []byte) []byte {
	var preimage []byte
	for _, value := range [][]byte{freshness, target, subject} {
		preimage = binary.BigEndian.AppendUint32(preimage, uint32(len(value)))
		preimage = append(preimage, value...)
	}
	sum := sha512.Sum512(preimage)
	return sum[:]
}

func jcsHash(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	canonical, err := jcs.Transform(encoded)
	if err != nil {
		return "", err
	}
	return b64(sha256Of(canonical)), nil
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if nested, ok := value.(map[string]any); ok {
			out[key] = cloneMap(nested)
			continue
		}
		out[key] = value
	}
	return out
}

func sha256Of(octets []byte) []byte {
	sum := sha256.Sum256(octets)
	return sum[:]
}

func b64(octets []byte) string { return base64.RawURLEncoding.EncodeToString(octets) }

func bytes(value byte, length int) []byte {
	out := make([]byte, length)
	for i := range out {
		out[i] = value
	}
	return out
}

// digestHex pads a prefix into the 64 hex characters a SHA-256 digest spells.
func digestHex(prefix string) string {
	out := prefix
	for len(out) < 64 {
		out += "0"
	}
	return out[:64]
}

func hexOf(octets []byte) string { return hex.EncodeToString(octets) }

func pemEncode(blockType string, der []byte) []byte {
	const lineLength = 64
	encoded := base64.StdEncoding.EncodeToString(der)
	out := "-----BEGIN " + blockType + "-----\n"
	for len(encoded) > lineLength {
		out += encoded[:lineLength] + "\n"
		encoded = encoded[lineLength:]
	}
	return []byte(out + encoded + "\n-----END " + blockType + "-----\n")
}
