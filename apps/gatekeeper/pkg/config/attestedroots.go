package config

import "time"

// Network-type policies for an attested root (ADR-003 §2a).
const (
	// NetworkTypeAny accepts a root whatever network it declares, and surfaces
	// the declaration. It is the default because the live Swarm Cloud root
	// declares `untrusted` — the value belongs to the platform's own trusted/
	// untrusted *network* split, not to a judgement about the CA — and a
	// gatekeeper that silently rejected it would look broken rather than strict.
	NetworkTypeAny = "any"
	// NetworkTypeTrusted additionally requires the root to declare `trusted`.
	NetworkTypeTrusted = "trusted"
)

// DefaultAttestedRootsCacheTTL is how long an attested-root verdict is reused.
// Deriving one costs a firmware download and a registry round trip, and the
// answer only changes when the registry does.
const DefaultAttestedRootsCacheTTL = 10 * time.Minute

// AttestedRoots configures the gatekeeper's second trust anchor: accepting a
// certificate authority because its own TEE evidence proves it is a Super Swarm
// root, rather than because the user listed it.
//
// It is on by default. Without it, using a Swarm cloud starts with a manual
// `gatekeeper trust roots add` of a certificate the user has no way to check —
// which is trust-on-first-use with extra steps. With it, the same certificate
// is accepted only when hardware and a signature Super Protocol published both
// vouch for it, and the manual list stays available for everything else.
type AttestedRoots struct {
	// Enabled turns the anchor off when explicitly set to false. Nil means the
	// default, which is on.
	Enabled *bool `yaml:"enabled,omitempty"`
	// RegistryBaseURL overrides where signed measurements are looked up. The
	// signing key is pinned in the binary either way, so this only moves the
	// mirror, never the trust.
	RegistryBaseURL string `yaml:"registryBaseUrl,omitempty"`
	// CacheTTL overrides how long a verdict about one root is reused.
	CacheTTL *Duration `yaml:"cacheTtl,omitempty"`
	// RequireNetworkType is `any` (default) or `trusted`.
	RequireNetworkType string `yaml:"requireNetworkType,omitempty"`
	// CheckRevocations additionally consults the CPU vendor's CRLs. It costs a
	// network round trip per root and is reported separately, so it is opt-in.
	CheckRevocations bool `yaml:"checkRevocations,omitempty"`
}

// AttestedRootsEnabled reports whether the attested-root anchor is active.
func (c *Config) AttestedRootsEnabled() bool {
	if c.AttestedRoots == nil || c.AttestedRoots.Enabled == nil {
		return true
	}
	return *c.AttestedRoots.Enabled
}

// AttestedRootsCacheTTL resolves the verdict cache lifetime.
func (c *Config) AttestedRootsCacheTTL() time.Duration {
	if c.AttestedRoots == nil || c.AttestedRoots.CacheTTL == nil {
		return DefaultAttestedRootsCacheTTL
	}
	return c.AttestedRoots.CacheTTL.Std()
}

// AttestedRootsRegistryBaseURL resolves the registry mirror, empty for the
// built-in one.
func (c *Config) AttestedRootsRegistryBaseURL() string {
	if c.AttestedRoots == nil {
		return ""
	}
	return c.AttestedRoots.RegistryBaseURL
}

// AttestedRootsRequireNetworkType resolves the network-type rule.
func (c *Config) AttestedRootsRequireNetworkType() string {
	if c.AttestedRoots == nil || c.AttestedRoots.RequireNetworkType == "" {
		return NetworkTypeAny
	}
	return c.AttestedRoots.RequireNetworkType
}

// AttestedRootsCheckRevocations reports whether vendor CRLs are consulted.
func (c *Config) AttestedRootsCheckRevocations() bool {
	return c.AttestedRoots != nil && c.AttestedRoots.CheckRevocations
}
