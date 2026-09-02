package config

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

// hexScheme is the `sha256:<hex>` spelling accepted as config-input sugar.
const hexScheme = "sha256:"

// nullTag is yaml.v3's tag for an absent or explicitly null value.
const nullTag = "!!null"

// ParseEvidenceDigest normalises a pinned digest as it may be spelled in a
// config file, and is the only place that decides what a config accepts.
//
// The verdict is [attestation.NormalizeEvidenceDigest]'s — the parser held to
// libs/attestation-fixtures/vectors/evidence-digest.json, which the TypeScript
// tooling implements too — so a pin this file loads is a pin the rest of the
// product agrees is a digest. Accepted: `sha256/<43 canonical base64url chars>`
// (one trailing `=` tolerated), `sha256/<64 hex>`, bare hex, and, on top of the
// vectors, `sha256:<64 hex>`: hex is unambiguous on sight, and `sha256:<hex>`
// is how registries and `openssl dgst` print a digest a user then pastes here.
//
// A bare base64url token with no scheme is rejected, as is a base64url spelling
// whose final character carries non-zero trailing bits. Both are permissive-only
// mistakes, and both would be silent: pins are compared as exact strings, so a
// second spelling of the same 32 bytes is a pin that never fires.
func ParseEvidenceDigest(value string) (string, error) {
	body := strings.TrimSpace(value)
	if hex, ok := strings.CutPrefix(body, hexScheme); ok {
		// Strip the scheme and let the shared parser decide, so
		// `sha256:<base64url>` stays rejected along with every other bare token.
		body = hex
	}
	return attestation.NormalizeEvidenceDigest(body)
}

// IsEvidenceDigest reports whether value is a spelling [ParseEvidenceDigest]
// accepts.
func IsEvidenceDigest(value string) bool {
	_, err := ParseEvidenceDigest(value)
	return err == nil
}

// DigestList is an endpoint's `trustedEvidence`: the pinned evidenceDigest
// values, kept as the file spells them.
//
// It decodes itself so that a wrong *shape* is reported as one. Writing a
// single pin without the list — `trustedEvidence: sha256/…` — is the mistake
// this catches, and yaml.v3's own "cannot unmarshal !!str into []string" says
// nothing about what a pin list looks like. The *values* are still checked by
// [Config.Validate], which is where a digest's spelling is decided.
type DigestList []string

// UnmarshalYAML accepts a sequence of scalars, and nothing else.
func (l *DigestList) UnmarshalYAML(node *yaml.Node) error {
	// An anchored list referenced with `*name` arrives as an alias; the
	// sequence behind it is what this is about.
	for node.Kind == yaml.AliasNode && node.Alias != nil {
		node = node.Alias
	}
	if node.Tag == nullTag {
		*l = nil
		return nil
	}
	if node.Kind != yaml.SequenceNode {
		return shapeErrorf(node, "trustedEvidence must be a list of digest strings, got %s", yamlShape(node))
	}
	pins := make(DigestList, 0, len(node.Content))
	for i, item := range node.Content {
		if item.Kind != yaml.ScalarNode || item.Tag == nullTag {
			return shapeErrorf(item,
				"trustedEvidence must be a list of digest strings; item %d is %s", i, yamlShape(item))
		}
		pins = append(pins, item.Value)
	}
	*l = pins
	return nil
}

// shapeErrorf reports a decoding problem the way yaml.v3 does — by line — and
// ends with the shape that would have worked, because the reader is holding a
// file they have to edit rather than a value they can look up.
func shapeErrorf(node *yaml.Node, format string, args ...any) error {
	return fmt.Errorf("line %d: %s (write one pin per line: `- sha256/<43 base64url chars>`)",
		node.Line, fmt.Sprintf(format, args...))
}

// yamlShape names what a node is, in the words the message needs.
func yamlShape(node *yaml.Node) string {
	switch node.Kind {
	case yaml.MappingNode:
		return "a mapping"
	case yaml.SequenceNode:
		return "a list"
	case yaml.AliasNode:
		return "an unresolvable alias"
	}
	switch node.Tag {
	case nullTag:
		return "empty"
	case "!!bool":
		return "a boolean"
	case "!!int", "!!float":
		return "a number"
	}
	return "a string"
}
