package policy_test

import (
	"reflect"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

func TestBuildInputMatchesTheContract(t *testing.T) {
	input := inputFor(t, "llama", pinnedDigest)

	if got, want := input["endpoint"], "llama"; got != want {
		t.Errorf("endpoint = %v, want %v", got, want)
	}

	upstream := input["upstream"].(map[string]any)
	if upstream["hostname"] != "llama.tee.swarm.cloud" || upstream["port"] != 443 {
		t.Errorf("upstream = %+v", upstream)
	}

	attestation := input["attestation"].(map[string]any)
	if attestation["verified"] != true {
		t.Error("attestation.verified must be true: policies never run on unverified evidence")
	}
	if attestation["channelBinding"] != policy.ChannelBindingObserved {
		t.Errorf("channelBinding = %v, want %q", attestation["channelBinding"], policy.ChannelBindingObserved)
	}
	if attestation["root"] != "swarm-cloud-prod" || attestation["rootFingerprint"] != rootDigest.String() {
		t.Errorf("root block = %+v", attestation)
	}
	if attestation["observedTlsFingerprint"] != certDigest.String() {
		t.Errorf("observedTlsFingerprint = %v", attestation["observedTlsFingerprint"])
	}
	if got, want := attestation["verifiedAt"], "2026-08-30T10:11:04Z"; got != want {
		t.Errorf("verifiedAt = %v, want %v (RFC 3339, UTC)", got, want)
	}
	if attestation["quoteFormat"] != "intel-tdx-quote-v5" {
		t.Errorf("quoteFormat = %v", attestation["quoteFormat"])
	}

	evidence := input["evidence"].(map[string]any)
	// The payload is passed through unchanged apart from the documented
	// normalisation and the convenience fields.
	if evidence["kind"] != "DeploymentEvidence" || evidence["hostname"] != "llama.tee.swarm.cloud" {
		t.Errorf("payload fields were not passed through: %+v", evidence)
	}
	if evidence["evidenceDigest"] != pinnedDigest.String() {
		t.Errorf("evidenceDigest = %v, want the canonical form", evidence["evidenceDigest"])
	}
	if evidence["evidenceDigestHex"] != pinnedDigest.Hex() {
		t.Errorf("evidenceDigestHex = %v, want %v", evidence["evidenceDigestHex"], pinnedDigest.Hex())
	}
	if evidence["certFingerprintHex"] != certDigest.Hex() {
		t.Errorf("certFingerprintHex = %v, want %v", evidence["certFingerprintHex"], certDigest.Hex())
	}

	wantImages := []string{
		"ghcr.io/super-protocol/router-api@sha256:11",
		"ghcr.io/super-protocol/vllm-tdx@sha256:22",
	}
	if got := evidence["containerImages"].([]string); !reflect.DeepEqual(got, wantImages) {
		t.Errorf("containerImages = %v, want %v (flattened, de-duplicated, sorted)", got, wantImages)
	}
}

func TestBuildInputNormalisesDigestSpelling(t *testing.T) {
	source := policy.InputSource{
		Endpoint:         "llama",
		UpstreamHostname: "llama.tee.swarm.cloud",
		Payload: map[string]any{
			// A producer that publishes hex must still be comparable against a
			// canonically spelled pin.
			"evidenceDigest":  pinnedDigest.Hex(),
			"certFingerprint": "sha256:" + certDigest.Hex(),
		},
	}
	input, err := policy.BuildInput(source)
	if err != nil {
		t.Fatalf("BuildInput: %v", err)
	}

	evidence := input["evidence"].(map[string]any)
	if evidence["evidenceDigest"] != pinnedDigest.String() {
		t.Errorf("evidenceDigest = %v, want %v", evidence["evidenceDigest"], pinnedDigest)
	}
	if evidence["certFingerprint"] != certDigest.String() {
		t.Errorf("certFingerprint = %v, want %v", evidence["certFingerprint"], certDigest)
	}
	if input["upstream"].(map[string]any)["port"] != 443 {
		t.Error("an unset port must default to 443")
	}
}

func TestBuildInputRejectsIncompletePayloads(t *testing.T) {
	tests := []struct {
		name   string
		source policy.InputSource
	}{
		{"no endpoint", policy.InputSource{Payload: map[string]any{}}},
		{"no payload", policy.InputSource{Endpoint: "llama"}},
		{
			"no evidenceDigest",
			policy.InputSource{Endpoint: "llama", Payload: map[string]any{"certFingerprint": certDigest.String()}},
		},
		{
			"unparseable evidenceDigest",
			policy.InputSource{Endpoint: "llama", Payload: map[string]any{"evidenceDigest": "nonsense"}},
		},
		{
			"no certFingerprint",
			policy.InputSource{Endpoint: "llama", Payload: map[string]any{"evidenceDigest": pinnedDigest.String()}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := policy.BuildInput(tc.source); err == nil {
				t.Fatal("BuildInput accepted an input a policy could not safely judge")
			}
		})
	}
}

func TestBuildInputDoesNotMutateThePayload(t *testing.T) {
	original := payload(pinnedDigest)
	original["evidenceDigest"] = pinnedDigest.Hex()

	if _, err := policy.BuildInput(policy.InputSource{
		Endpoint:         "llama",
		UpstreamHostname: "llama.tee.swarm.cloud",
		Payload:          original,
	}); err != nil {
		t.Fatal(err)
	}
	if original["evidenceDigest"] != pinnedDigest.Hex() {
		t.Error("BuildInput rewrote the caller's payload")
	}
}

func TestBuildInputDefaultsVerifiedAtToNow(t *testing.T) {
	before := time.Now().Add(-time.Second)
	input, err := policy.BuildInput(policy.InputSource{
		Endpoint:         "llama",
		UpstreamHostname: "llama.tee.swarm.cloud",
		Payload:          payload(pinnedDigest),
	})
	if err != nil {
		t.Fatal(err)
	}

	stamp := input["attestation"].(map[string]any)["verifiedAt"].(string)
	parsed, err := time.Parse(time.RFC3339, stamp)
	if err != nil {
		t.Fatalf("verifiedAt %q is not RFC 3339: %v", stamp, err)
	}
	if parsed.Before(before) {
		t.Errorf("verifiedAt = %s, want roughly now", stamp)
	}
}

func TestBuildInputOmitsAnAbsentQuoteFormat(t *testing.T) {
	input, err := policy.BuildInput(policy.InputSource{
		Endpoint:         "llama",
		UpstreamHostname: "llama.tee.swarm.cloud",
		Payload:          payload(pinnedDigest),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := input["attestation"].(map[string]any)["quoteFormat"]; present {
		t.Error("quoteFormat is present although the bundle carried no quote")
	}
}

func TestCollectImagesIgnoresNonStringImageFields(t *testing.T) {
	source := policy.InputSource{
		Endpoint:         "llama",
		UpstreamHostname: "llama.tee.swarm.cloud",
		Payload: map[string]any{
			"evidenceDigest":  pinnedDigest.String(),
			"certFingerprint": certDigest.String(),
			"evidence": map[string]any{
				"image": map[string]any{"repository": "not-a-string-image"},
				"nested": []any{
					map[string]any{"image": "ghcr.io/a@sha256:1"},
					map[string]any{"image": "ghcr.io/a@sha256:1"}, // duplicate
				},
			},
		},
	}
	input, err := policy.BuildInput(source)
	if err != nil {
		t.Fatal(err)
	}

	got := input["evidence"].(map[string]any)["containerImages"].([]string)
	if !reflect.DeepEqual(got, []string{"ghcr.io/a@sha256:1"}) {
		t.Errorf("containerImages = %v, want exactly one de-duplicated image", got)
	}
}

func TestBuildInputAcceptsAMissingSnapshot(t *testing.T) {
	input, err := policy.BuildInput(policy.InputSource{
		Endpoint:         "llama",
		UpstreamHostname: "llama.tee.swarm.cloud",
		Payload: map[string]any{
			"evidenceDigest":  trust.Sum([]byte("x")).String(),
			"certFingerprint": certDigest.String(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := input["evidence"].(map[string]any)["containerImages"].([]string); len(got) != 0 {
		t.Errorf("containerImages = %v, want an empty list", got)
	}
}
