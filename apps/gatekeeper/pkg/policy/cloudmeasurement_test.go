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

// The two measurements every test here is about: one the operator listed, one
// they did not. Both are well-formed mrEnclave hex, because a malformed one
// never reaches the policy — the config layer refuses the file.
const (
	listedMeasurement   = "842c1f6b00000000000000000000000000000000000000000000000000000001"
	unlistedMeasurement = "bb6962eb00000000000000000000000000000000000000000000000000000002"
)

// measurementStore builds a store with one endpoint per trust mode over one
// listed measurement: `external` trusts its cloud by measurement, `llama` keeps
// the digest pin. Having both in one store is the point — every test here also
// asserts the other mode did not move.
func measurementStore(t *testing.T) *trust.Store {
	t.Helper()
	cfg := &config.Config{
		Version:      config.SchemaVersion,
		TrustedRoots: []config.TrustedRoot{{Name: "swarm-cloud-prod", PEM: selfSignedPEM(t)}},
		AttestedRoots: &config.AttestedRoots{
			TrustedMeasurements: []string{listedMeasurement},
		},
		Endpoints: []config.Endpoint{
			{
				Name:            "llama",
				Listen:          "127.0.0.1:8443",
				Upstream:        "https://llama.tee.swarm.cloud",
				TrustedEvidence: []string{pinnedDigest.String()},
			},
			{
				Name:     "external",
				Listen:   "127.0.0.1:8444",
				Upstream: "https://llama.other-cloud.example",
				Trust:    config.TrustCloudMeasurement,
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
	return store
}

func measurementEngine(t *testing.T, modules ...policy.Module) *policy.Engine {
	t.Helper()
	engine, err := policy.New(context.Background(), policy.Options{Store: measurementStore(t), Modules: modules})
	if err != nil {
		t.Fatalf("policy.New: %v", err)
	}
	return engine
}

// attestedRoot is what the attested-root check reports for a root it admitted:
// `attested` true, the measurement it derived, and which anchor vouched for it.
func attestedRoot(measurement string, source attestedroot.MeasurementSource) *status.AttestedRoot {
	return &status.AttestedRoot{
		Attested:          true,
		EvidenceType:      "AMD SEV-SNP",
		NetworkType:       "untrusted",
		ReportIntegrity:   true,
		KeyBinding:        true,
		Measurement:       measurement,
		InRegistry:        source == attestedroot.SourceRegistry,
		MeasurementSource: string(source),
	}
}

// measurementInput builds the `input` document for an endpoint whose root was
// admitted by the attested path. The evidenceDigest is deliberately one no
// endpoint pins: a cloud-measurement endpoint must not need one.
func measurementInput(t *testing.T, endpoint string, root *status.AttestedRoot) map[string]any {
	t.Helper()
	src := policy.InputSource{
		Endpoint:               endpoint,
		UpstreamHostname:       "llama.other-cloud.example",
		UpstreamPort:           443,
		Root:                   "attested:842c",
		RootFingerprint:        rootDigest,
		ObservedTLSFingerprint: certDigest,
		VerifiedAt:             time.Date(2026, 10, 6, 11, 0, 0, 0, time.UTC),
		Payload:                payload(unpinnedDigest),
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

func TestCloudMeasurementAdmitsAListedMeasurement(t *testing.T) {
	t.Parallel()
	engine := measurementEngine(t)

	// Both anchors, because in this mode the anchor is not what decides: the
	// list is. A registry-signed measurement that is *also* listed is admitted
	// exactly like an operator-pinned one.
	for _, source := range []attestedroot.MeasurementSource{
		attestedroot.SourceOperatorPinned,
		attestedroot.SourceRegistry,
	} {
		t.Run(string(source), func(t *testing.T) {
			t.Parallel()
			input := measurementInput(t, "external", attestedRoot(listedMeasurement, source))
			if decision := engine.Evaluate(context.Background(), input); !decision.Allow {
				t.Fatalf("a listed measurement was denied: %s", decision.Reason)
			}
		})
	}
}

// The ruling this whole mode turns on (ADR-008 §3, ruling 2 on SUP-221): the
// operator's list is the sole authority, so a measurement Super Protocol signed
// and the operator did not list admits nothing. Without this the list would be
// decorative — every genuine Swarm cloud is registry-signed.
func TestCloudMeasurementDeniesAnUnlistedMeasurementEvenWhenRegistrySigned(t *testing.T) {
	t.Parallel()
	engine := measurementEngine(t)

	for _, source := range []attestedroot.MeasurementSource{
		attestedroot.SourceRegistry,
		attestedroot.SourceOperatorPinned,
	} {
		t.Run(string(source), func(t *testing.T) {
			t.Parallel()
			input := measurementInput(t, "external", attestedRoot(unlistedMeasurement, source))
			if decision := engine.Evaluate(context.Background(), input); decision.Allow {
				t.Fatalf("an unlisted measurement was admitted (source %s)", source)
			}
		})
	}
}

// A measurement list is not a licence to skip the hardware half: a root the
// attested-root check did not admit carries no `rootAttestation` at all (the
// trustedRoots case) or carries `attested: false`, and neither admits.
func TestCloudMeasurementRequiresAnAttestedRoot(t *testing.T) {
	t.Parallel()
	engine := measurementEngine(t)

	denied := attestedRoot(listedMeasurement, attestedroot.SourceOperatorPinned)
	denied.Attested = false
	denied.ReportIntegrity = false
	denied.Reason = "report signature does not verify"

	cases := map[string]*status.AttestedRoot{
		"no attested-root check ran": nil,
		"the check denied the root":  denied,
	}
	for name, root := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			input := measurementInput(t, "external", root)
			if root != nil {
				// `attested` is the verifier's own flag, not the check's: a
				// denied root is never marked attested on the input.
				input["attestation"].(map[string]any)["rootAttestation"].(map[string]any)["attested"] = false
			}
			if decision := engine.Evaluate(context.Background(), input); decision.Allow {
				t.Fatalf("admitted without an attested root (%s)", name)
			}
		})
	}
}

// SUP-139's user-side semantics, unchanged: a digest-pinned endpoint is decided
// by its pins and nothing else. A listed measurement does not admit it, and an
// unlisted one does not deny it.
func TestDigestPinnedEndpointsAreUnaffectedByTheMeasurementList(t *testing.T) {
	t.Parallel()
	engine := measurementEngine(t)

	pinnedInput := inputFor(t, "llama", pinnedDigest)
	attestation, ok := pinnedInput["attestation"].(map[string]any)
	if !ok {
		t.Fatal("input has no attestation object")
	}
	attestation["rootAttestation"] = map[string]any{
		"attested":          true,
		"measurement":       unlistedMeasurement,
		"inRegistry":        false,
		"measurementSource": string(attestedroot.SourceOperatorPinned),
	}
	if decision := engine.Evaluate(context.Background(), pinnedInput); !decision.Allow {
		t.Fatalf("a pinned digest was denied because the cloud is not listed: %s", decision.Reason)
	}

	// And the other direction: the measurement list cannot stand in for a pin.
	unpinned := measurementInput(t, "llama", attestedRoot(listedMeasurement, attestedroot.SourceRegistry))
	if decision := engine.Evaluate(context.Background(), unpinned); decision.Allow {
		t.Fatal("a listed measurement admitted a digest-pinned endpoint with no matching pin")
	}
}

// The clause is keyed on the endpoint's own mode, so one endpoint's weaker
// trust never leaks into another's — the property that makes it safe to render
// both modes into one config file.
func TestTheTrustModeIsPerEndpoint(t *testing.T) {
	t.Parallel()
	engine := measurementEngine(t)

	// The `external` endpoint's own admission, for contrast with the pinned one
	// above: same root, same bundle, different verdict purely by mode.
	root := attestedRoot(listedMeasurement, attestedroot.SourceRegistry)
	if decision := engine.Evaluate(context.Background(), measurementInput(t, "external", root)); !decision.Allow {
		t.Fatalf("the cloud-measurement endpoint was denied: %s", decision.Reason)
	}
	if decision := engine.Evaluate(context.Background(), measurementInput(t, "llama", root)); decision.Allow {
		t.Fatal("the digest-pinned endpoint was admitted by the other endpoint's mode")
	}
}

// A user policy can still only narrow: the mode widens what the *built-in*
// clause accepts, and an operator who wants the closed chain back writes one
// rule — the same one the docs publish for operator-pinned roots.
func TestAUserPolicyCanStillNarrowACloudMeasurementEndpoint(t *testing.T) {
	t.Parallel()
	const registryOnly = `package user.registryonly

import rego.v1

default allow := false

allow if not input.attestation.rootAttestation

allow if input.attestation.rootAttestation.measurementSource == "registry"
`
	engine := measurementEngine(t, policy.Module{
		Name: "registry-only", Filename: "registryonly.rego", Source: registryOnly,
	})

	admitted := measurementInput(t, "external", attestedRoot(listedMeasurement, attestedroot.SourceRegistry))
	if decision := engine.Evaluate(context.Background(), admitted); !decision.Allow {
		t.Fatalf("a registry-signed, listed measurement was denied: %s", decision.Reason)
	}

	pinned := measurementInput(t, "external", attestedRoot(listedMeasurement, attestedroot.SourceOperatorPinned))
	decision := engine.Evaluate(context.Background(), pinned)
	if decision.Allow {
		t.Fatal("the user policy did not narrow a listed but operator-pinned cloud")
	}
	if !strings.Contains(decision.Reason, "registry-only") {
		t.Errorf("reason = %q, want the user policy named", decision.Reason)
	}
}

// The generated module is what both clauses read, so the mode and the
// measurement list have to be in it — and `measurements` has to be a Rego set,
// or `some m in …` would iterate an object.
func TestTheGeneratedModuleCarriesTheModeAndTheMeasurements(t *testing.T) {
	t.Parallel()
	module := policy.GenerateTrustModule(measurementStore(t).Snapshot())

	for _, want := range []string{
		`measurements := {"` + listedMeasurement + `"}`,
		`"trust": "cloud-measurement",`,
		`"trust": "evidence-digest",`,
	} {
		if !strings.Contains(module, want) {
			t.Errorf("the generated module does not carry %s:\n%s", want, module)
		}
	}
	if strings.Contains(module, unlistedMeasurement) {
		t.Errorf("the generated module carries a measurement nobody listed:\n%s", module)
	}
}

// An edit to the measurement list has to move the engine's hash, or a
// cloud removed from the list would keep admitting until the verdict cache TTL
// expired (ADR-003 §7).
func TestEditingTheMeasurementListMovesTheEngineHash(t *testing.T) {
	t.Parallel()
	before := measurementEngine(t).Hash()

	cfg := &config.Config{
		Version:      config.SchemaVersion,
		TrustedRoots: []config.TrustedRoot{{Name: "swarm-cloud-prod", PEM: selfSignedPEM(t)}},
		AttestedRoots: &config.AttestedRoots{
			TrustedMeasurements: []string{listedMeasurement, unlistedMeasurement},
		},
		Endpoints: []config.Endpoint{{
			Name:     "external",
			Listen:   "127.0.0.1:8444",
			Upstream: "https://llama.other-cloud.example",
			Trust:    config.TrustCloudMeasurement,
		}},
	}
	store, err := trust.New(cfg)
	if err != nil {
		t.Fatalf("trust.New: %v", err)
	}
	engine, err := policy.New(context.Background(), policy.Options{Store: store})
	if err != nil {
		t.Fatalf("policy.New: %v", err)
	}
	if engine.Hash() == before {
		t.Error("adding a trusted measurement left the engine hash unchanged")
	}
}
