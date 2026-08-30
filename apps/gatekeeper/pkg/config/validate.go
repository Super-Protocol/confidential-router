package config

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// Patterns kept in lockstep with schemas/gatekeeper-config.schema.json. They are
// duplicated rather than derived so that loading never depends on shipping the
// JSON schema next to the binary; libs/types' schema test guards the other side.
var (
	namePattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	listenPattern   = regexp.MustCompile(`^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):([0-9]{1,5})$`)
	upstreamPattern = regexp.MustCompile(`^https://[^/?#]+/?$`)
	digestPattern   = regexp.MustCompile(`^(sha256/[A-Za-z0-9_-]{43}|sha256:[0-9a-fA-F]{64}|[0-9a-fA-F]{64})$`)
	pemPattern      = regexp.MustCompile(`(?s)^-----BEGIN CERTIFICATE-----.+-----END CERTIFICATE-----\s*$`)
	logLevels       = []string{"debug", "info", "warn", "error"}
	logFormats      = []string{"text", "json"}
	failModes       = []string{FailClosed, FailOpen}
)

// FieldError is one validation problem, addressed by its path in the document.
type FieldError struct {
	// Path is a dotted/indexed path such as `endpoints[1].listen`.
	Path string
	// Message says what is wrong and, where useful, what was expected.
	Message string
	// Incomplete marks a problem that is only about the configuration not being
	// *runnable yet* — a required list that is still empty — rather than about a
	// value being wrong. A config is built up one command at a time
	// (`gatekeeper init`, then `trust roots add`, then `endpoint add`), so the
	// editing commands accept an incomplete file; [Config.Validate], which
	// `gatekeeper config validate` and startup use, does not.
	Incomplete bool
}

func (e FieldError) Error() string { return e.Path + ": " + e.Message }

// ValidationError aggregates every problem found in one pass, so a user fixing
// a config sees all of them at once instead of one per run.
type ValidationError struct {
	// Source is the file the problems came from, when known.
	Source string
	Errors []FieldError
}

func (e *ValidationError) Error() string {
	var b strings.Builder
	where := "configuration"
	if e.Source != "" {
		where = e.Source
	}
	fmt.Fprintf(&b, "invalid %s (%d problem", where, len(e.Errors))
	if len(e.Errors) != 1 {
		b.WriteByte('s')
	}
	b.WriteString("):")
	for _, fe := range e.Errors {
		b.WriteString("\n  - " + fe.Error())
	}
	return b.String()
}

type problems struct {
	list []FieldError
}

func (p *problems) addf(path, format string, args ...any) {
	p.list = append(p.list, FieldError{Path: path, Message: fmt.Sprintf(format, args...)})
}

// addIncompletef records a problem that only means "not runnable yet"; see
// [FieldError.Incomplete].
func (p *problems) addIncompletef(path, format string, args ...any) {
	p.list = append(p.list, FieldError{Path: path, Message: fmt.Sprintf(format, args...), Incomplete: true})
}

// Validate reproduces the JSON schema's constraints plus the cross-field rules
// the schema cannot express (unique names, unique listen addresses). It returns
// a *ValidationError listing every problem, or nil.
func (c *Config) Validate() error { return c.validate(true) }

// ValidateEditable checks everything [Config.Validate] does except whether the
// file is complete enough to run: an empty `trustedRoots`, an endpoint list
// with no entries and an endpoint without pins are all accepted.
//
// It is what the config-editing commands validate against. `gatekeeper init`
// deliberately writes a config that is not yet runnable, and every `trust`/
// `endpoint` command that fills it in has to be able to save its result —
// while still refusing to write a malformed value. Readiness is reported by
// `gatekeeper config validate` and enforced at startup.
func (c *Config) ValidateEditable() error { return c.validate(false) }

