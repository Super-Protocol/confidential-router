package config

import (
	"fmt"
	"regexp"
	"time"

	"gopkg.in/yaml.v3"
)

// durationPattern mirrors `$defs/duration` of schemas/gatekeeper-config.schema.json:
// a positive Go duration built from ms/s/m/h units only. `time.ParseDuration`
// is far more permissive (negatives, `ns`, `1.5h`), so the pattern is what
// decides — a config that the JSON schema rejects must not load either.
var durationPattern = regexp.MustCompile(`^([0-9]+(ms|s|m|h))+$`)

// Duration is a YAML-friendly wrapper around time.Duration. It round-trips as
// the Go duration string ("5m", "60s", "24h") rather than as a nanosecond
// count, so a rewritten config still reads the way the user wrote it.
type Duration time.Duration

// ParseDuration parses the schema's duration form.
func ParseDuration(s string) (Duration, error) {
	if !durationPattern.MatchString(s) {
		return 0, fmt.Errorf("%q is not a duration of the form 30s, 5m, 24h (units ms, s, m, h)", s)
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a valid duration: %w", s, err)
	}
	return Duration(d), nil
}

// Std returns the wrapped time.Duration.
func (d Duration) Std() time.Duration { return time.Duration(d) }

func (d Duration) String() string { return time.Duration(d).String() }

// UnmarshalYAML accepts the string form only; a bare number would be ambiguous
// (seconds? nanoseconds?) and the schema does not allow it.
func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	var s string
	if err := node.Decode(&s); err != nil {
		return fmt.Errorf("expected a duration string such as 5m, got %s", describeNode(node))
	}
	parsed, err := ParseDuration(s)
	if err != nil {
		return err
	}
	*d = parsed
	return nil
}

// MarshalYAML renders the canonical Go duration string.
func (d Duration) MarshalYAML() (any, error) { return d.String(), nil }

func describeNode(node *yaml.Node) string {
	if node == nil {
		return "nothing"
	}
	if node.Value != "" {
		return fmt.Sprintf("%q", node.Value)
	}
	switch node.Kind {
	case yaml.MappingNode:
		return "a mapping"
	case yaml.SequenceNode:
		return "a sequence"
	default:
		return "an unexpected value"
	}
}
