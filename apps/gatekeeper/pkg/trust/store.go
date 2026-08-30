package trust

import (
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"sync"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// ErrReadOnly is returned by the mutating methods of a store that was built
// from an in-memory config rather than opened from a file.
var ErrReadOnly = errors.New("trust store is read-only (no config file is attached)")

// Root is one entry of the global trusted-root list, with its certificate
// parsed and fingerprinted.
type Root struct {
	Name string
	// Fingerprint is the SHA-256 of the DER — how a bundle's chain terminus is
	// matched against this root.
	Fingerprint Digest
	Certificate *x509.Certificate
}

// Pin is one accepted evidenceDigest of an endpoint. Raw is how it is spelled
// in the config file, which is what `trust remove` has to delete even when the
// user names the pin in its canonical form.
type Pin struct {
	Digest Digest
	Raw    string
}

// Endpoint is the trust state of one proxied upstream.
type Endpoint struct {
	Name     string
	Listen   string
	Upstream string
	Hostname string
	Port     int
	FailMode string
	Pins     []Pin
}

// IsPinned reports whether the endpoint accepts the given evidence digest.
func (e Endpoint) IsPinned(d Digest) bool {
	for _, p := range e.Pins {
		if p.Digest.Equal(d) {
			return true
		}
	}
	return false
}

// Digests returns the pinned digests in canonical form.
func (e Endpoint) Digests() []Digest {
	out := make([]Digest, 0, len(e.Pins))
	for _, p := range e.Pins {
		out = append(out, p.Digest)
	}
	return out
}

// state is the resolved trust state. It is built whole and swapped in, so a
// failed edit can never leave the store half-updated.
type state struct {
	roots     []Root
	endpoints []Endpoint
	pool      *x509.CertPool
}

// Store is the resolved trust state. It is safe for concurrent use: the data
// plane reads it on every verification while the CLI may be editing it.
type Store struct {
	mu    sync.RWMutex
	doc   *config.Document
	state *state
}

// New builds a read-only store from an already loaded config. Certificates are
// parsed here, so a malformed `pem`/`pemFile` fails at startup rather than on
// the first request.
func New(cfg *config.Config) (*Store, error) {
	resolved, err := buildState(cfg)
	if err != nil {
		return nil, err
	}
	return &Store{state: resolved}, nil
}

// Open reads the config file and keeps it attached, so Add/Remove persist.
func Open(path string) (*Store, error) {
	doc, err := config.OpenDocument(path)
	if err != nil {
		return nil, err
	}
	cfg, err := doc.Config()
	if err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	resolved, err := buildState(cfg)
	if err != nil {
		return nil, err
	}
	return &Store{doc: doc, state: resolved}, nil
}

func buildState(cfg *config.Config) (*state, error) {
	roots := make([]Root, 0, len(cfg.TrustedRoots))
	pool := x509.NewCertPool()
	for _, r := range cfg.TrustedRoots {
		block, err := cfg.PEM(r)
		if err != nil {
			return nil, fmt.Errorf("trusted root %q: %w", r.Name, err)
		}
		cert, err := parseCertificate(block)
		if err != nil {
			return nil, fmt.Errorf("trusted root %q: %w", r.Name, err)
		}
		roots = append(roots, Root{Name: r.Name, Fingerprint: Sum(cert.Raw), Certificate: cert})
		pool.AddCert(cert)
	}

	endpoints := make([]Endpoint, 0, len(cfg.Endpoints))
	for _, ep := range cfg.Endpoints {
		host, port, err := splitUpstream(ep.Upstream)
		if err != nil {
			return nil, fmt.Errorf("endpoint %q: %w", ep.Name, err)
		}
		pins := make([]Pin, 0, len(ep.TrustedEvidence))
		for _, raw := range ep.TrustedEvidence {
			d, err := ParseDigest(raw)
			if err != nil {
				return nil, fmt.Errorf("endpoint %q: trustedEvidence: %w", ep.Name, err)
			}
			pins = append(pins, Pin{Digest: d, Raw: raw})
		}
		endpoints = append(endpoints, Endpoint{
			Name:     ep.Name,
			Listen:   ep.Listen,
			Upstream: ep.Upstream,
			Hostname: host,
			Port:     port,
			FailMode: cfg.Tuning(ep).FailMode,
			Pins:     pins,
		})
	}

	return &state{roots: roots, endpoints: endpoints, pool: pool}, nil
}

// Roots lists the trusted roots.
func (s *Store) Roots() []Root {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Root(nil), s.state.roots...)
}

