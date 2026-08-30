package policy_test

import (
	"context"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

func TestDefaultPolicyAllowsOnlyPinnedEvidence(t *testing.T) {
	engine := newEngine(t)

	tests := []struct {
		name      string
		endpoint  string
		digest    trust.Digest
		mutate    func(map[string]any)
		wantAllow bool
	}{
		{
			name:      "pinned digest on its endpoint",
			endpoint:  "llama",
			digest:    pinnedDigest,
			wantAllow: true,
		},
		{
			name:      "digest that is not pinned",
			endpoint:  "llama",
			digest:    unpinnedDigest,
			wantAllow: false,
		},
		{
			// Pins are per endpoint (ADR-003 §3): llama's digest says nothing
			// about qwen.
			name:      "pinned digest on a different endpoint",
			endpoint:  "qwen",
			digest:    pinnedDigest,
			wantAllow: false,
		},
		{
			name:      "endpoint that is not in the trust module",
			endpoint:  "mistral",
			digest:    pinnedDigest,
			wantAllow: false,
		},
		{
			name:     "attestation not verified",
			endpoint: "llama",
			digest:   pinnedDigest,
			mutate: func(input map[string]any) {
				input["attestation"].(map[string]any)["verified"] = false
			},
			wantAllow: false,
		},
		{
			name:     "digest replaced by its hex spelling",
			endpoint: "llama",
			digest:   pinnedDigest,
			mutate: func(input map[string]any) {
				// The pin set holds canonical values only, so a hex digest in
				// the input must not match. BuildInput normalises, which is
				// what keeps this from ever happening for real traffic.
				input["evidence"].(map[string]any)["evidenceDigest"] = pinnedDigest.Hex()
			},
			wantAllow: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			input := inputFor(t, tc.endpoint, tc.digest)
			if tc.mutate != nil {
				tc.mutate(input)
			}
			decision := engine.Evaluate(context.Background(), input)
			if decision.Allow != tc.wantAllow {
				t.Errorf("Allow = %v, want %v (reason: %s)", decision.Allow, tc.wantAllow, decision.Reason)
			}
			if len(decision.Packages) != 1 || decision.Packages[0].Package != policy.DefaultPackage {
				t.Errorf("packages = %+v, want only %s", decision.Packages, policy.DefaultPackage)
			}
		})
	}
}

