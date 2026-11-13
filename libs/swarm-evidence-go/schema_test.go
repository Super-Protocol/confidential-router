package swarmevidence_test

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// TestClaimsMatchSchema holds the Go struct and the published JSON Schema to
// each other, in both directions.
//
// The schema is the contract a relying party's policy is written against and
// the struct is what this module emits, so the two drifting apart is the single
// most expensive failure this module can have: a policy would silently stop
// reading a claim that is still being produced, or start requiring one that
// never is. A test that only checked one direction would catch exactly half of
// that.
func TestClaimsMatchSchema(t *testing.T) {
	t.Parallel()
	var schema object
	if err := json.Unmarshal(swarmevidence.Schema, &schema); err != nil {
		t.Fatalf("parse the embedded schema: %v", err)
	}
	compare(t, "SwarmClaims", reflect.TypeFor[swarmevidence.SwarmClaims](), schema)
}

func compare(t *testing.T, path string, goType reflect.Type, schema object) {
	t.Helper()

	properties := schema.object("properties")
	if properties == nil {
		t.Fatalf("%s: the schema describes no properties", path)
		return
	}
	required := schema.strings("required")

	if schema["additionalProperties"] != false {
		t.Errorf("%s: additionalProperties must be false, so a claim nobody declared cannot "+
			"ride along unnoticed", path)
	}

	seen := map[string]bool{}
	for i := range goType.NumField() {
		field := goType.Field(i)
		name, optional, ok := jsonName(field)
		if !ok {
			continue
		}
		seen[name] = true

		property := properties.object(name)
		if property == nil {
			t.Errorf("%s: the struct has %q (%s.%s) and the schema does not",
				path, name, goType.Name(), field.Name)
			continue
		}
		if optional && slices.Contains(required, name) {
			t.Errorf("%s.%s: the struct can omit %q and the schema requires it",
				path, field.Name, name)
		}
		if !optional && !slices.Contains(required, name) {
			t.Errorf("%s.%s: the struct always emits %q and the schema does not require it",
				path, field.Name, name)
		}

		want := schemaTypeOf(property)
		got := jsonTypeOf(field.Type)
		if want != "" && got != want {
			t.Errorf("%s.%s: the struct emits a JSON %s for %q and the schema says %s",
				path, field.Name, got, name, want)
		}
		if got == "object" {
			compare(t, path+"."+field.Name, baseType(field.Type), property)
		}
	}

	for name := range properties {
		if !seen[name] {
			t.Errorf("%s: the schema declares %q and the struct does not produce it", path, name)
		}
	}
}

// jsonName reads a field's wire name and whether the encoder may leave it out.
// `omitzero` counts as optional for the same reason `omitempty` does: a reader
// that may not see the member cannot have it in `required`.
func jsonName(field reflect.StructField) (name string, optional bool, ok bool) {
	tag, present := field.Tag.Lookup("json")
	if !present || tag == "-" || !field.IsExported() {
		return "", false, false
	}
	parts := strings.Split(tag, ",")
	name = parts[0]
	if name == "" {
		name = field.Name
	}
	optional = slices.Contains(parts[1:], "omitempty") ||
		slices.Contains(parts[1:], "omitzero") ||
		field.Type.Kind() == reflect.Pointer
	return name, optional, true
}

// jsonTypeOf is the JSON type the encoder produces for a Go type.
func jsonTypeOf(t reflect.Type) string {
	switch base := baseType(t); base.Kind() {
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "integer"
	case reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Slice, reflect.Array:
		return "array"
	case reflect.Struct, reflect.Map:
		return "object"
	default:
		return base.Kind().String()
	}
}

func baseType(t reflect.Type) reflect.Type {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

// schemaTypeOf reads a property's declared type, deriving it from `const` when
// the property pins a single value instead.
func schemaTypeOf(property object) string {
	if declared, ok := property["type"].(string); ok {
		return declared
	}
	switch property["const"].(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		return "number"
	default:
		return ""
	}
}

type object map[string]any

func (o object) object(key string) object {
	nested, _ := o[key].(map[string]any)
	if nested == nil {
		return nil
	}
	return object(nested)
}

func (o object) strings(key string) []string {
	raw, _ := o[key].([]any)
	out := make([]string, 0, len(raw))
	for _, value := range raw {
		if s, ok := value.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// TestSchemaEnumsMatchConstants checks that every closed set the schema
// publishes is exactly the set of constants this package exports for it. The
// enums are where a claim set stops being self-describing: a policy matches on
// these strings literally, so a value the module can emit and the schema does
// not list is a policy that falls through to its default.
func TestSchemaEnumsMatchConstants(t *testing.T) {
	t.Parallel()
	var schema object
	if err := json.Unmarshal(swarmevidence.Schema, &schema); err != nil {
		t.Fatalf("parse the embedded schema: %v", err)
	}
	properties := schema.object("properties")

	for _, c := range []struct {
		pointer []string
		want    []string
	}{
		{[]string{"platform"}, []string{
			string(swarmevidence.PlatformTDXQemu),
			string(swarmevidence.PlatformTDXGCP),
			string(swarmevidence.PlatformTDXAzure),
			string(swarmevidence.PlatformSNPQemu),
			string(swarmevidence.PlatformSNPAzure),
		}},
		{[]string{"channel_binding"}, []string{
			string(swarmevidence.BindingObserved),
			string(swarmevidence.BindingProducerAsserted),
		}},
		{[]string{"network_type"}, []string{
			string(swarmevidence.NetworkTrusted),
			string(swarmevidence.NetworkUntrusted),
		}},
		{[]string{"mrenclave_source"}, []string{
			string(swarmevidence.SourceRegistry),
			string(swarmevidence.SourceReferenceValues),
		}},
		{[]string{"denial", "properties", "stage"}, []string{
			string(swarmevidence.StageOptions),
			string(swarmevidence.StageBlob),
			string(swarmevidence.StagePKIChain),
			string(swarmevidence.StageRootQuote),
			string(swarmevidence.StageCoverage),
			string(swarmevidence.StageBinding),
			string(swarmevidence.StageEnvelope),
			string(swarmevidence.StageStatement),
		}},
	} {
		property := properties
		for _, step := range c.pointer {
			property = property.object(step)
			if property == nil {
				t.Fatalf("the schema has no property at %v", c.pointer)
			}
		}
		got := property.strings("enum")
		slices.Sort(got)
		want := slices.Clone(c.want)
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Errorf("%v: schema enum = %v, constants are %v", c.pointer, got, want)
		}
	}
}
