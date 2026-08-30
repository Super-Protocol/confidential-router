package config

import (
	"fmt"
	"sort"
	"strings"
)

// envPrefix namespaces every environment override. `GATEKEEPER_CONFIG` is also
// honoured for the config path itself because ADR-003 §8 documents that name.
const envPrefix = "CR_GATEKEEPER_"

// Overrides is the command-line layer. Only non-empty fields are applied, which
// is why [RegisterFlags] reports flags that were not passed as empty.
type Overrides struct {
	ConfigPath       string
	LogLevel         string
	LogFormat        string
	MetricsListen    string
	FailMode         string
	ReattestInterval string
	VerdictCacheTTL  string
	MaxBundleAge     string
	InitialTimeout   string
}

// overlay is a tuning layer applied on top of the file: one global set plus
// per-endpoint sets, the latter being the more specific and thus stronger.
type overlay struct {
	global      EndpointTuning
	perEndpoint map[string]EndpointTuning
}

func (o *overlay) endpoint(name string) EndpointTuning {
	if o.perEndpoint == nil {
		o.perEndpoint = map[string]EndpointTuning{}
	}
	return o.perEndpoint[name]
}

func (o *overlay) setEndpoint(name string, t EndpointTuning) {
	if o.perEndpoint == nil {
		o.perEndpoint = map[string]EndpointTuning{}
	}
	o.perEndpoint[name] = t
}

// tuningField names the knobs that can be overridden from the environment and
// the command line. The env suffixes are matched longest-first so that
// CR_GATEKEEPER_ENDPOINT_<NAME>_MAX_BUNDLE_AGE splits correctly even when the
// endpoint name itself contains underscore-mapped dashes.
type tuningField struct {
	// yaml is the field's name in the config file, which is also how
	// validation problems are keyed.
	yaml string
	// env is the CR_GATEKEEPER_* suffix, flag the command-line name.
	env  string
	flag string
	set  func(*EndpointTuning, string) error
}

var tuningFields = []tuningField{
	{"reattestInterval", "REATTEST_INTERVAL", "reattest-interval", func(t *EndpointTuning, v string) error { return setDuration(&t.ReattestInterval, v) }},
	{"verdictCacheTtl", "VERDICT_CACHE_TTL", "verdict-cache-ttl", func(t *EndpointTuning, v string) error { return setDuration(&t.VerdictCacheTTL, v) }},
	{"maxBundleAge", "MAX_BUNDLE_AGE", "max-bundle-age", func(t *EndpointTuning, v string) error { return setDuration(&t.MaxBundleAge, v) }},
	{"initialTimeout", "INITIAL_TIMEOUT", "initial-timeout", func(t *EndpointTuning, v string) error { return setDuration(&t.InitialTimeout, v) }},
	{"failMode", "FAIL_MODE", "fail-mode", func(t *EndpointTuning, v string) error { t.FailMode = v; return nil }},
}

// envVarName renders the variable a tuning field came from. An empty endpoint
// means the global form.
func envVarName(endpoint string) namer {
	return func(field string) string {
		suffix := field
		for _, f := range tuningFields {
			if f.yaml == field {
				suffix = f.env
				break
			}
		}
		if endpoint == "" {
			return "$" + envPrefix + suffix
		}
		return "$" + envPrefix + "ENDPOINT_" + strings.ToUpper(strings.ReplaceAll(endpoint, "-", "_")) + "_" + suffix
	}
}

// flagName renders the command-line flag a tuning field came from.
func flagName(field string) string {
	for _, f := range tuningFields {
		if f.yaml == field {
			return "-" + f.flag
		}
	}
	return "-" + field
}

// endpointField names the non-tuning endpoint attributes reachable from the
// environment.
var endpointFields = []string{"LISTEN", "UPSTREAM", "TRUSTED_EVIDENCE"}

func setDuration(target **Duration, raw string) error {
	d, err := ParseDuration(raw)
	if err != nil {
		return err
	}
	*target = &d
	return nil
}

func parseEnviron(environ []string) map[string]string {
	out := make(map[string]string, len(environ))
	for _, kv := range environ {
		if k, v, ok := strings.Cut(kv, "="); ok {
			out[k] = v
		}
	}
	return out
}

