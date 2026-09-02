// Package config loads, validates and rewrites the gatekeeper's YAML
// configuration.
//
// The file is the machine-readable form of ADR-003: global trusted roots,
// global user policies, and one entry per proxied endpoint carrying its own
// pinned evidenceDigest list. `schemas/gatekeeper-config.schema.json` is the
// normative schema; the types here mirror it field for field and [Validate]
// reproduces its constraints with messages that name the offending path.
//
// Values come from four layers, later ones winning:
//
//	defaults  →  config file  →  environment (CR_GATEKEEPER_*)  →  flags
//
// Editing is separate from loading: [Document] rewrites the file through the
// yaml.v3 node API so `gatekeeper trust add` keeps the user's comments and
// formatting, and saves atomically.
package config

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// unixPrefix marks an `admin.listen` value as a unix socket path.
const unixPrefix = "unix:"

// SchemaVersion is the only `version` value this build understands.
const SchemaVersion = 1

// Fail modes of an endpoint while it has no valid verdict (ADR-003 §6).
const (
	// FailClosed rejects client requests with 503 and never opens an upstream
	// connection. This is the default.
	FailClosed = "closed"
	// FailOpen proxies anyway, logs at warn and flags the client-facing
	// response. It is an explicit per-endpoint opt-in.
	FailOpen = "open"
)

// Built-in tuning defaults (ADR-003 §7); they are the bottom layer of the
// precedence chain and are also what the JSON schema documents.
const (
	DefaultReattestInterval = 5 * time.Minute
	DefaultVerdictCacheTTL  = 60 * time.Second
	DefaultMaxBundleAge     = 24 * time.Hour
	DefaultInitialTimeout   = 15 * time.Second
	DefaultLogLevel         = "info"
	DefaultLogFormat        = "text"
)

// Config is the whole configuration file.
type Config struct {
	Version      int           `yaml:"version"`
	TrustedRoots []TrustedRoot `yaml:"trustedRoots"`
	// AttestedRoots configures the second trust anchor: roots the gatekeeper
	// accepts on their own TEE evidence. Nil means the built-in defaults, which
	// have it on.
	AttestedRoots *AttestedRoots `yaml:"attestedRoots,omitempty"`
	Policies      []Policy       `yaml:"policies,omitempty"`
	Defaults      EndpointTuning `yaml:"defaults,omitempty"`
	Endpoints     []Endpoint     `yaml:"endpoints"`
	Log           Log            `yaml:"log,omitempty"`
	Metrics       *Metrics       `yaml:"metrics,omitempty"`
	Admin         *Admin         `yaml:"admin,omitempty"`
	Audit         *Audit         `yaml:"audit,omitempty"`

	// Path is the file this config was read from, empty when it was built in
	// memory. Relative `pemFile` and policy `file` paths resolve against its
	// directory.
	Path string `yaml:"-"`

	// Layers applied on top of the file by Load. They are held separately from
	// the decoded fields so that [Config.Tuning] can resolve precedence without
	// an override ever being written back into the document's own values.
	// (Rewriting the file is a different code path entirely: [Document] parses
	// the file again and never sees a Config.)
	envOverlay  overlay
	flagOverlay overlay
}

// TrustedRoot is one entry of the global "Trusted Clouds" list. Exactly one of
// PEM and PEMFile is set.
type TrustedRoot struct {
	Name    string `yaml:"name"`
	PEM     string `yaml:"pem,omitempty"`
	PEMFile string `yaml:"pemFile,omitempty"`
}

// Policy is a user Rego module, loaded for every endpoint and ANDed with the
// built-in pin policy.
type Policy struct {
	Name string `yaml:"name"`
	File string `yaml:"file"`
}

// Log configures the process logger.
type Log struct {
	Level  string `yaml:"level,omitempty"`
	Format string `yaml:"format,omitempty"`
}

// Metrics is the optional local Prometheus listener.
type Metrics struct {
	Listen string `yaml:"listen"`
}

// Admin is the optional local status API of a running gatekeeper: the surface
// `gatekeeper status` reads from another process, and the one a desktop shell
// would poll. It carries verdicts, so it is loopback- or unix-socket-only by
// construction — [Config.Validate] refuses anything else.
type Admin struct {
	// Listen is `unix:<path>` or a loopback `host:port`.
	Listen string `yaml:"listen"`
}

// Unix reports whether the admin listener is a unix socket, and returns its
// path.
func (a Admin) Unix() (path string, ok bool) {
	return strings.TrimPrefix(a.Listen, unixPrefix), strings.HasPrefix(a.Listen, unixPrefix)
}

// Audit is the optional audit log: one JSON object per line, appended, holding
// every verdict and every blocked request. Request and response bodies are
// never written to it.
type Audit struct {
	File string `yaml:"file"`
}