func (c *Config) validate(completeness bool) error {
	p := &problems{}

	if c.Version != SchemaVersion {
		p.addf("version", "must be %d, got %d", SchemaVersion, c.Version)
	}

	c.validateRoots(p)
	c.validatePolicies(p)
	validateTuning(p, yamlField("defaults"), c.Defaults)
	c.validateEndpoints(p)
	c.validateObservability(p)
	c.validateOverlays(p)

	list := p.list
	if !completeness {
		list = list[:0:0]
		for _, fe := range p.list {
			if !fe.Incomplete {
				list = append(list, fe)
			}
		}
	}
	if len(list) == 0 {
		return nil
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].Path < list[j].Path })
	return &ValidationError{Source: c.Path, Errors: list}
}

func (c *Config) validateRoots(p *problems) {
	if len(c.TrustedRoots) == 0 {
		p.addIncompletef("trustedRoots", "at least one trusted root is required — the gatekeeper has no built-in trust")
	}
	seen := map[string]int{}
	for i, root := range c.TrustedRoots {
		path := fmt.Sprintf("trustedRoots[%d]", i)
		validateName(p, path+".name", root.Name)
		if prev, dup := seen[root.Name]; dup && root.Name != "" {
			p.addf(path+".name", "duplicate name %q (already used by trustedRoots[%d])", root.Name, prev)
		} else if root.Name != "" {
			seen[root.Name] = i
		}
		switch {
		case root.PEM != "" && root.PEMFile != "":
			p.addf(path, "set either pem or pemFile, not both")
		case root.PEM == "" && root.PEMFile == "":
			p.addf(path, "one of pem or pemFile is required")
		case root.PEM != "" && !pemPattern.MatchString(strings.TrimSpace(root.PEM)+"\n"):
			p.addf(path+".pem", "is not a PEM certificate block (expected -----BEGIN CERTIFICATE-----…-----END CERTIFICATE-----)")
		}
	}
}

func (c *Config) validatePolicies(p *problems) {
	seen := map[string]int{}
	for i, pol := range c.Policies {
		path := fmt.Sprintf("policies[%d]", i)
		validateName(p, path+".name", pol.Name)
		if prev, dup := seen[pol.Name]; dup && pol.Name != "" {
			p.addf(path+".name", "duplicate name %q (already used by policies[%d])", pol.Name, prev)
		} else if pol.Name != "" {
			seen[pol.Name] = i
		}
		switch {
		case pol.File == "":
			p.addf(path+".file", "is required")
		case !strings.HasSuffix(pol.File, ".rego"):
			p.addf(path+".file", "must point at a .rego module, got %q", pol.File)
		}
	}
}

func (c *Config) validateEndpoints(p *problems) {
	if len(c.Endpoints) == 0 {
		p.addIncompletef("endpoints", "at least one endpoint is required")
	}
	names := map[string]int{}
	listens := map[string]int{}
	for i, ep := range c.Endpoints {
		path := fmt.Sprintf("endpoints[%d]", i)
		validateName(p, path+".name", ep.Name)
		if prev, dup := names[ep.Name]; dup && ep.Name != "" {
			p.addf(path+".name", "duplicate name %q (already used by endpoints[%d])", ep.Name, prev)
		} else if ep.Name != "" {
			names[ep.Name] = i
		}

		validateListen(p, path+".listen", ep.Listen)
		if prev, dup := listens[ep.Listen]; dup && ep.Listen != "" {
			p.addf(path+".listen", "duplicate listen address %q (already used by endpoints[%d])", ep.Listen, prev)
		} else if ep.Listen != "" {
			listens[ep.Listen] = i
		}

		switch {
		case ep.Upstream == "":
			p.addf(path+".upstream", "is required")
		case !upstreamPattern.MatchString(ep.Upstream):
			p.addf(path+".upstream", "must be an https:// base URL without path, query or fragment, got %q", ep.Upstream)
		}

		if len(ep.TrustedEvidence) == 0 {
			p.addIncompletef(path+".trustedEvidence", "at least one pinned evidenceDigest is required — there is no trust-on-first-use")
		}
		pinned := map[string]int{}
		for j, digest := range ep.TrustedEvidence {
			dpath := fmt.Sprintf("%s.trustedEvidence[%d]", path, j)
			if !digestPattern.MatchString(digest) {
				p.addf(dpath, "is not an evidenceDigest (expected sha256/<43 base64url chars>, sha256:<64 hex> or bare 64 hex), got %q", digest)
				continue
			}
			if prev, dup := pinned[digest]; dup {
				p.addf(dpath, "duplicate pin (already listed at index %d)", prev)
				continue
			}
			pinned[digest] = j
		}

		validateTuning(p, yamlField(path), ep.Tuning)
	}
}

