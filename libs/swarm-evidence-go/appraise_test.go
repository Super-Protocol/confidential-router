package swarmevidence_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
)

const (
	testSubject = "llama-33-70b.tee.swarm.cloud"
	testNow     = "2026-08-30T10:06:00Z"
)

func TestAppraiseCompositeBundle(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t)

	claims, err := swarmevidence.AppraiseComposite(context.Background(), fixture.bundle(t, nil), fixture.options())
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}

	if claims.Denial != nil {
		t.Fatalf("denial = %v, want none", claims.Denial)
	}
	if claims.SchemaVersion != swarmevidence.ClaimsVersion {
		t.Errorf("schema_version = %q, want %q", claims.SchemaVersion, swarmevidence.ClaimsVersion)
	}
	if claims.FreshnessInput != hex.EncodeToString(fixture.freshness) {
		t.Errorf("freshness_input = %q, want the input echoed verbatim", claims.FreshnessInput)
	}
	if claims.Platform != swarmevidence.PlatformSNPQemu {
		t.Errorf("platform = %q, want %q", claims.Platform, swarmevidence.PlatformSNPQemu)
	}
	if claims.QuoteAppraiser != "stub" {
		t.Errorf("quote_appraiser = %q, want the appraiser that answered", claims.QuoteAppraiser)
	}
	for name, got := range map[string]*bool{
		"pki_chain_ok":       claims.PKIChainOK,
		"root_quote_ok":      claims.RootQuoteOK,
		"quote_verified":     claims.QuoteVerified,
		"mrenclave_approved": claims.MrEnclaveApproved,
		"statement_ok":       claims.StatementOK,
	} {
		if got == nil || !*got {
			t.Errorf("%s = %v, want true", name, got)
		}
	}
	if claims.PKIRootFingerprint != fixture.root.Fingerprint() {
		t.Errorf("pki_root_fingerprint = %q, want the pinned root's", claims.PKIRootFingerprint)
	}
	if claims.StatementSignerFingerprint != fixture.leaf.Fingerprint() {
		t.Errorf("statement_signer_fingerprint = %q, want the chain leaf's", claims.StatementSignerFingerprint)
	}
	if claims.ChannelBinding != swarmevidence.BindingObserved {
		t.Errorf("channel_binding = %q, want %q", claims.ChannelBinding, swarmevidence.BindingObserved)
	}
	if claims.MrEnclave != fixture.appraisal.MrEnclave {
		t.Errorf("mrenclave = %q, want %q", claims.MrEnclave, fixture.appraisal.MrEnclave)
	}
	if claims.MrEnclaveSource != swarmevidence.SourceRegistry {
		t.Errorf("mrenclave_source = %q, want %q", claims.MrEnclaveSource, swarmevidence.SourceRegistry)
	}
	if claims.Measurements.LaunchDigest != fixture.appraisal.Measurements.LaunchDigest {
		t.Errorf("measurements.launch_digest = %q, want the appraiser's",
			claims.Measurements.LaunchDigest)
	}
	if claims.EvidenceDigest == "" {
		t.Error("evidence_digest is absent, but the deployment payload carries one")
	}

	// The claims PR 2 fills in must be absent rather than false: a policy
	// written against the whole of v1 has to be able to tell "the envelope did
	// not verify" from "nobody looked at an envelope" (SUP-637).
	for name, got := range map[string]*bool{
		"binding_ok":   claims.BindingOK,
		"envelope_ok":  claims.EnvelopeOK,
		"gpu_attested": claims.GPUAttested,
		"locked":       claims.Locked,
	} {
		if got != nil {
			t.Errorf("%s = %v, want absent until the composite form carries it", name, *got)
		}
	}
}

