package config

import "flag"

// RegisterFlags registers the config-override flags on fs and returns a getter
// that must be called after fs.Parse.
//
// The getter reports only flags the user actually passed: a flag left at its
// zero value must not shadow a value from the file, which is what makes the
// "file → env → flags" precedence work with the standard flag package (it has
// no "was this set?" query of its own).
func RegisterFlags(fs *flag.FlagSet) func() Overrides {
	var parsed Overrides
	bindings := []struct {
		name  string
		usage string
		field *string
	}{
		{"config", "path to config.yaml (default: $CR_GATEKEEPER_CONFIG, else " + DefaultPath() + ")", &parsed.ConfigPath},
		{"log-level", "log level: debug, info, warn, error", &parsed.LogLevel},
		{"log-format", "log format: text or json", &parsed.LogFormat},
		{"metrics-listen", "host:port for the Prometheus endpoint", &parsed.MetricsListen},
		{"fail-mode", "behaviour without a valid verdict: closed or open", &parsed.FailMode},
		{"reattest-interval", "background re-verification period, e.g. 5m", &parsed.ReattestInterval},
		{"verdict-cache-ttl", "how long an on-demand re-check reuses a verdict, e.g. 60s", &parsed.VerdictCacheTTL},
		{"max-bundle-age", "reject bundles older than this, e.g. 24h", &parsed.MaxBundleAge},
		{"initial-timeout", "how long the first request waits for a verdict, e.g. 15s", &parsed.InitialTimeout},
	}
	for _, b := range bindings {
		fs.StringVar(b.field, b.name, "", b.usage)
	}

	return func() Overrides {
		passed := map[string]bool{}
		fs.Visit(func(f *flag.Flag) { passed[f.Name] = true })

		var out Overrides
		outFields := []*string{
			&out.ConfigPath, &out.LogLevel, &out.LogFormat, &out.MetricsListen, &out.FailMode,
			&out.ReattestInterval, &out.VerdictCacheTTL, &out.MaxBundleAge, &out.InitialTimeout,
		}
		for i, b := range bindings {
			if passed[b.name] {
				*outFields[i] = *b.field
			}
		}
		return out
	}
}
