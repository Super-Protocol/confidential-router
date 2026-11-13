package swarmevidence_test

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/gowebpki/jcs"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/internal/testca"
)

// The request values a composite case is appraised against. The freshness
// element is the 32-octet `present-nonce` Handle the TACRA Vault profile
// fixes; the Target is prepared octets, supplied verbatim and never recoded;
// the subject stands in for the DER SubjectPublicKeyInfo of CEKpub.
var (
	testFreshness = repeat(0x5a, 32)
	testTarget    = []byte("https://vault.bank.example/v1/payments-db")
	testRequestee = []byte("\x30\x59\x30\x13CEKpub SubjectPublicKeyInfo DER")
)

// composite builds one composite-form appraisal's worth of material. Every
// member is public so a case can break exactly one thing and leave the rest
// of the collection sound — which is what makes a denial attributable.
type composite struct {
	f *fixture

	// node signs the request envelope; signer signs the leader's statement.
	// They are different leaves of the same PKI on purpose: that is how
	// SUP-636 mints them, and a verifier that assumed one certificate would
	// not notice if it checked the wrong signature.
	node, signer *testca.Cert
	// membership is the PEM file of element 2, in file order.
	membership []*testca.Cert

	quote     map[string]any
	statement map[string]any
	envelope  map[string]any

	envelopeSigner  *testca.Cert
	omitStatement   bool
	omitEnvelope    bool
	standardWrapper bool

	// bindingData is what the stub appraiser reports as the quote's
	// guest-chosen field, and bindingSource where it says it read it.
	bindingData   []byte
	bindingSource swarmevidence.BindingDataSource
}

func newComposite(t *testing.T) *composite {
	t.Helper()
	f := newFixture(t)
	c := &composite{
		f:             f,
		node:          f.node,
		signer:        f.signer,
		membership:    []*testca.Cert{f.node, f.signer, f.inter, f.root},
		bindingData:   bindingDigest(testFreshness, testTarget, testRequestee),
		bindingSource: swarmevidence.BindingFromReportData,
	}
	c.envelopeSigner = c.node
	c.quote = map[string]any{
		"type":           "tdx",
		"evidenceBase64": base64.StdEncoding.EncodeToString([]byte("serialised TeeEvidence")),
		"networkID":      "swarm-cloud-test",
	}
	c.statement = map[string]any{
		"version":   1,
		"issued_at": "2026-08-30T09:00:00Z",
		"pod": map[string]any{
			"uid":                  "pod-7f3a",
			"name":                 "payments-api-0",
			"namespace":            "tenant-acme",
			"service_account_name": "payments",
			"node_name":            "node-01",
			"created_at":           "2026-08-30T08:55:00Z",
		},
		"cluster_space": map[string]any{
			"id":         "space-42",
			"cluster_id": "cluster-7",
			"namespace":  "tenant-acme",
			"locked":     true,
			"locked_at":  "2026-08-30T08:58:00Z",
		},
		"containers": []any{
			map[string]any{
				"name":         "api",
				"image":        "ghcr.io/acme/payments@sha256:" + hex64("a1"),
				"image_digest": "sha256:" + hex64("a1"),
			},
		},
		"init_containers": []any{
			map[string]any{
				"name":         "migrate",
				"image":        "ghcr.io/acme/migrate@sha256:" + hex64("b2"),
				"image_digest": "sha256:" + hex64("b2"),
			},
		},
		"pod_security": map[string]any{
			"enforce":         "restricted",
			"enforce_version": "v1.31",
			"audit":           "restricted",
			"warn":            "restricted",
		},
		"network_type":   "untrusted",
		"sp_vm_build_id": "build-448-release",
	}
	c.envelope = map[string]any{
		"version":               1,
		"issued_at":             "2026-08-30T10:05:30Z",
		"statement_hash":        "",
		"subject_hash":          b64(sha256Of(testRequestee)),
		"freshness":             b64(testFreshness),
		"target":                b64(testTarget),
		"pod_uid":               "pod-7f3a",
		"node_cert_fingerprint": bareFingerprint(c.node),
	}
	return c
}

func (c *composite) options() swarmevidence.Options {
	options := c.f.options()
	options.Subject = ""
	options.ObservedTLSFingerprint = ""
	options.FreshnessInput = testFreshness
	options.RequestTarget = testTarget
	options.RequestSubject = testRequestee
	options.QuoteAppraiser = &stubAppraiser{
		appraisal:      c.f.appraisal,
		quoteAppraisal: quoteAppraisal(c.bindingData, c.bindingSource),
	}
	return options
}

// blob renders the collection as the CAI would hand it to a Verifier.
func (c *composite) blob(t *testing.T) []byte {
	t.Helper()
	elements := []map[string]any{{
		"type":       swarmevidence.ElementQuote,
		"media_type": "application/vnd.super-protocol.swarm-quote+json",
		"encoding":   "json",
		"value":      c.quote,
	}, {
		"type":       swarmevidence.ElementMembership,
		"media_type": "application/x-pem-file",
		"encoding":   "base64url",
		"value":      b64([]byte(c.membershipPEM())),
	}}
	if !c.omitStatement {
		elements = append(elements, map[string]any{
			"type":       swarmevidence.ElementStatement,
			"media_type": "application/jose",
			"encoding":   "json",
			"value":      c.statementJWS(t),
		})
	}
	if !c.omitEnvelope {
		elements = append(elements, map[string]any{
			"type":       swarmevidence.ElementEnvelope,
			"media_type": "application/jose",
			"encoding":   "json",
			"value":      c.envelopeJWS(t),
		})
	}

	if c.standardWrapper {
		return c.standardBlob(t, elements)
	}
	encoded, err := json.Marshal(map[string]any{
		"collection": "swarm-evidence",
		"v":          1,
		"elements":   elements,
	})
	if err != nil {
		t.Fatalf("marshal collection: %v", err)
	}
	return encoded
}

