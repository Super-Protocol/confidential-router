package swarmevidence_test

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"testing"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// claimReference is the prose that ships beside the schema. It is embedded
// here rather than exported from the package because it is documentation about
// the contract, not the contract: the schema is what a policy is written
// against.
//
//go:embed schema/swarmclaims.v1.md
var claimReference string

// claimHeading matches a claim-reference section heading, which names one or
// more claims in backticks: "### `locked`, `locked_at`".
var claimHeading = regexp.MustCompile("(?m)^### (`[a-z_]+`(?:, `[a-z_]+`)*)\\s*$")

var backtickedName = regexp.MustCompile("`([a-z_]+)`")

// TestClaimReferenceCoversTheSchema holds the published claim reference and the
// published schema to each other, in both directions.
//
// A reference page that quietly loses a claim is worse than no page: a bank
// writes its policy from what it can read, and a claim nobody documented is a
// claim nobody enforces. A page that documents a claim the schema does not
// publish is the same failure pointing the other way — a policy written against
// a sentence, and a claim set that never carries the value.
func TestClaimReferenceCoversTheSchema(t *testing.T) {
	t.Parallel()

	documented := documentedClaims(t)
	published := publishedClaims(t)

	for _, claim := range published {
		if !slices.Contains(documented, claim) {
			t.Errorf("the schema publishes %q and schema/swarmclaims.v1.md documents no section for it",
				claim)
		}
	}
	for _, claim := range documented {
		if !slices.Contains(published, claim) {
			t.Errorf("schema/swarmclaims.v1.md documents %q and the schema does not publish it", claim)
		}
	}
}

// TestClaimReferenceNamesEveryNestedMember checks the members of the two
// object-valued claims, which are documented inside their parent's section
// rather than in one of their own.
func TestClaimReferenceNamesEveryNestedMember(t *testing.T) {
	t.Parallel()

	for _, parent := range []string{"measurements", "platform_security", "denial"} {
		for _, member := range nestedMembers(t, parent) {
			if !strings.Contains(claimReference, "`"+member+"`") {
				t.Errorf("the schema publishes %s.%s and the claim reference does not name it",
					parent, member)
			}
		}
	}
}

func documentedClaims(t *testing.T) []string {
	t.Helper()
	var claims []string
	for _, heading := range claimHeading.FindAllStringSubmatch(claimReference, -1) {
		for _, name := range backtickedName.FindAllStringSubmatch(heading[1], -1) {
			claims = append(claims, name[1])
		}
	}
	if len(claims) == 0 {
		t.Fatal("no claim sections were found in schema/swarmclaims.v1.md")
	}
	return claims
}

func publishedClaims(t *testing.T) []string {
	t.Helper()
	return propertyNames(t, schemaProperties(t, nil))
}

func nestedMembers(t *testing.T, parent string) []string {
	t.Helper()
	return propertyNames(t, schemaProperties(t, []string{parent}))
}

// schemaProperties walks into the named property and returns its "properties"
// object; a nil path returns the schema's own.
func schemaProperties(t *testing.T, path []string) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(swarmevidence.Schema, &document); err != nil {
		t.Fatalf("parse the embedded schema: %v", err)
	}
	current := document
	for _, step := range path {
		properties, ok := current["properties"].(map[string]any)
		if !ok {
			t.Fatalf("the schema has no properties at %q", step)
		}
		current, ok = properties[step].(map[string]any)
		if !ok {
			t.Fatalf("the schema publishes no %q", step)
		}
	}
	properties, ok := current["properties"].(map[string]any)
	if !ok {
		t.Fatalf("the schema describes no properties at %v", path)
	}
	return properties
}

func propertyNames(t *testing.T, properties map[string]any) []string {
	t.Helper()
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}
