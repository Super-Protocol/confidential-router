package config

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// ErrNotFound is returned by Load when no config file exists at the resolved
// path. Callers turn it into "run `gatekeeper init` first".
var ErrNotFound = errors.New("no gatekeeper config file")

// maxConfigSize caps how much of a config file is read. A gatekeeper config is
// a few kilobytes; anything larger is a mistake or an attempt to exhaust memory.
const maxConfigSize = 4 << 20 // 4 MiB

// Options controls one Load.
type Options struct {
	// Path is the config file to read. Empty means: CR_GATEKEEPER_CONFIG,
	// then GATEKEEPER_CONFIG, then DefaultPath().
	Path string
	// Environ overrides the process environment; nil means os.Environ().
	Environ []string
	// Overrides is the command-line layer, the highest-precedence one.
	Overrides Overrides
	// Editable validates with [Config.ValidateEditable] instead of
	// [Config.Validate]: every value is still checked for being well formed,
	// but a file that is not *finished* — no trusted roots yet, an endpoint
	// without pins yet — still loads.
	//
	// It exists for the commands that inspect rather than serve: `verify`,
	// `endpoint discover`, `endpoint trust add --from-upstream`, `policy list`
	// and `policy test`. Those are how a config gets finished and checked, so
	// requiring a finished config to run them makes the sequence `gatekeeper
	// init` prints impossible to follow. Nothing that opens a listener loads
	// this way: only `run` — and the SIGHUP reload behind it — insists the file
	// is complete, because only `run` can admit traffic.
	Editable bool
}

// DefaultPath is where the gatekeeper looks when nothing says otherwise:
// $XDG_CONFIG_HOME/confidential-gatekeeper/config.yaml, falling back to
// ~/.config (ADR-003 §8).
func DefaultPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return filepath.Join(".config", "confidential-gatekeeper", "config.yaml")
	}
	return filepath.Join(dir, "confidential-gatekeeper", "config.yaml")
}

// ResolvePath applies the config-path precedence: flag, then CR_GATEKEEPER_CONFIG,
// then GATEKEEPER_CONFIG (the name ADR-003 documents), then DefaultPath.
func ResolvePath(flagValue string, environ []string) string {
	path, _ := ResolvePathSource(flagValue, environ)
	return path
}

// ResolvePathSource is [ResolvePath] plus the layer the path came from, spelled
// the way the user would recognise it (`--config`, `$CR_GATEKEEPER_CONFIG`,
// `$GATEKEEPER_CONFIG`, `default`). `gatekeeper config path` prints it: "which
// file am I editing, and why that one" is otherwise guesswork across three
// environment layers.
func ResolvePathSource(flagValue string, environ []string) (path, source string) {
	if flagValue != "" {
		return flagValue, "--config"
	}
	env := parseEnviron(environ)
	if v := env[envPrefix+"CONFIG"]; v != "" {
		return v, "$" + envPrefix + "CONFIG"
	}
	if v := env["GATEKEEPER_CONFIG"]; v != "" {
		return v, "$GATEKEEPER_CONFIG"
	}
	return DefaultPath(), "default"
}

// Load reads and validates the configuration, applying the four precedence
// layers: built-in defaults, the file, CR_GATEKEEPER_* environment overrides
// and finally command-line overrides.
//
// A returned *ValidationError lists every problem at once.
func Load(opts Options) (*Config, error) {
	environ := opts.Environ
	if environ == nil {
		environ = os.Environ()
	}
	path := ResolvePath(firstNonEmpty(opts.Overrides.ConfigPath, opts.Path), environ)

	cfg, err := readFile(path)
	if err != nil {
		return nil, err
	}
	if err := cfg.applyEnv(parseEnviron(environ)); err != nil {
		return nil, err
	}
	if err := cfg.applyOverrides(opts.Overrides); err != nil {
		return nil, err
	}
	validate := cfg.Validate
	if opts.Editable {
		validate = cfg.ValidateEditable
	}
	if err := validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Parse decodes a config document that is already in memory. It applies no
// environment or flag layer and does not validate — [Config.Validate] is the
// caller's next call. `path` is recorded so relative pemFile/policy paths
// resolve correctly; it need not exist.
func Parse(r io.Reader, path string) (*Config, error) {
	cfg := &Config{Path: path}
	dec := yaml.NewDecoder(io.LimitReader(r, maxConfigSize))
	// Unknown keys are an error: the schema is `additionalProperties: false`,
	// and a silently ignored `trustedEvidance` typo would mean an endpoint
	// running with the wrong pins.
	dec.KnownFields(true)
	if err := dec.Decode(cfg); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("%s: file is empty", displayPath(path))
		}
		return nil, fmt.Errorf("%s: %w", displayPath(path), err)
	}
	return cfg, nil
}

func readFile(path string) (*Config, error) {
	f, err := os.Open(path) //nolint:gosec // the path is operator-supplied by design
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w at %s", ErrNotFound, path)
		}
		return nil, err
	}
	defer f.Close() //nolint:errcheck // read-only handle

	cfg, err := Parse(f, path)
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

func displayPath(path string) string {
	if path == "" {
		return "config"
	}
	return path
}

func firstNonEmpty(first, second string) string {
	if first != "" {
		return first
	}
	return second
}
