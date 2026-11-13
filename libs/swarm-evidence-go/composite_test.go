package swarmevidence_test

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/internal/testca"
)

// TestAppraiseCompositeCollection is the form this module exists for: a quote
// bound to one credential request, the pod the request came from, and the
// node that vouches that the two belong together.
func TestAppraiseCompositeCollection(t *testing.T) {
	t.Parallel()
	c := newComposite(t)

	claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}
	if claims.Denial != nil {
		t.Fatalf("denial = %v, want none", claims.Denial)
	}

	for name, got := range map[string]*bool{
		"binding_ok":     claims.BindingOK,
		"envelope_ok":    claims.EnvelopeOK,
		"statement_ok":   claims.StatementOK,
		"pki_chain_ok":   claims.PKIChainOK,
		"root_quote_ok":  claims.RootQuoteOK,
		"quote_verified": claims.QuoteVerified,
		"locked":         claims.Locked,
		"gpu_attested":   claims.GPUAttested,
	} {
		if got == nil {
			t.Errorf("%s is absent, want a reported value", name)
			continue
		}
		// The fixture carries no GPU token, so gpu_attested is a reported
		// false: the node has no GPU, which is an answer.
		if want := name != "gpu_attested"; *got != want {
			t.Errorf("%s = %v, want %v", name, *got, want)
		}
	}

	if claims.FreshnessInput != hex.EncodeToString(testFreshness) {
		t.Errorf("freshness_input = %q, want the handle echoed verbatim", claims.FreshnessInput)
	}
	if want := hex.EncodeToString(sha256Of(testRequestee)); claims.BindingSubjectDigest != want {
		t.Errorf("binding_subject_digest = %q, want %q", claims.BindingSubjectDigest, want)
	}
	if claims.Platform != swarmevidence.PlatformTDXQemu {
		t.Errorf("platform = %q, want the per-request quote's platform", claims.Platform)
	}
	if claims.NodeCertFingerprint != c.node.Fingerprint() {
		t.Errorf("node_cert_fingerprint = %q, want the node certificate's %q",
			claims.NodeCertFingerprint, c.node.Fingerprint())
	}
	if claims.StatementSignerFingerprint != c.signer.Fingerprint() {
		t.Errorf("statement_signer_fingerprint = %q, want the leader signer's %q",
			claims.StatementSignerFingerprint, c.signer.Fingerprint())
	}
	if claims.PKIRootFingerprint != c.f.root.Fingerprint() {
		t.Errorf("pki_root_fingerprint = %q, want the pinned root's", claims.PKIRootFingerprint)
	}
	if claims.NetworkType != swarmevidence.NetworkUntrusted {
		t.Errorf("network_type = %q, want the PKI root's declaration", claims.NetworkType)
	}

	// The pod claims, which only a verified statement can establish.
	if claims.PodUID != "pod-7f3a" || claims.Namespace != "tenant-acme" {
		t.Errorf("pod = %q/%q, want pod-7f3a/tenant-acme", claims.Namespace, claims.PodUID)
	}
	if claims.ClusterSpaceID != "space-42" {
		t.Errorf("cluster_space_id = %q, want space-42", claims.ClusterSpaceID)
	}
	if claims.PSSEnforce != "restricted" {
		t.Errorf("pss_enforce = %q, want restricted", claims.PSSEnforce)
	}
	if claims.LockedAt != "2026-08-30T08:58:00Z" {
		t.Errorf("locked_at = %q, want the statement's lock time", claims.LockedAt)
	}
	// Init containers count: one runs with the same access to the cluster
	// space as any other, and a policy that saw only `containers` would be
	// checking half the workload.
	want := []string{"sha256:" + hex64("a1"), "sha256:" + hex64("b2")}
	if !slices.Equal(claims.ImageDigests, want) {
		t.Errorf("image_digests = %v, want %v", claims.ImageDigests, want)
	}

	// A composite appraisal is about a request, not about a served hostname.
	if claims.ChannelBinding != "" {
		t.Errorf("channel_binding = %q, want none: the composite form binds a request", claims.ChannelBinding)
	}
}