// EndpointTuning holds the knobs that may be set globally under `defaults` and
// overridden per endpoint. Every field is optional: a nil/empty field means
// "inherit", which is what makes the three-level precedence
// (built-in → defaults → endpoint) expressible.
type EndpointTuning struct {
	FailMode         string    `yaml:"failMode,omitempty"`
	ReattestInterval *Duration `yaml:"reattestInterval,omitempty"`
	VerdictCacheTTL  *Duration `yaml:"verdictCacheTtl,omitempty"`
	MaxBundleAge     *Duration `yaml:"maxBundleAge,omitempty"`
	InitialTimeout   *Duration `yaml:"initialTimeout,omitempty"`
}

// Endpoint is one local listener verifying and proxying to one router hostname.
type Endpoint struct {
	Name     string `yaml:"name"`
	Listen   string `yaml:"listen"`
	Upstream string `yaml:"upstream"`
	// TrustedEvidence holds the pinned evidenceDigest values accepted for this
	// endpoint, as written in the file. [Config.Validate] checks the format;
	// the trust store normalises them to canonical `sha256/<base64url>`.
	//
	// An endpoint with no pins is a legal *file* — it is what `endpoint add`
	// writes and what `endpoint trust add --from-upstream` then fills in — but
	// it can never admit traffic, which is what [Config.Validate] reports and
	// [Config.ValidateEditable] tolerates.
	TrustedEvidence DigestList     `yaml:"trustedEvidence"`
	Tuning          EndpointTuning `yaml:",inline"`
}

// Tuning is a fully resolved set of endpoint knobs — no inheritance left.
type Tuning struct {
	FailMode         string
	ReattestInterval time.Duration
	VerdictCacheTTL  time.Duration
	MaxBundleAge     time.Duration
	InitialTimeout   time.Duration
}

// builtinTuning is the bottom precedence layer.
func builtinTuning() Tuning {
	return Tuning{
		FailMode:         FailClosed,
		ReattestInterval: DefaultReattestInterval,
		VerdictCacheTTL:  DefaultVerdictCacheTTL,
		MaxBundleAge:     DefaultMaxBundleAge,
		InitialTimeout:   DefaultInitialTimeout,
	}
}

// apply overlays every field the layer actually sets.
func (t Tuning) apply(layer EndpointTuning) Tuning {
	if layer.FailMode != "" {
		t.FailMode = layer.FailMode
	}
	if layer.ReattestInterval != nil {
		t.ReattestInterval = layer.ReattestInterval.Std()
	}
	if layer.VerdictCacheTTL != nil {
		t.VerdictCacheTTL = layer.VerdictCacheTTL.Std()
	}
	if layer.MaxBundleAge != nil {
		t.MaxBundleAge = layer.MaxBundleAge.Std()
	}
	if layer.InitialTimeout != nil {
		t.InitialTimeout = layer.InitialTimeout.Std()
	}
	return t
}

// Tuning resolves the effective knobs of one endpoint. Layers, weakest first:
//
//	built-in defaults → `defaults:` → the endpoint itself →
//	CR_GATEKEEPER_* (global, then per-endpoint) → command-line flags
func (c *Config) Tuning(ep Endpoint) Tuning {
	return builtinTuning().
		apply(c.Defaults).
		apply(ep.Tuning).
		apply(c.envOverlay.global).
		apply(c.envOverlay.perEndpoint[ep.Name]).
		apply(c.flagOverlay.global)
}

// Endpoint returns the endpoint with the given name.
func (c *Config) Endpoint(name string) (Endpoint, bool) {
	for _, ep := range c.Endpoints {
		if ep.Name == name {
			return ep, true
		}
	}
	return Endpoint{}, false
}

// LogLevel returns the configured level or the default.
func (c *Config) LogLevel() string {
	if c.Log.Level == "" {
		return DefaultLogLevel
	}
	return c.Log.Level
}

// LogFormat returns the configured format or the default.
func (c *Config) LogFormat() string {
	if c.Log.Format == "" {
		return DefaultLogFormat
	}
	return c.Log.Format
}

// Resolve turns a path written in the config file into an absolute one.
// Relative paths are anchored at the config file's directory (schema:
// "relative to the config file"), never at the process working directory —
// the gatekeeper is normally started from somewhere else entirely.
func (c *Config) Resolve(path string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}
	if c.Path == "" {
		abs, err := filepath.Abs(path)
		if err != nil {
			return path
		}
		return abs
	}
	return filepath.Join(filepath.Dir(c.Path), path)
}

// PEM returns the root certificate in PEM form, reading `pemFile` when the
// certificate is not inline.
func (c *Config) PEM(root TrustedRoot) ([]byte, error) {
	if root.PEM != "" {
		return []byte(root.PEM), nil
	}
	return os.ReadFile(c.Resolve(root.PEMFile))
}
