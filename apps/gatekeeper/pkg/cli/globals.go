package cli

import (
	"context"
	"errors"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/verifier"
)

// globals holds the persistent flags and turns them into the two things every
// command needs: a loaded config, or an editable trust store.
type globals struct {
	env    *Env
	values map[string]*string
	// overrides is rebuilt before every command run from the flags the user
	// actually passed. A flag left alone must not shadow the file, which is
	// what `Flags().Changed` — and nothing else — can tell us.
	overrides config.Overrides
}

// persistentFlags are the config-override flags, in help order. They mirror
// pkg/config's Overrides field for field; the table is what keeps the two from
// drifting apart silently.
var persistentFlags = []struct {
	name  string
	usage string
	field func(*config.Overrides) *string
}{
	{"config", "path to config.yaml (default: $CR_GATEKEEPER_CONFIG, else " + config.DefaultPath() + ")",
		func(o *config.Overrides) *string { return &o.ConfigPath }},
	{"log-level", "log level: debug, info, warn, error",
		func(o *config.Overrides) *string { return &o.LogLevel }},
	{"log-format", "log format: text or json",
		func(o *config.Overrides) *string { return &o.LogFormat }},
	{"metrics-listen", "host:port for the Prometheus endpoint",
		func(o *config.Overrides) *string { return &o.MetricsListen }},
	{"fail-mode", "behaviour without a valid verdict: closed or open",
		func(o *config.Overrides) *string { return &o.FailMode }},
	{"reattest-interval", "background re-verification period, e.g. 5m",
		func(o *config.Overrides) *string { return &o.ReattestInterval }},
	{"verdict-cache-ttl", "how long an on-demand re-check reuses a verdict, e.g. 60s",
		func(o *config.Overrides) *string { return &o.VerdictCacheTTL }},
	{"max-bundle-age", "reject bundles older than this, e.g. 24h",
		func(o *config.Overrides) *string { return &o.MaxBundleAge }},
	{"initial-timeout", "how long the first request waits for a verdict, e.g. 15s",
		func(o *config.Overrides) *string { return &o.InitialTimeout }},
}

func (g *globals) register(fs *pflag.FlagSet) {
	g.values = make(map[string]*string, len(persistentFlags))
	for _, f := range persistentFlags {
		shorthand := ""
		if f.name == "config" {
			shorthand = "c"
		}
		g.values[f.name] = fs.StringP(f.name, shorthand, "", f.usage)
	}
}

// collect reads the flags that were actually passed into config.Overrides.
func (g *globals) collect(cmd *cobra.Command) {
	g.overrides = config.Overrides{}
	flags := cmd.Flags()
	for _, f := range persistentFlags {
		if !flags.Changed(f.name) {
			continue
		}
		*f.field(&g.overrides) = *g.values[f.name]
	}
}

// path is the config file this invocation is about.
func (g *globals) path() string {
	path, _ := g.pathSource()
	return path
}

func (g *globals) pathSource() (path, source string) {
	return config.ResolvePathSource(g.overrides.ConfigPath, g.env.environ())
}

// load reads and fully validates the config — the four precedence layers, and
// every rule including "is this runnable". It is what the commands that act on
// a whole configuration use.
func (g *globals) load() (*config.Config, error) {
	cfg, err := config.Load(config.Options{Environ: g.env.environ(), Overrides: g.overrides})
	if err != nil {
		return nil, configError(err, g.path())
	}
	return cfg, nil
}

// open returns an editable trust store over the config file. Unlike load it
// accepts an incomplete config: `trust roots add` on a freshly initialised file
// has to work, and that file has no endpoints yet.
func (g *globals) open() (*trust.Store, error) {
	store, err := trust.Open(g.path())
	if err != nil {
		return nil, configError(err, g.path())
	}
	return store, nil
}

// configError turns the two config failures a user can actually fix into
// advice, and tags both with ExitConfig.
func configError(err error, path string) error {
	var invalid *config.ValidationError
	switch {
	case errors.Is(err, config.ErrNotFound):
		return failf(ExitConfig, "no configuration at %s — run `gatekeeper init` to create one", path)
	case errors.As(err, &invalid):
		return wrap(ExitConfig, err)
	default:
		return wrap(ExitConfig, err)
	}
}

// verifier returns the verification seam: whatever the caller injected, or one
// built from the configuration.
//
// It is built per command rather than once at startup because it compiles the
// trust store and the whole policy set, and the commands that never verify
// anything should not pay for — or fail on — that.
func (g *globals) verifier(ctx context.Context) (status.Verifier, error) {
	if g.env.Verifier != nil {
		return g.env.Verifier, nil
	}
	cfg, err := g.load()
	if err != nil {
		return nil, err
	}
	built, err := verifier.New(ctx, cfg)
	if err != nil {
		return nil, wrap(ExitConfig, err)
	}
	return built, nil
}

// requireSupervisor returns the running proxy's control surface, or explains
// its absence.
func (g *globals) requireSupervisor() error {
	if g.env.Supervisor == nil {
		return failf(ExitUnavailable,
			"this build has no proxy data plane wired in, so there is nothing to report on\n"+
				"       (try `gatekeeper run --demo` to see the dashboard; see apps/gatekeeper/README.md)")
	}
	return nil
}