// TestAppraiseCompositeLegalCollections covers the two legal collections the
// `full` case above does not: the profile pins exactly three, and the fourth
// shape — a statement with no envelope — is refused in
// TestAppraiseCollectionDenials.
//
// Both of these carry no pod claims, which is the invariant worth pinning: a
// pod claim is only ever reported beside `envelope_ok` true.
func TestAppraiseCompositeLegalCollections(t *testing.T) {
	t.Parallel()

	for _, c := range []struct {
		name         string
		setup        func(*composite)
		wantEnvelope bool
	}{{
		name:  "minimal — the two REQUIRED elements alone",
		setup: func(c *composite) { c.omitStatement, c.omitEnvelope = true, true },
	}, {
		name:         "an envelope with no statement to pair",
		setup:        func(c *composite) { c.omitStatement = true },
		wantEnvelope: true,
	}} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			composite := newComposite(t)
			c.setup(composite)

			claims, err := swarmevidence.AppraiseComposite(
				context.Background(), composite.blob(t), composite.options())
			if err != nil {
				t.Fatalf("appraise: %v", err)
			}
			if claims.BindingOK == nil || !*claims.BindingOK {
				t.Error("binding_ok is not set, but the quote answers this request")
			}
			if claims.StatementOK != nil {
				t.Errorf("statement_ok = %v, want absent: the collection carries no statement",
					*claims.StatementOK)
			}
			if gotEnvelope := claims.EnvelopeOK != nil; gotEnvelope != c.wantEnvelope {
				t.Errorf("envelope_ok present = %v, want %v", gotEnvelope, c.wantEnvelope)
			}
			for name, got := range map[string]string{
				"pod_uid":          claims.PodUID,
				"namespace":        claims.Namespace,
				"cluster_space_id": claims.ClusterSpaceID,
				"locked_at":        claims.LockedAt,
				"pss_enforce":      claims.PSSEnforce,
			} {
				if got != "" {
					t.Errorf("%s = %q, want none: no statement established it", name, got)
				}
			}
			if claims.Locked != nil || claims.ImageDigests != nil {
				t.Error("a pod claim is set for a collection that carries no statement")
			}
		})
	}
}

// TestAppraiseCompositeStandardWrapper is the Verifier-independence
// acceptance: the same parts under the CMW JSON collection of
// draft-ietf-rats-msg-wrap must appraise identically to the profile's own
// serialisation. A relying party deploys one Verifier of its own choosing, and
// this module may not be the reason a collection it forwarded is unreadable.
func TestAppraiseCompositeStandardWrapper(t *testing.T) {
	t.Parallel()
	c := newComposite(t)
	profileClaims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
	if err != nil {
		t.Fatalf("appraise the profile serialisation: %v", err)
	}

	c.standardWrapper = true
	standardClaims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
	if err != nil {
		t.Fatalf("appraise the standard CMW collection: %v", err)
	}

	if !sameJSON(t, profileClaims, standardClaims) {
		t.Errorf("the two serialisations produced different claim sets:\n%s\n%s",
			mustJSON(t, profileClaims), mustJSON(t, standardClaims))
	}
}