// TestAppraisedClaimsAreAllDeclared marshals a real claim set and checks every
// member it emits is one the schema declares. The schema sets
// additionalProperties false, so a claim this module produces and the schema
// does not name would make a conforming validator reject our own output.
func TestAppraisedClaimsAreAllDeclared(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t)
	claims, err := swarmevidence.AppraiseComposite(context.Background(), fixture.bundle(t, nil), fixture.options())
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}

	encoded, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	var emitted map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &emitted); err != nil {
		t.Fatalf("parse claims: %v", err)
	}

	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(swarmevidence.Schema, &schema); err != nil {
		t.Fatalf("parse the embedded schema: %v", err)
	}
	for name := range emitted {
		if _, declared := schema.Properties[name]; !declared {
			t.Errorf("the appraisal emits %q and the schema does not declare it", name)
		}
	}
}

func TestAppraiseCompositeDenials(t *testing.T) {
	t.Parallel()

	for _, c := range []struct {
		name   string
		stage  swarmevidence.DenialStage
		reason string
		blob   func(t *testing.T, f *fixture) []byte
		tweak  func(f *fixture, o *swarmevidence.Options)
	}{{
		name:   "the composite form is not implemented yet",
		stage:  swarmevidence.StageBlob,
		reason: "SUP-638",
		blob: func(*testing.T, *fixture) []byte {
			return []byte(`{"version":"1","kind":"SuperSwarmEvidence","quote":"..."}`)
		},
	}, {
		name:   "a blob that is not JSON",
		stage:  swarmevidence.StageBlob,
		reason: "not a JSON document",
		blob:   func(*testing.T, *fixture) []byte { return []byte("not json at all") },
	}, {
		name:   "a bundle of an unsupported version",
		stage:  swarmevidence.StageBlob,
		reason: "unsupported evidence bundle version",
		blob: func(*testing.T, *fixture) []byte {
			return []byte(`{"version":"2","kind":"DeploymentEvidence"}`)
		},
	}, {
		name:   "no subject to appraise against",
		stage:  swarmevidence.StageOptions,
		reason: "Options.Subject is required",
		blob:   func(t *testing.T, f *fixture) []byte { return f.bundle(t, nil) },
		tweak:  func(_ *fixture, o *swarmevidence.Options) { o.Subject = "" },
	}, {
		name:   "a freshness input the attester could never have bound",
		stage:  swarmevidence.StageOptions,
		reason: "expected 64",
		blob:   func(t *testing.T, f *fixture) []byte { return f.bundle(t, nil) },
		tweak:  func(_ *fixture, o *swarmevidence.Options) { o.FreshnessInput = []byte("too short") },
	}, {
		name:   "a root the relying party did not pin",
		stage:  swarmevidence.StagePKIChain,
		reason: "not in trusted store",
		blob:   func(t *testing.T, f *fixture) []byte { return f.bundle(t, nil) },
		tweak:  func(_ *fixture, o *swarmevidence.Options) { o.PKIRoots = nil },
	}, {
		name:   "a statement signed by a key outside the chain",
		stage:  swarmevidence.StageStatement,
		reason: "signature",
		blob: func(t *testing.T, f *fixture) []byte {
			return f.bundleSignedBy(t, f.stray)
		},
	}, {
		name:  "a statement bound to a certificate nobody saw",
		stage: swarmevidence.StageBinding,
		blob:  func(t *testing.T, f *fixture) []byte { return f.bundle(t, nil) },
		tweak: func(_ *fixture, o *swarmevidence.Options) {
			o.ObservedTLSFingerprint = attestation.SHA256Fingerprint([]byte("some other certificate"))
		},
	}, {
		name:   "an appraiser that could not answer",
		stage:  swarmevidence.StageRootQuote,
		reason: "the registry could not be consulted",
		blob:   func(t *testing.T, f *fixture) []byte { return f.bundle(t, nil) },
		tweak: func(_ *fixture, o *swarmevidence.Options) {
			o.QuoteAppraiser = &stubAppraiser{err: errStub}
		},
	}, {
		name:   "a quote that attests some VM rather than this authority",
		stage:  swarmevidence.StageBinding,
		reason: "does not commit to the pinned root certificate's public key",
		blob:   func(t *testing.T, f *fixture) []byte { return f.bundle(t, nil) },
		tweak: func(_ *fixture, o *swarmevidence.Options) {
			appraisal := stubAppraisal()
			appraisal.KeyBinding = false
			o.QuoteAppraiser = &stubAppraiser{appraisal: appraisal}
		},
	}, {
		name:   "a root on a curve crypto/x509 cannot read",
		stage:  swarmevidence.StageRootQuote,
		reason: "not readable",
		blob:   func(t *testing.T, f *fixture) []byte { return f.secp256k1Bundle(t) },
		tweak: func(f *fixture, o *swarmevidence.Options) {
			o.PKIRoots = []attestation.TrustedRoot{{Name: "swarm-cloud-k256", PEM: f.k1Root.PEM}}
			o.ObservedTLSFingerprint = f.k1Leaf.Fingerprint()
		},
	}} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			fixture := newFixture(t)
			options := fixture.options()
			blob := c.blob(t, fixture)
			if c.tweak != nil {
				c.tweak(fixture, &options)
			}

			claims, err := swarmevidence.AppraiseComposite(context.Background(), blob, options)
			var denial *swarmevidence.Denial
			if !asDenial(err, &denial) {
				t.Fatalf("err = %v, want a *Denial", err)
			}
			if denial.Stage != c.stage {
				t.Errorf("stage = %q, want %q (reason: %s)", denial.Stage, c.stage, denial.Reason)
			}
			if c.reason != "" && !strings.Contains(denial.Reason, c.reason) {
				t.Errorf("reason %q does not contain %q", denial.Reason, c.reason)
			}
			assertDenialOnly(t, claims, denial)
		})
	}
}