func TestPinWrittenInHexAdmitsTheSameBundle(t *testing.T) {
	// The store normalises pins on load, so a config that spells a pin in hex
	// must admit exactly what a canonically spelled one admits.
	cfg := &config.Config{
		Version:      config.SchemaVersion,
		TrustedRoots: []config.TrustedRoot{{Name: "swarm-cloud-prod", PEM: selfSignedPEM(t)}},
		Endpoints: []config.Endpoint{{
			Name:            "llama",
			Listen:          "127.0.0.1:8443",
			Upstream:        "https://llama.tee.swarm.cloud",
			TrustedEvidence: []string{pinnedDigest.Hex()},
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

	if decision := engine.Evaluate(context.Background(), inputFor(t, "llama", pinnedDigest)); !decision.Allow {
		t.Fatalf("Allow = false, want true (%s)", decision.Reason)
	}
}

const allowAllPolicy = `package user.permissive

default allow := true
`

const denyAllPolicy = `package user.strict

default allow := false
`

const registryPolicy = `package user.images

default allow := false

allow if {
	count(input.evidence.containerImages) > 0
	every image in input.evidence.containerImages {
		startswith(image, "ghcr.io/super-protocol/")
	}
}
`

func TestUserPoliciesAreANDedWithTheBuiltIn(t *testing.T) {
	tests := []struct {
		name       string
		modules    []policy.Module
		digest     trust.Digest
		wantAllow  bool
		wantDenyBy string
	}{
		{
			name:      "no user policy",
			digest:    pinnedDigest,
			wantAllow: true,
		},
		{
			name:      "user policy agrees",
			modules:   []policy.Module{{Name: "images", Filename: "images.rego", Source: registryPolicy}},
			digest:    pinnedDigest,
			wantAllow: true,
		},
		{
			name:       "user policy denies what the pin allows",
			modules:    []policy.Module{{Name: "strict", Filename: "strict.rego", Source: denyAllPolicy}},
			digest:     pinnedDigest,
			wantAllow:  false,
			wantDenyBy: "user.strict",
		},
		{
			// A user policy narrows trust; it can never widen it.
			name:       "permissive user policy cannot rescue an unpinned digest",
			modules:    []policy.Module{{Name: "permissive", Filename: "permissive.rego", Source: allowAllPolicy}},
			digest:     unpinnedDigest,
			wantAllow:  false,
			wantDenyBy: policy.DefaultPackage,
		},
		{
			name: "one of several user policies denies",
			modules: []policy.Module{
				{Name: "permissive", Filename: "permissive.rego", Source: allowAllPolicy},
				{Name: "strict", Filename: "strict.rego", Source: denyAllPolicy},
			},
			digest:     pinnedDigest,
			wantAllow:  false,
			wantDenyBy: "user.strict",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			engine := newEngine(t, tc.modules...)
			decision := engine.Evaluate(context.Background(), inputFor(t, "llama", tc.digest))

			if decision.Allow != tc.wantAllow {
				t.Fatalf("Allow = %v, want %v (reason: %s)", decision.Allow, tc.wantAllow, decision.Reason)
			}
			if want := len(tc.modules) + 1; len(decision.Packages) != want {
				t.Errorf("evaluated %d packages, want %d — every package is evaluated, not just up to the first deny",
					len(decision.Packages), want)
			}
			if tc.wantDenyBy == "" {
				return
			}
			for _, p := range decision.Packages {
				if p.Package == tc.wantDenyBy && p.Allow {
					t.Errorf("%s allowed, want it to deny", p.Package)
				}
			}
			if !strings.Contains(decision.Reason, tc.wantDenyBy) {
				t.Errorf("reason %q does not name the denying package %q", decision.Reason, tc.wantDenyBy)
			}
		})
	}
}

func TestRuntimeErrorIsADeny(t *testing.T) {
	const brokenAtRuntime = `package user.broken

default allow := false

allow if {
	# Converting "DeploymentEvidence" to a number is a runtime error, not a
	# parse error: the module compiles and only fails once a request is
	# evaluated against it.
	to_number(input.evidence.kind) > 0
}
`
	engine := newEngine(t, policy.Module{Name: "broken", Filename: "broken.rego", Source: brokenAtRuntime})
	decision := engine.Evaluate(context.Background(), inputFor(t, "llama", pinnedDigest))

	if decision.Allow {
		t.Fatal("Allow = true, want a deny: a policy that cannot be evaluated must never admit traffic")
	}
	var broken policy.PackageDecision
	for _, p := range decision.Packages {
		if p.Package == "user.broken" {
			broken = p
		}
	}
	if broken.Error == "" {
		t.Errorf("the failing package reported no error: %+v", broken)
	}
	if !strings.Contains(decision.Reason, "failed to evaluate") {
		t.Errorf("reason = %q, want it to say the policy failed to evaluate", decision.Reason)
	}
}

func TestUndefinedAllowIsADeny(t *testing.T) {
	// No `default allow`, and the body never holds.
	const noDefault = `package user.undefined

allow if {
	input.evidence.kind == "SomethingElse"
}
`
	engine := newEngine(t, policy.Module{Name: "undefined", Filename: "undefined.rego", Source: noDefault})
	decision := engine.Evaluate(context.Background(), inputFor(t, "llama", pinnedDigest))

	if decision.Allow {
		t.Fatal("Allow = true, want a deny for an undefined `allow`")
	}
}

func TestLoadRejectsBrokenPolicies(t *testing.T) {
	tests := []struct {
		name    string
		modules []policy.Module
		want    string
	}{
		{
			name:    "syntax error",
			modules: []policy.Module{{Name: "bad", Filename: "bad.rego", Source: "package user.bad\n\nallow if {"}},
			want:    "rego_parse_error",
		},
		{
			name:    "no allow rule",
			modules: []policy.Module{{Name: "empty", Filename: "empty.rego", Source: "package user.empty\n\ndeny := true\n"}},
			want:    "defines no `allow` rule",
		},
		{
			name: "two policies in the same package",
			modules: []policy.Module{
				{Name: "a", Filename: "a.rego", Source: "package user.same\n\ndefault allow := true\n"},
				{Name: "b", Filename: "b.rego", Source: "package user.same\n\ndefault allow := true\n"},
			},
			want: "is already declared by",
		},
		{
			name:    "user policy hijacking the built-in package",
			modules: []policy.Module{{Name: "sneaky", Filename: "sneaky.rego", Source: "package gatekeeper.default\n\ndefault allow := true\n"}},
			want:    "already declared by the built-in policy",
		},
		{
			name:    "user policy overwriting the generated trust module",
			modules: []policy.Module{{Name: "sneaky", Filename: "sneaky.rego", Source: "package gatekeeper.trust\n\ndefault allow := true\n"}},
			want:    "already declared by the generated trust module",
		},
		{
			name:    "unknown builtin",
			modules: []policy.Module{{Name: "typo", Filename: "typo.rego", Source: "package user.typo\n\nallow if {\n\tcustom.tree_matchh({}, {})\n}\n"}},
			want:    "rego_type_error",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := policy.New(context.Background(), policy.Options{Store: newStore(t), Modules: tc.modules})
			if err == nil {
				t.Fatal("policy.New succeeded, want a fatal load error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestNewRequiresAStore(t *testing.T) {
	if _, err := policy.New(context.Background(), policy.Options{}); err == nil {
		t.Fatal("policy.New accepted a nil trust store")
	}
}

func TestEvaluateHonoursACancelledContext(t *testing.T) {
	engine := newEngine(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	decision := engine.Evaluate(ctx, inputFor(t, "llama", pinnedDigest))
	if decision.Allow {
		t.Fatal("Allow = true on a cancelled context, want a deny")
	}
}

func TestHashChangesWithPolicyAndPins(t *testing.T) {
	base := newEngine(t).Hash()

	withPolicy := newEngine(t, policy.Module{Name: "images", Filename: "images.rego", Source: registryPolicy}).Hash()
	if withPolicy == base {
		t.Error("adding a policy did not change the engine hash; a policy edit would wait out the verdict cache")
	}

	edited := registryPolicy + "\n# a trailing comment counts as an edit\n"
	if h := newEngine(t, policy.Module{Name: "images", Filename: "images.rego", Source: edited}).Hash(); h == withPolicy {
		t.Error("editing a policy did not change the engine hash")
	}
}

func TestPackagesListsTheBuiltInFirst(t *testing.T) {
	engine := newEngine(t, policy.Module{Name: "images", Filename: "images.rego", Source: registryPolicy})
	packages := engine.Packages()

	if len(packages) != 2 || packages[0] != policy.DefaultPackage || packages[1] != "user.images" {
		t.Errorf("Packages = %v, want [%s user.images]", packages, policy.DefaultPackage)
	}
}

func TestLoadRejectsAnAllowThatIsNotABoolean(t *testing.T) {
	// Both of these parse, but querying data.<pkg>.allow gives a set or an
	// error rather than a verdict — a load-time failure, not a per-request one.
	tests := map[string]string{
		"partial set": "package user.set\n\nallow contains x if {\n\tx := input.endpoint\n}\n",
		"function":    "package user.fn\n\nallow(x) if {\n\tx == input.endpoint\n}\n",
	}
	for name, source := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := policy.New(context.Background(), policy.Options{
				Store:   newStore(t),
				Modules: []policy.Module{{Name: "bad", Filename: "bad.rego", Source: source}},
			})
			if err == nil || !strings.Contains(err.Error(), "defines no `allow` rule") {
				t.Fatalf("err = %v, want the module to be rejected at load", err)
			}
		})
	}
}