// TestParseCollectionMatchesTheSharedFixture replays the collection the
// profile's own test vector pins — `testdata/tacra-v1/evidence/collection-v1.json`
// in swarm-cloud, sample "full", with its dummy element values — so the
// identifiers, media types and encodings this parser accepts are the ones the
// producer was written against rather than the ones that happened to be
// convenient here.
func TestParseCollectionMatchesTheSharedFixture(t *testing.T) {
	t.Parallel()
	const fixture = `{
	  "collection": "swarm-evidence",
	  "v": 1,
	  "elements": [
	    {"type":"swarm-quote","media_type":"application/vnd.super-protocol.swarm-quote+json",
	     "encoding":"json","value":{"type":"tdx","evidenceBase64":"YcRmwwg5MAoam1o3AKqEFKfxJnMAPtJ6jSYXCpOC2lA=",
	     "nvidiaTokens":{"gpuToken":"eyJhbGciOiJFUzM4NCJ9.e30.sig"}}},
	    {"type":"swarm-pki-membership","media_type":"application/x-pem-file","encoding":"base64url",
	     "value":"LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tClZFRkRVa0V0ZGpFdlpYWnBaR1Z1WTJVdmNHdHBMVzFsYldKbGNuTm9hWEE9Ci0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K"},
	    {"type":"swarm-workload-statement","media_type":"application/jose","encoding":"json",
	     "value":"eyJhbGciOiJFUzI1NiJ9.eyJwb2RfdWlkIjoicG9kLTdmM2EifQ.c3RhdGVtZW50"},
	    {"type":"swarm-node-request-envelope","media_type":"application/jose","encoding":"json",
	     "value":"eyJhbGciOiJFUzI1NiJ9.eyJ2IjoidjEiLCJwb2RfdWlkIjoicG9kLTdmM2EifQ.ZW52ZWxvcGU"}
	  ]
	}`

	// The fixture's elements are placeholders, so the appraisal cannot get
	// past them — what this pins is that it gets past the *parse*: the denial
	// must be about the element content, never about the collection's shape.
	claims, err := swarmevidence.AppraiseComposite(context.Background(), []byte(fixture),
		newComposite(t).options())
	var denial *swarmevidence.Denial
	if !asDenial(err, &denial) {
		t.Fatalf("err = %v, want a *Denial; claims %+v", err, claims)
	}
	if denial.Stage != swarmevidence.StagePKIChain {
		t.Errorf("stage = %q (%s), want %q: the collection parsed and the placeholder chain did not",
			denial.Stage, denial.Reason, swarmevidence.StagePKIChain)
	}
	for _, shape := range []string{"collection", "element \"swarm-quote\"", "media type", "encoding"} {
		if strings.Contains(denial.Reason, shape) {
			t.Errorf("reason %q complains about the collection's shape, which the fixture pins as valid",
				denial.Reason)
		}
	}
}