// RootByFingerprint finds the trusted root a chain terminated in.
func (s *Store) RootByFingerprint(fp Digest) (Root, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.state.roots {
		if r.Fingerprint.Equal(fp) {
			return r, true
		}
	}
	return Root{}, false
}

// CertPool is the verification pool for chain building.
func (s *Store) CertPool() *x509.CertPool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state.pool.Clone()
}

// Endpoints lists every configured endpoint.
func (s *Store) Endpoints() []Endpoint {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Endpoint(nil), s.state.endpoints...)
}

// Endpoint returns one endpoint by name.
func (s *Store) Endpoint(name string) (Endpoint, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, ep := range s.state.endpoints {
		if ep.Name == name {
			return ep, true
		}
	}
	return Endpoint{}, false
}

// IsPinned reports whether an endpoint exists and accepts the digest.
func (s *Store) IsPinned(endpoint string, d Digest) bool {
	ep, ok := s.Endpoint(endpoint)
	return ok && ep.IsPinned(d)
}

// AddRoot appends a trusted root and persists it. It reports false when a root
// with the same fingerprint is already trusted under any name.
func (s *Store) AddRoot(name string, pemBytes []byte) (bool, error) {
	cert, err := parseCertificate(pemBytes)
	if err != nil {
		return false, err
	}
	fp := Sum(cert.Raw)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.doc == nil {
		return false, ErrReadOnly
	}
	for _, r := range s.state.roots {
		if r.Fingerprint.Equal(fp) {
			return false, nil
		}
	}
	if err := s.doc.AddTrustedRoot(name, string(pemBytes)); err != nil {
		return false, err
	}
	if err := s.persist(); err != nil {
		return false, err
	}
	return true, nil
}

// RemoveRoot drops a trusted root by name.
func (s *Store) RemoveRoot(name string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.doc == nil {
		return false, ErrReadOnly
	}
	removed, err := s.doc.RemoveTrustedRoot(name)
	if err != nil || !removed {
		return false, err
	}
	if err := s.persist(); err != nil {
		return false, err
	}
	return true, nil
}

// AddPin pins another evidenceDigest on an endpoint, writing the canonical
// form. It reports false when the digest is already pinned, whatever spelling
// the file uses for it.
func (s *Store) AddPin(endpoint string, d Digest) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.doc == nil {
		return false, ErrReadOnly
	}
	ep, ok := s.endpointLocked(endpoint)
	if !ok {
		return false, fmt.Errorf("no endpoint named %q", endpoint)
	}
	if ep.IsPinned(d) {
		return false, nil
	}
	if _, err := s.doc.AddTrustedEvidence(endpoint, d.String()); err != nil {
		return false, err
	}
	if err := s.persist(); err != nil {
		return false, err
	}
	return true, nil
}

// RemovePin unpins an evidenceDigest, matching on the normalised value so that
// a pin written in hex can be removed by its canonical name and vice versa.
func (s *Store) RemovePin(endpoint string, d Digest) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.doc == nil {
		return false, ErrReadOnly
	}
	ep, ok := s.endpointLocked(endpoint)
	if !ok {
		return false, fmt.Errorf("no endpoint named %q", endpoint)
	}
	var raws []string
	for _, p := range ep.Pins {
		if p.Digest.Equal(d) {
			raws = append(raws, p.Raw)
		}
	}
	if len(raws) == 0 {
		return false, nil
	}
	// The schema requires at least one pin, so emptying the list would produce
	// a config the gatekeeper refuses to start with. Say so here instead.
	if len(raws) == len(ep.Pins) {
		return false, fmt.Errorf(
			"endpoint %q would be left without a pinned evidenceDigest; add the replacement first", endpoint)
	}
	if _, err := s.doc.RemoveTrustedEvidence(endpoint, raws); err != nil {
		return false, err
	}
	if err := s.persist(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) endpointLocked(name string) (Endpoint, bool) {
	for _, ep := range s.state.endpoints {
		if ep.Name == name {
			return ep, true
		}
	}
	return Endpoint{}, false
}

// persist resolves the edited document, writes it, and swaps the in-memory view
// in. The resolve step runs *before* the write: an edit that produces a state
// the store cannot build — an unparseable certificate, an upstream that is no
// longer a URL — must not reach the file. On any failure the document is
// re-read from disk so a rejected edit cannot linger and be written by the next
// successful save.
func (s *Store) persist() error {
	resolved, err := s.resolve()
	if err != nil {
		s.reload()
		return err
	}
	if err := s.doc.Save(); err != nil {
		s.reload()
		return err
	}
	s.state = resolved
	return nil
}

