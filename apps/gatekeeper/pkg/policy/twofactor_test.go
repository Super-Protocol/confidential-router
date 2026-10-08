package policy_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// twoFactorEngine has two `measurement-and-digest` endpoints over one listed
// measurement: `approved` pins pinnedDigest, `unapproved` pins nothing yet.
func twoFactorEngine(t *testing.T) *policy.Engine {
	t.Helper()
	cfg := &config.Config{
		Version:       config.SchemaVersion,
		AttestedRoots: &config.AttestedRoots{TrustedMeasurements: []string{listedMeasurement}},
		Endpoints: []config.Endpoint{
			{
				Name:            "approved",
				Listen:          "127.0.0.1:8445",
				Upstream:        "https://llama.other-cloud.example",
				Trust:           config.TrustMeasurementAndDigest,
				TrustedEvidence: []string{pinnedDigest.String()},
			},
			{
				Name:     "unapproved",
				Listen:   "127.0.0.1:8446",
				Upstream: "https://llama.other-cloud.example",
				Trust:    config.TrustMeasurementAndDigest,
			},
		},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("test config is invalid: %v", err)
	}
	store, err := trust.New(cfg)
	if err != nil {
		t.Fatalf("building the trust store: %v", err)
	}
	engine, err := policy.New(context.Background(), policy.Options{Store: store})
	if err != nil {
		t.Fatalf("policy.New: %v", err)
	}
	return engine
}

func twoFactorInput(t *testing.T, endpoint string, digest trust.Digest, root *status.AttestedRoot) map[string]any {
	t.Helper()
	src := policy.InputSource{
		Endpoint:               endpoint,
		UpstreamHostname:       "llama.other-cloud.example",
		UpstreamPort:           443,
		Root:                   "attested:842c",
		RootFingerprint:        rootDigest,
		ObservedTLSFingerprint: certDigest,
		VerifiedAt:             time.Date(2026, 10, 8, 14, 0, 0, 0, time.UTC),
		Payload:                payload(digest),
	}
	if root != nil {
		src.RootAttested = true
		src.AttestedRoot = root
	}
	input, err := policy.BuildInput(src)
	if err != nil {
		t.Fatalf("BuildInput: %v", err)
	}
	return input
}

// One table, every combination of the two factors: only both admits.
func TestTwoFactorAdmitsOnlyWhenBothFactorsHold(t *testing.T) {
	t.Parallel()
	engine := twoFactorEngine(t)
	listed := attestedRoot(listedMeasurement, attestedroot.SourceRegistry)
	unlisted := attestedRoot(unlistedMeasurement, attestedroot.SourceRegistry)

	cases := []struct {
		name     string
		endpoint string
		digest   trust.Digest
		root     *status.AttestedRoot
		allow    bool
	}{
		{"listed cloud, pinned deployment", "approved", pinnedDigest, listed, true},
		{"listed cloud, redeployed (T13)", "approved", unpinnedDigest, listed, false},
		{"unlisted cloud, pinned deployment", "approved", pinnedDigest, unlisted, false},
		{"no attested root, pinned deployment", "approved", pinnedDigest, nil, false},
		{"listed cloud, nothing pinned yet", "unapproved", pinnedDigest, listed, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			decision := engine.Evaluate(context.Background(), twoFactorInput(t, tc.endpoint, tc.digest, tc.root))
			if decision.Allow != tc.allow {
				t.Fatalf("allow = %v, want %v (%s)", decision.Allow, tc.allow, decision.Reason)
			}
		})
	}
}

// The generated module carries the mode and the pins, which is what the clause
// reads — an `opa eval` over the same files reproduces the decision.
func TestTheGeneratedModuleCarriesTheTwoFactorMode(t *testing.T) {
	t.Parallel()
	module := policy.GenerateTrustModule(trust.Snapshot{
		Measurements: []string{listedMeasurement},
		Endpoints: []trust.EndpointSnapshot{{
			Name:     "approved",
			Hostname: "llama.other-cloud.example",
			FailMode: config.FailClosed,
			Trust:    config.TrustMeasurementAndDigest,
			Digests:  []string{pinnedDigest.String()},
		}},
	})
	for _, want := range []string{`"trust": "measurement-and-digest"`, pinnedDigest.String(), listedMeasurement} {
		if !strings.Contains(module, want) {
			t.Errorf("module does not contain %q:\n%s", want, module)
		}
	}
}
