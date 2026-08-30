package policy_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy"
)

// treeMatchPolicy asks custom.tree_match to compare a pattern taken from the
// input against the snapshot, so one policy can drive the whole table.
const treeMatchPolicy = `package user.treematch

default allow := false

allow if {
	custom.tree_match(input.evidence.pattern, input.evidence.actual)
}
`

func TestTreeMatchBuiltin(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		actual  string
		want    bool
	}{
		{
			name:    "subset of keys matches",
			pattern: `{"version": 2}`,
			actual:  `{"version": 2, "resources": []}`,
			want:    true,
		},
		{
			name:    "keys only in actual are ignored",
			pattern: `{"a": {"b": 1}}`,
			actual:  `{"a": {"b": 1, "c": 2}, "d": 3}`,
			want:    true,
		},
		{
			name:    "missing key does not match",
			pattern: `{"a": 1, "b": 2}`,
			actual:  `{"a": 1}`,
			want:    false,
		},
		{
			name:    "differing leaf does not match",
			pattern: `{"a": {"b": 1}}`,
			actual:  `{"a": {"b": 2}}`,
			want:    false,
		},
		{
			name:    "nested objects recurse",
			pattern: `{"spec": {"template": {"spec": {"nodeName": "tee-1"}}}}`,
			actual:  `{"spec": {"template": {"spec": {"nodeName": "tee-1", "containers": []}}}, "kind": "Deployment"}`,
			want:    true,
		},
		{
			name:    "arrays are compared exactly, not as subsets",
			pattern: `{"images": ["a"]}`,
			actual:  `{"images": ["a", "b"]}`,
			want:    false,
		},
		{
			name:    "equal arrays match",
			pattern: `{"images": ["a", "b"]}`,
			actual:  `{"images": ["a", "b"]}`,
			want:    true,
		},
		{
			name:    "an object pattern never matches a scalar",
			pattern: `{"a": {"b": 1}}`,
			actual:  `{"a": "b"}`,
			want:    false,
		},
		{
			name:    "an empty pattern matches anything object-shaped",
			pattern: `{}`,
			actual:  `{"a": 1}`,
			want:    true,
		},
		{
			name:    "booleans and nulls compare by value",
			pattern: `{"enabled": true, "extra": null}`,
			actual:  `{"enabled": true, "extra": null}`,
			want:    true,
		},
		{
			name:    "differing booleans do not match",
			pattern: `{"enabled": true}`,
			actual:  `{"enabled": false}`,
			want:    false,
		},
	}

	engine := newEngine(t, policy.Module{Name: "treematch", Filename: "treematch.rego", Source: treeMatchPolicy})

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			input := inputFor(t, "llama", pinnedDigest)
			evidence := input["evidence"].(map[string]any)
			evidence["pattern"] = mustJSON(t, tc.pattern)
			evidence["actual"] = mustJSON(t, tc.actual)

			decision := engine.Evaluate(context.Background(), input)
			// The built-in pin policy allows this input, so the verdict is the
			// tree_match result.
			if decision.Allow != tc.want {
				t.Errorf("tree_match(%s, %s) = %v, want %v (%s)", tc.pattern, tc.actual, decision.Allow, tc.want, decision.Reason)
			}
		})
	}
}

func TestTreeMatchIsUsableAgainstTheSnapshot(t *testing.T) {
	const policySource = `package user.snapshot

default allow := false

allow if {
	custom.tree_match({"version": 2}, input.evidence.evidence)
}
`
	engine := newEngine(t, policy.Module{Name: "snapshot", Filename: "snapshot.rego", Source: policySource})

	if decision := engine.Evaluate(context.Background(), inputFor(t, "llama", pinnedDigest)); !decision.Allow {
		t.Errorf("Allow = false, want true: the snapshot is version 2 (%s)", decision.Reason)
	}
}

func TestTreeMatchNameIsTheOneTheRustGatekeeperUses(t *testing.T) {
	if got, want := policy.TreeMatchName, "custom.tree_match"; got != want {
		t.Errorf("TreeMatchName = %q, want %q — policies are meant to port over unchanged", got, want)
	}
}

func mustJSON(t *testing.T, raw string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatalf("test fixture %s is not JSON: %v", raw, err)
	}
	return value
}
