package swarmpolicy_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/open-policy-agent/opa/v1/ast"
	"github.com/open-policy-agent/opa/v1/tester"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// TestRegoPolicy runs the Rego unit tests — the allow case and one per denial
// — through OPA's own tester, so a bank's CI needs no `opa` binary and this
// repository's CI needs no extra tool.
func TestRegoPolicy(t *testing.T) {
	t.Parallel()

	runner := tester.NewRunner().SetModules(loadRegoModules(t)).EnableTracing(false)
	results, err := runner.RunTests(t.Context(), nil)
	if err != nil {
		t.Fatalf("running the Rego tests: %v", err)
	}

	var ran int
	for result := range results {
		ran++
		switch {
		case result.Error != nil:
			t.Errorf("%s: %v", result.Name, result.Error)
		case result.Fail:
			t.Errorf("%s: failed", result.Name)
		case result.Skip:
			t.Logf("%s: skipped", result.Name)
		}
	}
	if ran == 0 {
		t.Fatal("no Rego tests ran; the module is not being loaded")
	}
	t.Logf("%d Rego tests", ran)
}

// TestPolicyReadsOnlyClaimsTheSchemaPublishes is the check a policy language
// cannot make for itself.
//
// A misspelt claim name in Rego is not an error: `object.get(input,
// "mrenclave_aproved", false)` is a perfectly good expression that denies
// every request, and a policy whose structural checks all deny is only
// noticed when it is in front of a real request. Every name the module reads
// is therefore held against the published SwarmClaims schema.
func TestPolicyReadsOnlyClaimsTheSchemaPublishes(t *testing.T) {
	t.Parallel()

	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(swarmevidence.Schema, &schema); err != nil {
		t.Fatalf("reading the SwarmClaims schema: %v", err)
	}

	source, err := os.ReadFile(filepath.Join("rego", "swarm_claims.rego"))
	if err != nil {
		t.Fatalf("reading the policy: %v", err)
	}
	read := claimNames(string(source))
	if len(read) == 0 {
		t.Fatal("no claim names were found in the policy; the scan is broken, not the policy")
	}
	for _, claim := range read {
		if _, ok := schema.Properties[claim]; !ok {
			t.Errorf("the policy reads %q, which SwarmClaims v1 does not publish", claim)
		}
	}
	t.Logf("the policy reads %d claims: %s", len(read), strings.Join(read, ", "))
}

// claimNames collects every claim the policy reads out of `input`: the
// `object.get(input, "x", …)` calls and the names in the structural list.
var (
	objectGetInput = regexp.MustCompile(`object\.get\(input,\s*"([a-z0-9_]+)"`)
	structuralList = regexp.MustCompile(`(?s)some claim in \[(.*?)\]`)
	quotedName     = regexp.MustCompile(`"([a-z0-9_]+)"`)
)

func claimNames(source string) []string {
	var names []string
	for _, match := range objectGetInput.FindAllStringSubmatch(source, -1) {
		names = append(names, match[1])
	}
	for _, block := range structuralList.FindAllStringSubmatch(source, -1) {
		for _, match := range quotedName.FindAllStringSubmatch(block[1], -1) {
			names = append(names, match[1])
		}
	}
	slices.Sort(names)
	return slices.Compact(names)
}

// TestSentinelPolicy runs the Sentinel suite — the same allow case and the
// same denials — with the Sentinel CLI.
//
// Sentinel has no Go test harness that is free to vendor, so this shells out
// and skips when the binary is absent. CI installs it (the `policy` job in
// .github/workflows/pull-request.yml); locally, `make -C libs/swarm-policy
// sentinel` fetches it.
func TestSentinelPolicy(t *testing.T) {
	t.Parallel()

	binary, err := exec.LookPath("sentinel")
	if err != nil {
		t.Skip("the Sentinel CLI is not on PATH; see libs/swarm-policy/README.md")
	}
	command := exec.CommandContext(t.Context(), binary, "test", "-verbose")
	command.Dir = "sentinel"
	output, err := command.CombinedOutput()
	t.Log("\n" + string(output))
	if err != nil {
		t.Fatalf("sentinel test: %v", err)
	}
}

// TestSentinelAndRegoCoverTheSamePredicates holds the two artefacts to each
// other.
//
// They are two implementations of one decision, for two deployments of Vault,
// and the failure that matters is one of them quietly losing a check. Both
// declare their predicates by name, so the names are compared.
func TestSentinelAndRegoCoverTheSamePredicates(t *testing.T) {
	t.Parallel()

	sentinel, err := os.ReadFile(filepath.Join("sentinel", "swarm-claims.sentinel"))
	if err != nil {
		t.Fatalf("reading the Sentinel policy: %v", err)
	}
	rego, err := os.ReadFile(filepath.Join("rego", "swarm_claims.rego"))
	if err != nil {
		t.Fatalf("reading the Rego policy: %v", err)
	}

	for _, claim := range claimNames(string(rego)) {
		if !strings.Contains(string(sentinel), `"`+claim+`"`) {
			t.Errorf("the Rego policy reads %q and the Sentinel policy does not", claim)
		}
	}
	for _, setting := range []string{
		"approved_images", "reference_builds", "required_pss_enforce", "required_network_type",
	} {
		if !strings.Contains(string(sentinel), setting) {
			t.Errorf("the Sentinel policy has no %s setting", setting)
		}
		if !strings.Contains(string(rego), setting) {
			t.Errorf("the Rego policy has no %s setting", setting)
		}
	}
}

// loadRegoModules parses the policy and its tests the way OPA's tester wants
// them.
func loadRegoModules(t *testing.T) map[string]*ast.Module {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join("rego", "*.rego"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no Rego modules under rego/: %v", err)
	}
	modules := make(map[string]*ast.Module, len(paths))
	for _, path := range paths {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		module, err := ast.ParseModule(path, string(source))
		if err != nil {
			t.Fatalf("parsing %s: %v", path, err)
		}
		modules[path] = module
	}
	return modules
}