// TestAppraiseUnsignedImageIsAClaim pins the line between an answer and a
// failure to reach one. An image nobody has signed yet is what a local or test
// build looks like: the hardware held up, and whether to accept it is the
// relying party's call — so it is a claim, not a denial. Folding it into a
// denial would make the whole reference-value mechanism unreachable.
func TestAppraiseUnsignedImageIsAClaim(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t)
	options := fixture.options()
	appraisal := stubAppraisal()
	appraisal.MrEnclaveApproved = false
	appraisal.MrEnclaveSource = ""
	options.QuoteAppraiser = &stubAppraiser{appraisal: appraisal}

	claims, err := swarmevidence.AppraiseComposite(context.Background(), fixture.bundle(t, nil), options)
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}
	if claims.MrEnclaveApproved == nil || *claims.MrEnclaveApproved {
		t.Errorf("mrenclave_approved = %v, want a reported false", claims.MrEnclaveApproved)
	}
	if claims.MrEnclaveSource != "" {
		t.Errorf("mrenclave_source = %q, want none: nothing vouched for the image",
			claims.MrEnclaveSource)
	}
	if claims.MrEnclave == "" {
		t.Error("mrenclave is absent, but the appraisal derived one")
	}
}

// assertDenialOnly checks the rule the schema states: a refused appraisal
// carries the schema version, the freshness input it was asked to bind, and the
// denial — and no other member. Anything else could be read as a partial pass.
func assertDenialOnly(t *testing.T, claims swarmevidence.SwarmClaims, denial *swarmevidence.Denial) {
	t.Helper()
	if claims.Denial == nil || *claims.Denial != *denial {
		t.Errorf("claims.denial = %v, want the same denial the error carries", claims.Denial)
	}

	encoded, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	var emitted map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &emitted); err != nil {
		t.Fatalf("parse claims: %v", err)
	}
	for name := range emitted {
		switch name {
		case "schema_version", "freshness_input", "denial":
		default:
			t.Errorf("a refused appraisal emitted %q; a denial must carry no other claim", name)
		}
	}
}