// TestAppraiseCollectionDenials is the failure-mode matrix: one case per way
// the composite form can fail to establish what it claims, each denying at the
// stage a relying party would look for it at.
func TestAppraiseCollectionDenials(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name   string
		stage  swarmevidence.DenialStage
		reason string
		setup  func(t *testing.T, c *composite)
		tweak  func(o *swarmevidence.Options)
	}{{
		name:   "an unimplemented collection version",
		stage:  swarmevidence.StageBlob,
		reason: "collection version 2",
		setup:  func(*testing.T, *composite) {},
	}, {
		name:   "no target to recompute the binding over",
		stage:  swarmevidence.StageOptions,
		reason: "Options.RequestTarget is required",
		setup:  func(*testing.T, *composite) {},
		tweak:  func(o *swarmevidence.Options) { o.RequestTarget = nil },
	}, {
		name:   "no subject to recompute the binding over",
		stage:  swarmevidence.StageOptions,
		reason: "Options.RequestSubject is required",
		setup:  func(*testing.T, *composite) {},
		tweak:  func(o *swarmevidence.Options) { o.RequestSubject = nil },
	}, {
		name:   "no freshness to bind",
		stage:  swarmevidence.StageOptions,
		reason: "Options.FreshnessInput is required",
		setup:  func(*testing.T, *composite) {},
		tweak:  func(o *swarmevidence.Options) { o.FreshnessInput = nil },
	}, {
		name:   "a collection with no quote",
		stage:  swarmevidence.StageBlob,
		reason: "carries no \"swarm-quote\" element",
		setup:  func(*testing.T, *composite) {},
	}, {
		name:   "a membership chain that terminates at an unpinned root",
		stage:  swarmevidence.StagePKIChain,
		reason: "not in trusted store",
		setup:  func(*testing.T, *composite) {},
		tweak:  func(o *swarmevidence.Options) { o.PKIRoots = nil },
	}, {
		name:   "a quote whose binding digest is some other request's",
		stage:  swarmevidence.StageBinding,
		reason: "does not answer this request",
		setup: func(_ *testing.T, c *composite) {
			c.bindingData = bindingDigest(testFreshness, []byte("https://attacker.example"), testRequestee)
		},
	}, {
		name:   "an appraiser that would not say which field it read",
		stage:  swarmevidence.StageBinding,
		reason: "did not say which field",
		setup:  func(_ *testing.T, c *composite) { c.bindingSource = "" },
	}, {
		name:   "an envelope bound to another subject",
		stage:  swarmevidence.StageEnvelope,
		reason: "subject_hash",
		setup: func(_ *testing.T, c *composite) {
			c.envelope["subject_hash"] = b64(sha256Of([]byte("some other public key")))
		},
	}, {
		name:   "an envelope replayed from an earlier challenge",
		stage:  swarmevidence.StageEnvelope,
		reason: "answers some other challenge",
		setup: func(_ *testing.T, c *composite) {
			c.envelope["freshness"] = b64(repeat(0x11, 32))
		},
	}, {
		name:   "an envelope bound to another target",
		stage:  swarmevidence.StageEnvelope,
		reason: "envelope target",
		setup: func(_ *testing.T, c *composite) {
			c.envelope["target"] = b64([]byte("https://attacker.example"))
		},
	}, {
		name:   "an envelope signed by a foreign node certificate",
		stage:  swarmevidence.StageEnvelope,
		reason: "which the \"swarm-pki-membership\" element does not carry",
		setup: func(_ *testing.T, c *composite) {
			c.envelopeSigner = c.f.foreign
			c.envelope["node_cert_fingerprint"] = bareFingerprint(c.f.foreign)
		},
	}, {
		name:  "an envelope whose named certificate did not sign it",
		stage: swarmevidence.StageEnvelope,
		// The named certificate is in the pool and chains to the pinned root,
		// so selection succeeds and the signature check is what refuses.
		reason: "signature",
		setup: func(_ *testing.T, c *composite) {
			c.envelopeSigner = c.f.signer
		},
	}, {
		name:   "an envelope whose signed hash is not its own body",
		stage:  swarmevidence.StageEnvelope,
		reason: "is not the hash of the envelope beside it",
		setup:  func(*testing.T, *composite) {},
	}, {
		name:   "a statement whose signed hash is not its own body",
		stage:  swarmevidence.StageStatement,
		reason: "is not the hash of the statement beside it",
		setup:  func(*testing.T, *composite) {},
	}, {
		name:   "a statement signed outside the pinned PKI",
		stage:  swarmevidence.StageStatement,
		reason: "no certificate in the \"swarm-pki-membership\" element that chains to a pinned root",
		setup: func(_ *testing.T, c *composite) {
			c.signer = c.f.foreign
		},
	}, {
		name:   "a statement about another pod attached to this quote",
		stage:  swarmevidence.StageEnvelope,
		reason: "statement_hash",
		setup: func(t *testing.T, c *composite) {
			// The envelope is bound to the pod the node actually saw; the
			// statement is a locked neighbour's, replayed. This is the
			// attester substitution the envelope exists to catch.
			bound := c.statementHash(t)
			c.envelope["statement_hash"] = bound
			other := cloneMap(c.statement)
			pod := cloneMap(c.statement["pod"].(map[string]any))
			pod["uid"] = "pod-locked-neighbour"
			other["pod"] = pod
			c.statement = other
		},
	}, {
		name:   "an envelope for a pod the statement does not describe",
		stage:  swarmevidence.StageEnvelope,
		reason: "is not the statement's pod",
		setup: func(_ *testing.T, c *composite) {
			c.envelope["pod_uid"] = "pod-somebody-else"
		},
	}, {
		name:  "a statement with no envelope to bind it",
		stage: swarmevidence.StageEnvelope,
		// The substitution shape itself, and not one of the three collections
		// the profile pins: the statement is sound and nothing says the pod it
		// describes is the pod that asked.
		reason: "carries a statement and no envelope binding it to this request",
		setup:  func(_ *testing.T, c *composite) { c.omitEnvelope = true },
	}, {
		name:   "an envelope that binds a statement the collection does not carry",
		stage:  swarmevidence.StageEnvelope,
		reason: "carries no \"swarm-workload-statement\" element",
		setup: func(t *testing.T, c *composite) {
			c.envelope["statement_hash"] = c.statementHash(t)
			c.omitStatement = true
		},
	}, {
		name:   "a statement older than the caller accepts",
		stage:  swarmevidence.StageStatement,
		reason: "exceeds the",
		setup:  func(*testing.T, *composite) {},
		tweak:  func(o *swarmevidence.Options) { o.MaxEvidenceAge = time.Minute },
	}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c := newComposite(t)
			tc.setup(t, c)
			blob := mutateBlob(t, tc.name, c)
			options := c.options()
			if tc.tweak != nil {
				tc.tweak(&options)
			}

			claims, err := swarmevidence.AppraiseComposite(context.Background(), blob, options)
			var denial *swarmevidence.Denial
			if !asDenial(err, &denial) {
				t.Fatalf("err = %v, want a *Denial; claims %+v", err, claims)
			}
			if denial.Stage != tc.stage {
				t.Errorf("stage = %q, want %q (reason: %s)", denial.Stage, tc.stage, denial.Reason)
			}
			if !strings.Contains(denial.Reason, tc.reason) {
				t.Errorf("reason %q does not contain %q", denial.Reason, tc.reason)
			}
			assertDenialOnly(t, claims, denial)
		})
	}
}