func (c *Config) validateObservability(p *problems) {
	if c.Log.Level != "" && !slices.Contains(logLevels, c.Log.Level) {
		p.addf("log.level", "must be one of %s, got %q", strings.Join(logLevels, ", "), c.Log.Level)
	}
	if c.Log.Format != "" && !slices.Contains(logFormats, c.Log.Format) {
		p.addf("log.format", "must be one of %s, got %q", strings.Join(logFormats, ", "), c.Log.Format)
	}
	if c.Metrics != nil {
		validateListen(p, "metrics.listen", c.Metrics.Listen)
	}
}

// namer maps a tuning field to how the layer being validated spells it, so a
// bad value is reported as `endpoints[0].failMode`, `$CR_GATEKEEPER_FAIL_MODE`
// or `-fail-mode` depending on where it came from.
type namer func(field string) string

func yamlField(prefix string) namer {
	return func(field string) string { return prefix + "." + field }
}

func validateTuning(p *problems, name namer, t EndpointTuning) {
	if t.FailMode != "" && !slices.Contains(failModes, t.FailMode) {
		p.addf(name("failMode"), "must be one of %s, got %q", strings.Join(failModes, ", "), t.FailMode)
	}
	for _, d := range []struct {
		field string
		value *Duration
	}{
		{"reattestInterval", t.ReattestInterval},
		{"verdictCacheTtl", t.VerdictCacheTTL},
		{"maxBundleAge", t.MaxBundleAge},
		{"initialTimeout", t.InitialTimeout},
	} {
		if d.value != nil && *d.value <= 0 {
			p.addf(name(d.field), "must be greater than zero")
		}
	}
}

// validateOverlays checks the environment and command-line layers. They are not
// part of the decoded document, so without this a typo such as
// CR_GATEKEEPER_FAIL_MODE=opne would silently become the effective fail mode of
// every endpoint.
func (c *Config) validateOverlays(p *problems) {
	validateTuning(p, envVarName(""), c.envOverlay.global)

	endpoints := make([]string, 0, len(c.envOverlay.perEndpoint))
	for name := range c.envOverlay.perEndpoint {
		endpoints = append(endpoints, name)
	}
	sort.Strings(endpoints)
	for _, name := range endpoints {
		validateTuning(p, envVarName(name), c.envOverlay.perEndpoint[name])
	}

	validateTuning(p, flagName, c.flagOverlay.global)
}

func validateName(p *problems, path, name string) {
	switch {
	case name == "":
		p.addf(path, "is required")
	case !namePattern.MatchString(name):
		p.addf(path, "must be lower-case letters, digits or dashes starting with a letter or digit (max 63 chars), got %q", name)
	}
}

func validateListen(p *problems, path, addr string) {
	if addr == "" {
		p.addf(path, "is required")
		return
	}
	m := listenPattern.FindStringSubmatch(addr)
	if m == nil {
		p.addf(path, "must be host:port, e.g. 127.0.0.1:8443, got %q", addr)
		return
	}
	port, err := strconv.Atoi(m[2])
	if err != nil || port < 1 || port > 65535 {
		p.addf(path, "port must be between 1 and 65535, got %q", m[2])
	}
}