// applyEnv folds CR_GATEKEEPER_* variables onto the file layer.
//
// Recognised names:
//
//	CR_GATEKEEPER_CONFIG                        config file path (consumed by ResolvePath)
//	CR_GATEKEEPER_LOG_LEVEL|LOG_FORMAT          logger
//	CR_GATEKEEPER_METRICS_LISTEN                metrics listener ("" disables it)
//	CR_GATEKEEPER_FAIL_MODE                     every endpoint
//	CR_GATEKEEPER_REATTEST_INTERVAL             every endpoint
//	CR_GATEKEEPER_VERDICT_CACHE_TTL             every endpoint
//	CR_GATEKEEPER_MAX_BUNDLE_AGE                every endpoint
//	CR_GATEKEEPER_INITIAL_TIMEOUT               every endpoint
//	CR_GATEKEEPER_ENDPOINT_<NAME>_LISTEN        one endpoint (<NAME> upper-cased, - → _)
//	CR_GATEKEEPER_ENDPOINT_<NAME>_UPSTREAM
//	CR_GATEKEEPER_ENDPOINT_<NAME>_TRUSTED_EVIDENCE   comma-separated pins, replacing the list
//	CR_GATEKEEPER_ENDPOINT_<NAME>_FAIL_MODE / _REATTEST_INTERVAL / _VERDICT_CACHE_TTL /
//	CR_GATEKEEPER_ENDPOINT_<NAME>_MAX_BUNDLE_AGE / _INITIAL_TIMEOUT
//
// An unknown CR_GATEKEEPER_* name is an error rather than a no-op: a typo in a
// deployment unit must not silently leave the old value in place.
func (c *Config) applyEnv(env map[string]string) error {
	keys := make([]string, 0, len(env))
	for k := range env {
		if strings.HasPrefix(k, envPrefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	for _, key := range keys {
		suffix := strings.TrimPrefix(key, envPrefix)
		value := env[key]
		if suffix == "CONFIG" {
			continue // resolved before loading
		}
		if strings.HasPrefix(suffix, "ENDPOINT_") {
			if err := c.applyEndpointEnv(key, strings.TrimPrefix(suffix, "ENDPOINT_"), value); err != nil {
				return err
			}
			continue
		}
		if err := c.applyGlobalEnv(key, suffix, value); err != nil {
			return err
		}
	}
	return nil
}

func (c *Config) applyGlobalEnv(key, suffix, value string) error {
	switch suffix {
	case "LOG_LEVEL":
		c.Log.Level = value
		return nil
	case "LOG_FORMAT":
		c.Log.Format = value
		return nil
	case "METRICS_LISTEN":
		c.setMetricsListen(value)
		return nil
	}
	for _, f := range tuningFields {
		if f.env != suffix {
			continue
		}
		t := c.envOverlay.global
		if err := f.set(&t, value); err != nil {
			return fmt.Errorf("%s: %w", key, err)
		}
		c.envOverlay.global = t
		return nil
	}
	return fmt.Errorf("%s: unknown gatekeeper environment override", key)
}

func (c *Config) applyEndpointEnv(key, rest, value string) error {
	for _, f := range tuningFields {
		name, ok := splitEndpointKey(rest, f.env)
		if !ok {
			continue
		}
		idx, err := c.endpointIndex(key, name)
		if err != nil {
			return err
		}
		t := c.envOverlay.endpoint(c.Endpoints[idx].Name)
		if err := f.set(&t, value); err != nil {
			return fmt.Errorf("%s: %w", key, err)
		}
		c.envOverlay.setEndpoint(c.Endpoints[idx].Name, t)
		return nil
	}

	for _, field := range endpointFields {
		name, ok := splitEndpointKey(rest, field)
		if !ok {
			continue
		}
		idx, err := c.endpointIndex(key, name)
		if err != nil {
			return err
		}
		switch field {
		case "LISTEN":
			c.Endpoints[idx].Listen = value
		case "UPSTREAM":
			c.Endpoints[idx].Upstream = value
		case "TRUSTED_EVIDENCE":
			c.Endpoints[idx].TrustedEvidence = splitList(value)
		}
		return nil
	}
	return fmt.Errorf("%s: unknown gatekeeper environment override", key)
}

// splitEndpointKey peels a known field suffix off `<NAME>_<FIELD>` and turns the
// remainder back into a config endpoint name.
func splitEndpointKey(rest, field string) (string, bool) {
	trimmed, ok := strings.CutSuffix(rest, "_"+field)
	if !ok || trimmed == "" {
		return "", false
	}
	return strings.ToLower(strings.ReplaceAll(trimmed, "_", "-")), true
}

func (c *Config) endpointIndex(key, name string) (int, error) {
	for i, ep := range c.Endpoints {
		if ep.Name == name {
			return i, nil
		}
	}
	return 0, fmt.Errorf("%s: no endpoint named %q in %s", key, name, displayPath(c.Path))
}

func (c *Config) setMetricsListen(value string) {
	if value == "" {
		c.Metrics = nil
		return
	}
	c.Metrics = &Metrics{Listen: value}
}

func splitList(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// applyOverrides folds the command-line layer on top of everything else.
func (c *Config) applyOverrides(o Overrides) error {
	if o.LogLevel != "" {
		c.Log.Level = o.LogLevel
	}
	if o.LogFormat != "" {
		c.Log.Format = o.LogFormat
	}
	if o.MetricsListen != "" {
		c.setMetricsListen(o.MetricsListen)
	}
	t := c.flagOverlay.global
	if o.FailMode != "" {
		t.FailMode = o.FailMode
	}
	byYAML := map[string]string{
		"reattestInterval": o.ReattestInterval,
		"verdictCacheTtl":  o.VerdictCacheTTL,
		"maxBundleAge":     o.MaxBundleAge,
		"initialTimeout":   o.InitialTimeout,
	}
	for _, f := range tuningFields {
		value := byYAML[f.yaml]
		if value == "" {
			continue
		}
		if err := f.set(&t, value); err != nil {
			return fmt.Errorf("-%s: %w", f.flag, err)
		}
	}
	c.flagOverlay.global = t
	return nil
}