// mutateBlob applies the handful of cases that have to corrupt the serialised
// collection rather than the material it is built from.
func mutateBlob(t *testing.T, name string, c *composite) []byte {
	t.Helper()
	blob := c.blob(t)
	switch name {
	case "an unimplemented collection version":
		return []byte(strings.Replace(string(blob), `"v":1`, `"v":2`, 1))
	case "a collection with no quote":
		return dropElement(t, blob, swarmevidence.ElementQuote)
	case "an envelope whose signed hash is not its own body":
		return retamperJWS(t, blob, swarmevidence.ElementEnvelope, c.f.node, "envelope_hash")
	case "a statement whose signed hash is not its own body":
		return retamperJWS(t, blob, swarmevidence.ElementStatement, c.f.signer, "statement_hash")
	}
	return blob
}

func dropElement(t *testing.T, blob []byte, elementType string) []byte {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(blob, &parsed); err != nil {
		t.Fatalf("parse collection: %v", err)
	}
	elements := parsed["elements"].([]any)
	kept := make([]any, 0, len(elements))
	for _, element := range elements {
		if element.(map[string]any)["type"] != elementType {
			kept = append(kept, element)
		}
	}
	parsed["elements"] = kept
	return mustJSON(t, parsed)
}

// retamperJWS re-signs an element's JWS with a wrong self-declared hash: the
// signature is sound and the body contradicts it, which is the one failure a
// verifier that trusted the signed hash instead of recomputing it would miss.
func retamperJWS(t *testing.T, blob []byte, elementType string, signer *testca.Cert, field string) []byte {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(blob, &parsed); err != nil {
		t.Fatalf("parse collection: %v", err)
	}
	for _, raw := range parsed["elements"].([]any) {
		element := raw.(map[string]any)
		if element["type"] != elementType {
			continue
		}
		segments := strings.Split(element["value"].(string), ".")
		body, err := base64.RawURLEncoding.DecodeString(segments[1])
		if err != nil {
			t.Fatalf("decode JWS body: %v", err)
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("parse JWS body: %v", err)
		}
		payload[field] = b64(sha256Of([]byte("a hash of something else")))
		jws, err := signer.SignJWS(payload)
		if err != nil {
			t.Fatalf("re-sign: %v", err)
		}
		element["value"] = jws
	}
	return mustJSON(t, parsed)
}

