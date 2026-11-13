package swarmevidence_test

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// compileSchema loads the published schema into a real draft 2020-12
// validator.
//
// TestClaimsMatchSchema holds the struct and the schema to each other, which
// is a check on the *shape*. It says nothing about the patterns, the enums or
// the `required` lists, because nothing in it ever runs them — and those are
// exactly what a relying party's own validator will run. A pattern that
// matched nothing this module emits would have gone unnoticed until a bank's
// policy engine rejected a sound claim set (SUP-647 review follow-up).
func compileSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(swarmevidence.Schema))
	if err != nil {
		t.Fatalf("parse the embedded schema: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	const url = "https://super-protocol.com/schemas/swarmclaims.v1.schema.json"
	if err := compiler.AddResource(url, document); err != nil {
		t.Fatalf("add the schema: %v", err)
	}
	schema, err := compiler.Compile(url)
	if err != nil {
		t.Fatalf("compile the schema: %v", err)
	}
	return schema
}

func validate(t *testing.T, schema *jsonschema.Schema, claims swarmevidence.SwarmClaims) error {
	t.Helper()
	encoded, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("re-parse claims: %v", err)
	}
	return schema.Validate(document)
}

// TestRealAppraisalsValidateAgainstTheSchema runs the validator a relying
// party runs, over claim sets this module actually produced rather than over
// documents written by hand to match.
func TestRealAppraisalsValidateAgainstTheSchema(t *testing.T) {
	t.Parallel()
	schema := compileSchema(t)

	for _, c := range []struct {
		name   string
		claims func(t *testing.T) swarmevidence.SwarmClaims
	}{{
		name: "a composite appraisal",
		claims: func(t *testing.T) swarmevidence.SwarmClaims {
			composite := newComposite(t)
			claims, err := swarmevidence.AppraiseComposite(
				context.Background(), composite.blob(t), composite.options())
			if err != nil {
				t.Fatalf("appraise: %v", err)
			}
			return claims
		},
	}, {
		name: "an evidence bundle appraisal",
		claims: func(t *testing.T) swarmevidence.SwarmClaims {
			f := newFixture(t)
			claims, err := swarmevidence.AppraiseComposite(
				context.Background(), f.bundle(t, nil), f.options())
			if err != nil {
				t.Fatalf("appraise: %v", err)
			}
			return claims
		},
	}, {
		name: "a denial",
		claims: func(t *testing.T) swarmevidence.SwarmClaims {
			composite := newComposite(t)
			options := composite.options()
			options.PKIRoots = nil
			claims, _ := swarmevidence.AppraiseComposite(
				context.Background(), composite.blob(t), options)
			return claims
		},
	}} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			if err := validate(t, schema, c.claims(t)); err != nil {
				t.Errorf("a claim set this module produced does not validate:\n%v", err)
			}
		})
	}
}

// TestSchemaPatternsRefuseMalformedClaims is the other direction: every
// pattern in the schema has to actually refuse something, or it is decoration
// a policy author would wrongly rely on.
func TestSchemaPatternsRefuseMalformedClaims(t *testing.T) {
	t.Parallel()
	schema := compileSchema(t)

	for _, c := range []struct {
		name  string
		claim string
		value any
	}{
		{"an odd number of hex digits in the freshness input", "freshness_input", "abc"},
		{"upper-case hex in the freshness input", "freshness_input", "ABCD"},
		{"a subject digest that is not a SHA-256", "binding_subject_digest", strings.Repeat("a", 63)},
		{"an mrenclave that is not 32 octets", "mrenclave", strings.Repeat("b", 62)},
		{"a root fingerprint without its sha256/ framing", "pki_root_fingerprint", strings.Repeat("c", 43)},
		{"a node certificate fingerprint in hex", "node_cert_fingerprint", strings.Repeat("d", 64)},
		{"a platform outside the published set", "platform", "tdx-oracle"},
		{"a network type outside the published set", "network_type", "semi-trusted"},
		{"a channel binding outside the published set", "channel_binding", "assumed"},
		{"an mrenclave source outside the published set", "mrenclave_source", "vibes"},
		{"a claim nobody declared", "pod_colour", "green"},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			document := map[string]any{"schema_version": "1", c.claim: c.value}
			encoded, err := json.Marshal(document)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			parsed, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if err := schema.Validate(parsed); err == nil {
				t.Errorf("the schema accepted %s = %v", c.claim, c.value)
			}
		})
	}
}

// TestSchemaAcceptsEveryFreshnessKindsElementSize pins the pattern that had to
// change for the composite form: the freshness element is the Freshness
// Kind's size, not a fixed 64 octets, and a schema that insisted on the old
// length would reject every `present-nonce` appraisal the TACRA Vault profile
// produces.
func TestSchemaAcceptsEveryFreshnessKindsElementSize(t *testing.T) {
	t.Parallel()
	schema := compileSchema(t)

	for name, octets := range map[string]int{
		"present-nonce, 32 octets":      32,
		"absent-timestamp, 8 octets":    8,
		"the draft's default, 64 bytes": 64,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			claims := swarmevidence.SwarmClaims{
				SchemaVersion:  swarmevidence.ClaimsVersion,
				FreshnessInput: strings.Repeat("a5", octets),
			}
			if err := validate(t, schema, claims); err != nil {
				t.Errorf("a %d-octet freshness element does not validate: %v", octets, err)
			}
		})
	}
}