// standardBlob re-renders the same parts as the CMW JSON collection of
// draft-ietf-rats-msg-wrap: `__cmwc_t` plus one CMW record per element.
func (c *composite) standardBlob(t *testing.T, elements []map[string]any) []byte {
	t.Helper()
	out := map[string]any{
		"__cmwc_t": "application/vnd.super-protocol.swarm-evidence+json;v=1",
	}
	for _, element := range elements {
		var octets []byte
		switch value := element["value"].(type) {
		case string:
			if element["encoding"] == "base64url" {
				decoded, err := base64.RawURLEncoding.DecodeString(value)
				if err != nil {
					t.Fatalf("decode element: %v", err)
				}
				octets = decoded
			} else {
				octets = []byte(value)
			}
		default:
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatalf("marshal element: %v", err)
			}
			octets = encoded
		}
		out[element["type"].(string)] = []any{element["media_type"], b64(octets)}
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal CMW collection: %v", err)
	}
	return encoded
}

func (c *composite) membershipPEM() string {
	var out string
	for _, cert := range c.membership {
		out += cert.PEM
	}
	return out
}

func (c *composite) statementJWS(t *testing.T) string {
	t.Helper()
	jws, err := c.signer.SignJWS(map[string]any{
		"version":        "1",
		"kind":           "WorkloadAttestationStatement",
		"statement_hash": c.statementHash(t),
		"statement":      c.statement,
	})
	if err != nil {
		t.Fatalf("sign statement: %v", err)
	}
	return jws
}

// statementHash is the value the envelope must carry, computed the way the
// producer computes it: SHA-256 over the RFC 8785 canonical statement.
func (c *composite) statementHash(t *testing.T) string {
	t.Helper()
	return jcsHash(t, c.statement)
}

func (c *composite) envelopeJWS(t *testing.T) string {
	t.Helper()
	envelope := c.envelope
	if hash, ok := envelope["statement_hash"].(string); ok && hash == "" && !c.omitStatement {
		envelope = cloneMap(envelope)
		envelope["statement_hash"] = c.statementHash(t)
	}
	if hash, ok := envelope["statement_hash"].(string); ok && hash == "" && c.omitStatement {
		envelope = cloneMap(envelope)
		delete(envelope, "statement_hash")
	}
	jws, err := c.envelopeSigner.SignJWS(map[string]any{
		"version":       "1",
		"kind":          "NodeRequestEnvelope",
		"envelope_hash": jcsHash(t, envelope),
		"envelope":      envelope,
	})
	if err != nil {
		t.Fatalf("sign envelope: %v", err)
	}
	return jws
}

// quoteAppraisal is the hardware half of a composite case: the same stub
// appraisal the bundle cases use, plus the guest-chosen field a per-request
// quote carries.
func quoteAppraisal(binding []byte, source swarmevidence.BindingDataSource) *swarmevidence.QuoteAppraisal {
	appraisal := stubAppraisal()
	appraisal.Platform = swarmevidence.PlatformTDXQemu
	appraisal.KeyBinding = false
	appraisal.NetworkType = ""
	appraisal.BindingData = binding
	appraisal.BindingDataSource = source
	return appraisal
}

// bindingDigest is the preimage and hash of the profile, written out here
// rather than called from the package under test, so the fixtures would catch
// the production code silently changing the construction.
func bindingDigest(freshness, target, subject []byte) []byte {
	var preimage []byte
	for _, value := range [][]byte{freshness, target, subject} {
		preimage = binary.BigEndian.AppendUint32(preimage, uint32(len(value)))
		preimage = append(preimage, value...)
	}
	sum := sha512.Sum512(preimage)
	return sum[:]
}

func jcsHash(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal for JCS: %v", err)
	}
	canonical, err := jcs.Transform(encoded)
	if err != nil {
		t.Fatalf("canonicalise: %v", err)
	}
	return b64(sha256Of(canonical))
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func sha256Of(octets []byte) []byte {
	sum := sha256.Sum256(octets)
	return sum[:]
}

func b64(octets []byte) string { return base64.RawURLEncoding.EncodeToString(octets) }

// bareFingerprint is the unpadded base64url SHA-256 of a certificate's DER —
// the TACRA wire form the envelope names its signer by, without the `sha256/`
// framing the published web bundle uses.
func bareFingerprint(cert *testca.Cert) string {
	return b64(sha256Of(cert.DER))
}

func repeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func hex64(prefix string) string {
	out := prefix
	for len(out) < 64 {
		out += "0"
	}
	return out[:64]
}

// stubQuoteAppraiser is the composite half of the stub, kept beside the bundle
// one so a case can replace either independently.
func (s *stubAppraiser) AppraiseQuote(
	context.Context, swarmevidence.Quote,
) (*swarmevidence.QuoteAppraisal, error) {
	if s.quoteErr != nil {
		return nil, s.quoteErr
	}
	return s.quoteAppraisal, nil
}