// TestCompositeGPUAttestedComesFromTheEnvelopeOnly is the claim's whole point:
// the binding digest owns all 64 octets of the guest-chosen field, so a GPU
// token hash cannot ride beside it and the only thing that can vouch for one
// is the node's own signature.
func TestCompositeGPUAttestedComesFromTheEnvelopeOnly(t *testing.T) {
	t.Parallel()

	t.Run("a verified envelope that carries a token hash", func(t *testing.T) {
		t.Parallel()
		c := newComposite(t)
		c.envelope["gpu_attestation_token_sha256"] = b64(sha256Of([]byte("nvidia attestation token")))
		claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
		if err != nil {
			t.Fatalf("appraise: %v", err)
		}
		if claims.GPUAttested == nil || !*claims.GPUAttested {
			t.Errorf("gpu_attested = %v, want true", claims.GPUAttested)
		}
	})

	t.Run("a token in the quote and no envelope leaves it unset", func(t *testing.T) {
		t.Parallel()
		c := newComposite(t)
		c.omitEnvelope = true
		c.omitStatement = true
		c.quote["nvidiaTokens"] = map[string]any{"gpuToken": "eyJhbGciOiJFUzM4NCJ9.e30.sig"}

		claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
		if err != nil {
			t.Fatalf("appraise: %v", err)
		}
		if claims.GPUAttested != nil {
			t.Errorf("gpu_attested = %v, want absent: nothing the node signed vouches for the token",
				*claims.GPUAttested)
		}
		if claims.EnvelopeOK != nil || claims.StatementOK != nil {
			t.Error("envelope_ok or statement_ok is set for a collection that carries neither")
		}
		if claims.BindingOK == nil || !*claims.BindingOK {
			t.Error("binding_ok is not set, but the quote answers this request")
		}
	})

	t.Run("a token hash in an envelope that does not verify leaves it unset", func(t *testing.T) {
		t.Parallel()
		c := newComposite(t)
		c.envelope["gpu_attestation_token_sha256"] = b64(sha256Of([]byte("nvidia attestation token")))
		c.envelope["subject_hash"] = b64(sha256Of([]byte("some other public key")))

		claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
		var denial *swarmevidence.Denial
		if !asDenial(err, &denial) {
			t.Fatalf("err = %v, want a *Denial", err)
		}
		if claims.GPUAttested != nil {
			t.Errorf("gpu_attested = %v, want absent beside a denial", *claims.GPUAttested)
		}
	})
}

// TestCompositeWithoutImageIdentityReportsNeitherClaim is the difference
// between "nothing vouches for this image" and "nobody looked", which a
// delegated appraiser makes reachable: mrEnclave needs the RTMR0 event log
// replayed and normalised, and a Verifier that appraises the quote alone
// cannot derive one.
//
// A `mrenclave_approved: false` there would tell a policy that a set of
// reference values was consulted, so neither claim may appear.
func TestCompositeWithoutImageIdentityReportsNeitherClaim(t *testing.T) {
	t.Parallel()
	c := newComposite(t)
	options := c.options()
	appraisal := quoteAppraisal(c.bindingData, c.bindingSource)
	appraisal.MrEnclave = ""
	appraisal.MrEnclaveApproved = false
	appraisal.MrEnclaveSource = ""
	appraisal.SpvmBuild = ""
	options.QuoteAppraiser = &stubAppraiser{appraisal: c.f.appraisal, quoteAppraisal: appraisal}

	claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), options)
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}
	if claims.MrEnclaveApproved != nil {
		t.Errorf("mrenclave_approved = %v, want absent: no appraiser derived an image identity",
			*claims.MrEnclaveApproved)
	}
	if claims.MrEnclave != "" || claims.MrEnclaveSource != "" {
		t.Errorf("mrenclave = %q / source %q, want neither", claims.MrEnclave, claims.MrEnclaveSource)
	}
	// The rest of the appraisal is unaffected: the hardware held up and the
	// pod claims are the statement's.
	if claims.QuoteVerified == nil || !*claims.QuoteVerified || claims.PodUID != "pod-7f3a" {
		t.Error("the rest of the claim set did not survive an appraisal without an image identity")
	}
}

// TestCompositeAzureReadsTheBindingFromHCLUserData pins the per-platform half
// of the binding check. On the Azure nested form the hardware REPORT_DATA is
// SHA-256(runtime data JSON) ‖ 0³² and is the paravisor's, not the guest's; an
// appraiser that reported it as the guest-chosen field would have the relying
// party compare its digest against a value no attester can control.
func TestCompositeAzureReadsTheBindingFromHCLUserData(t *testing.T) {
	t.Parallel()
	c := newComposite(t)
	c.bindingSource = swarmevidence.BindingFromHCLUserData

	claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}
	if claims.BindingOK == nil || !*claims.BindingOK {
		t.Fatalf("binding_ok = %v, want true", claims.BindingOK)
	}

	// The same digest read from the wrong field is the failure the source
	// exists to make visible: a report data of SHA-256(runtime data) ‖ 0³²
	// never equals a binding digest, so it denies.
	c = newComposite(t)
	c.bindingData = append(sha256Of([]byte("runtime data JSON")), make([]byte, 32)...)
	_, err = swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
	var denial *swarmevidence.Denial
	if !asDenial(err, &denial) || denial.Stage != swarmevidence.StageBinding {
		t.Fatalf("err = %v, want a binding-stage denial", err)
	}
}