func (s *Store) resolve() (*state, error) {
	cfg, err := s.doc.Config()
	if err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return buildState(cfg)
}

func (s *Store) reload() {
	doc, err := config.OpenDocument(s.doc.Path())
	if err != nil {
		return
	}
	previous := s.doc
	s.doc = doc
	resolved, err := s.resolve()
	if err != nil {
		s.doc = previous
		return
	}
	s.state = resolved
}

// Snapshot is the trust state in the shape the generated Rego module needs:
// sorted, string-only, free of certificates.
type Snapshot struct {
	Roots     []RootSnapshot     `json:"roots"`
	Endpoints []EndpointSnapshot `json:"endpoints"`
}

// RootSnapshot is one trusted root in the generated module.
type RootSnapshot struct {
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
}

// EndpointSnapshot is one endpoint in the generated module.
type EndpointSnapshot struct {
	Name       string   `json:"name"`
	Hostname   string   `json:"hostname"`
	FailMode   string   `json:"fail_mode"`
	Digests    []string `json:"evidence_digests"`
	DigestsHex []string `json:"evidence_digests_hex"`
}

// Snapshot renders the trust state deterministically: names sorted, digests
// sorted and de-duplicated. Determinism is what makes [Store.Hash] a stable
// cache key and the generated module diffable.
func (s *Store) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	snap := Snapshot{
		Roots:     make([]RootSnapshot, 0, len(s.state.roots)),
		Endpoints: make([]EndpointSnapshot, 0, len(s.state.endpoints)),
	}
	for _, r := range s.state.roots {
		snap.Roots = append(snap.Roots, RootSnapshot{Name: r.Name, Fingerprint: r.Fingerprint.String()})
	}
	sort.Slice(snap.Roots, func(i, j int) bool { return snap.Roots[i].Name < snap.Roots[j].Name })

	for _, ep := range s.state.endpoints {
		seen := map[Digest]struct{}{}
		digests := make([]string, 0, len(ep.Pins))
		hexes := make([]string, 0, len(ep.Pins))
		for _, p := range ep.Pins {
			if _, dup := seen[p.Digest]; dup {
				continue
			}
			seen[p.Digest] = struct{}{}
			digests = append(digests, p.Digest.String())
			hexes = append(hexes, p.Digest.Hex())
		}
		sort.Strings(digests)
		sort.Strings(hexes)
		snap.Endpoints = append(snap.Endpoints, EndpointSnapshot{
			Name:       ep.Name,
			Hostname:   ep.Hostname,
			FailMode:   ep.FailMode,
			Digests:    digests,
			DigestsHex: hexes,
		})
	}
	sort.Slice(snap.Endpoints, func(i, j int) bool { return snap.Endpoints[i].Name < snap.Endpoints[j].Name })
	return snap
}

// Hash fingerprints the trust state. It goes into the verdict cache key so that
// editing a pin or a root takes effect on the next check instead of waiting out
// the TTL (ADR-003 §7).
func (s *Store) Hash() Digest {
	encoded, err := json.Marshal(s.Snapshot())
	if err != nil {
		// Snapshot contains only strings and slices of strings.
		panic(fmt.Sprintf("trust: snapshot is not encodable: %v", err))
	}
	return Sum(encoded)
}

func parseCertificate(pemBytes []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	if block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("expected a CERTIFICATE PEM block, got %q", block.Type)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("not a valid X.509 certificate: %w", err)
	}
	return cert, nil
}

// splitUpstream extracts the hostname and port the evidence bundle is fetched
// from and bound to.
func splitUpstream(raw string) (string, int, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", 0, fmt.Errorf("upstream %q is not a URL: %w", raw, err)
	}
	if u.Scheme != "https" {
		return "", 0, fmt.Errorf("upstream %q must use https", raw)
	}
	host := u.Hostname()
	if host == "" {
		return "", 0, fmt.Errorf("upstream %q has no hostname", raw)
	}
	port := 443
	if p := u.Port(); p != "" {
		port, err = strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 {
			return "", 0, fmt.Errorf("upstream %q has an invalid port", raw)
		}
	}
	return host, port, nil
}

// FingerprintPEM parses a PEM certificate and returns the SHA-256 of its DER —
// the value a trusted root is matched by.
func FingerprintPEM(pemBytes []byte) (Digest, error) {
	cert, err := parseCertificate(pemBytes)
	if err != nil {
		return "", err
	}
	return Sum(cert.Raw), nil
}