// TestCompositeQuoteAppraiserFailureDenies keeps the same line the bundle form
// draws: an appraiser that could not reach an answer denies, rather than
// producing a claim set with the hardware half quietly missing.
func TestCompositeQuoteAppraiserFailureDenies(t *testing.T) {
	t.Parallel()
	c := newComposite(t)
	options := c.options()
	options.QuoteAppraiser = &stubAppraiser{
		appraisal: c.f.appraisal,
		quoteErr:  errors.New("the registry could not be consulted: dial tcp: no route to host"),
	}

	claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), options)
	var denial *swarmevidence.Denial
	if !asDenial(err, &denial) {
		t.Fatalf("err = %v, want a *Denial", err)
	}
	if denial.Stage != swarmevidence.StageRootQuote {
		t.Errorf("stage = %q, want %q", denial.Stage, swarmevidence.StageRootQuote)
	}
	assertDenialOnly(t, claims, denial)
}

// TestBindingDigestMatchesTheProfile pins the preimage and the hash table of
// the TACRA Vault profile's binding hook, which is the one construction an
// attester and a verifier must agree on byte for byte.
func TestBindingDigestMatchesTheProfile(t *testing.T) {
	t.Parallel()

	input, err := swarmevidence.BindingInput([]byte("ab"), []byte("cde"), []byte(""))
	if err != nil {
		t.Fatalf("binding input: %v", err)
	}
	want := "00000002616200000003636465" + "00000000"
	if got := hex.EncodeToString(input); got != want {
		t.Errorf("binding input = %s, want %s", got, want)
	}

	for _, size := range []int{64, 48, 32} {
		digest, err := swarmevidence.BindingDigest(testFreshness, testTarget, testRequestee, size)
		if err != nil {
			t.Fatalf("binding digest for %d octets: %v", size, err)
		}
		if len(digest) != size {
			t.Errorf("digest for a %d-octet field is %d octets", size, len(digest))
		}
	}
	if _, err := swarmevidence.BindingDigest(nil, nil, nil, 20); err == nil {
		t.Error("a 20-octet field was accepted; the profile names no hash for one")
	}
}

// TestJCSHashMatchesTheSharedVector pins the statement-hash construction
// against the shared TACRA fixture `testdata/tacra-v1/jcs/aad-key-order.json`
// in swarm-cloud: member order is by UTF-16 code unit whatever order the
// producer built the object in, and a Go verifier that sorted differently
// would reject every statement the TypeScript producer signs.
func TestJCSHashMatchesTheSharedVector(t *testing.T) {
	t.Parallel()
	const input = `{"target":"aHR0cHM6Ly9wYXltZW50cy5leGFtcGxlLmNvbS9hcGk",` +
		`"handle":"EEkZzONOplP7-32jeWVHIDmY-2aU0IGJzzeJ_04nHKM",` +
		`"group_id":"UV4r7qJ5uqT3gh9q5PC2rC4-rdB3gYDDpl4treMW9Ho",` +
		`"credential_hint":"postgresql://payments-db"}`
	const wantHex = "7b2263726564656e7469616c5f68696e74223a22706f737467726573716c3a2f2f7061796d656e74" +
		"732d6462222c2267726f75705f6964223a225556347237714a357571543367683971355043327243" +
		"342d7264423367594444706c347472654d5739486f222c2268616e646c65223a2245456b5a7a4f4e" +
		"4f706c50372d33326a6557564849446d592d3261553049474a7a7a654a5f30346e484b4d222c2274" +
		"6172676574223a226148523063484d364c79397759586c745a5735306379356c654746746347786c" +
		"4c6d4e766253396863476b227d"

	canonical, err := swarmevidence.CanonicalJSON([]byte(input))
	if err != nil {
		t.Fatalf("canonicalise: %v", err)
	}
	if got := hex.EncodeToString(canonical); got != wantHex {
		t.Errorf("JCS octets = %s, want %s", got, wantHex)
	}
}

func sameJSON(t *testing.T, a, b swarmevidence.SwarmClaims) bool {
	t.Helper()
	return string(mustJSON(t, a)) == string(mustJSON(t, b))
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return encoded
}
