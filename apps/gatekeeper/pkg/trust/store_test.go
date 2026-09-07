package trust_test

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// pinA and pinB are stable, valid evidenceDigest values.
var (
	pinA = trust.Sum([]byte("snapshot A"))
	pinB = trust.Sum([]byte("snapshot B"))
)

// writeStoreConfig renders a config with a real root certificate and returns
// its path.
func writeStoreConfig(t *testing.T, rootPEM string, endpoints string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	body := "version: 1\n" +
		"# Trusted Clouds.\n" +
		"trustedRoots:\n" +
		"  - name: swarm-cloud-prod\n" +
		"    pem: |\n" + indent(rootPEM, "      ") +
		endpoints
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func indent(s, prefix string) string {
	var b strings.Builder
	for _, line := range strings.Split(strings.TrimRight(s, "\n"), "\n") {
		b.WriteString(prefix + line + "\n")
	}
	return b.String()
}

func oneEndpointYAML(pins ...trust.Digest) string {
	body := `endpoints:
  # the production llama endpoint
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence:
`
	for _, p := range pins {
		body += "      - " + p.String() + "\n"
	}
	return body
}

func TestStoreResolvesRootsAndEndpoints(t *testing.T) {
	rootPEM := selfSignedPEM(t, "swarm-cloud-prod")
	path := writeStoreConfig(t, rootPEM, oneEndpointYAML(pinA))

	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	roots := store.Roots()
	if len(roots) != 1 {
		t.Fatalf("Roots = %d, want 1", len(roots))
	}
	want, err := trust.FingerprintPEM([]byte(rootPEM))
	if err != nil {
		t.Fatal(err)
	}
	if roots[0].Fingerprint != want {
		t.Errorf("root fingerprint = %q, want %q", roots[0].Fingerprint, want)
	}
	if _, ok := store.RootByFingerprint(want); !ok {
		t.Error("RootByFingerprint did not find the configured root")
	}
	if _, ok := store.RootByFingerprint(trust.Sum([]byte("some other cert"))); ok {
		t.Error("RootByFingerprint matched an unknown fingerprint")
	}

	ep, ok := store.Endpoint("llama")
	if !ok {
		t.Fatal("Endpoint(llama) not found")
	}
	if ep.Hostname != "llama.tee.swarm.cloud" || ep.Port != 443 {
		t.Errorf("upstream resolved to %s:%d, want llama.tee.swarm.cloud:443", ep.Hostname, ep.Port)
	}
	if ep.FailMode != config.FailClosed {
		t.Errorf("failMode = %q, want the fail-closed default", ep.FailMode)
	}
	if !store.IsPinned("llama", pinA) {
		t.Error("the configured pin is not recognised")
	}
	if store.IsPinned("llama", pinB) {
		t.Error("an unpinned digest was accepted")
	}
	if store.IsPinned("mistral", pinA) {
		t.Error("an unknown endpoint accepted a pin")
	}
}

func TestStorePinsAreMatchedAcrossSpellings(t *testing.T) {
	// The file writes the pin in hex; the caller asks in canonical form.
	endpoints := `endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence:
      - ` + pinA.Hex() + "\n"
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), endpoints)

	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !store.IsPinned("llama", pinA) {
		t.Error("a hex-spelled pin was not matched by its canonical digest")
	}
}

func TestStoreAddRemovePinRoundTrip(t *testing.T) {
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), oneEndpointYAML(pinA))
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	added, err := store.AddPin("llama", pinB)
	if err != nil || !added {
		t.Fatalf("AddPin = %v, %v; want true, nil", added, err)
	}
	if !store.IsPinned("llama", pinB) {
		t.Error("the added pin is not visible in the store")
	}
	if again, err := store.AddPin("llama", pinB); err != nil || again {
		t.Errorf("AddPin(same) = %v, %v; want false, nil", again, err)
	}

	// The edit went to disk and kept the file readable.
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Written in the printed form, not the canonical one: a config file should
	// spell a pin the way the reports and the console spell it (SUP-115).
	if !strings.Contains(string(saved), pinB.Display()) {
		t.Errorf("the new pin was not persisted as sha256:<hex>:\n%s", saved)
	}
	if strings.Contains(string(saved), pinB.String()) {
		t.Errorf("the new pin was persisted in the canonical form:\n%s", saved)
	}
	if !strings.Contains(string(saved), "# the production llama endpoint") {
		t.Errorf("the comment was lost on save:\n%s", saved)
	}

	reopened, err := trust.Open(path)
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	if !reopened.IsPinned("llama", pinB) {
		t.Error("the added pin did not survive a reload")
	}

	removed, err := store.RemovePin("llama", pinA)
	if err != nil || !removed {
		t.Fatalf("RemovePin = %v, %v; want true, nil", removed, err)
	}
	if store.IsPinned("llama", pinA) {
		t.Error("the removed pin is still accepted")
	}
	if again, err := store.RemovePin("llama", pinA); err != nil || again {
		t.Errorf("RemovePin(absent) = %v, %v; want false, nil", again, err)
	}
}

func TestStoreUnpinsTheLastDigest(t *testing.T) {
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), oneEndpointYAML(pinA))
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Re-pinning an endpoint from scratch is a real operation, so emptying the
	// list is allowed. The result is a config that no longer runs — which
	// `gatekeeper config validate` reports, and the CLI warns about — not one
	// the store refuses to write.
	removed, err := store.RemovePin("llama", pinA)
	if err != nil || !removed {
		t.Fatalf("RemovePin = %v, %v; want true, nil", removed, err)
	}
	ep, _ := store.Endpoint("llama")
	if len(ep.Pins) != 0 {
		t.Errorf("pins = %v, want none left", ep.Pins)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), pinA.String()) {
		t.Error("the removed pin is still in the file")
	}

	// The file it left behind is editable but not runnable.
	cfg, err := config.Parse(bytes.NewReader(data), path)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if err := cfg.ValidateEditable(); err != nil {
		t.Errorf("ValidateEditable: %v, want nil", err)
	}
	if err := cfg.Validate(); err == nil {
		t.Error("Validate accepted an endpoint with no pins")
	}
}

func TestStoreRootRoundTrip(t *testing.T) {
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), oneEndpointYAML(pinA))
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	stagingPEM := selfSignedPEM(t, "staging")
	added, err := store.AddRoot("swarm-cloud-staging", []byte(stagingPEM))
	if err != nil || !added {
		t.Fatalf("AddRoot = %v, %v; want true, nil", added, err)
	}
	if len(store.Roots()) != 2 {
		t.Fatalf("Roots = %d, want 2", len(store.Roots()))
	}
	// The same certificate under a different name is already trusted.
	if again, err := store.AddRoot("duplicate", []byte(stagingPEM)); err != nil || again {
		t.Errorf("AddRoot(same certificate) = %v, %v; want false, nil", again, err)
	}

	if _, err := store.AddRoot("broken", []byte("not a certificate")); err == nil {
		t.Error("AddRoot accepted something that is not a PEM certificate")
	}

	removed, err := store.RemoveRoot("swarm-cloud-staging")
	if err != nil || !removed {
		t.Fatalf("RemoveRoot = %v, %v; want true, nil", removed, err)
	}
	if len(store.Roots()) != 1 {
		t.Errorf("Roots = %d after removal, want 1", len(store.Roots()))
	}
}

func TestStoreFromConfigIsReadOnly(t *testing.T) {
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), oneEndpointYAML(pinA))
	cfg, err := config.Load(config.Options{Path: path, Environ: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	store, err := trust.New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if _, err := store.AddPin("llama", pinB); err == nil {
		t.Error("a store built from an in-memory config accepted a write")
	}
	if _, err := store.RemoveRoot("swarm-cloud-prod"); err == nil {
		t.Error("a store built from an in-memory config accepted a root removal")
	}
}

func TestStoreRejectsUnparseableRoot(t *testing.T) {
	path := writeStoreConfig(t, "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n", oneEndpointYAML(pinA))
	if _, err := trust.Open(path); err == nil {
		t.Fatal("Open accepted a root that is not a valid X.509 certificate")
	}
}

func TestSnapshotIsDeterministicAndHashTracksChanges(t *testing.T) {
	endpoints := `endpoints:
  - name: qwen
    listen: 127.0.0.1:8444
    upstream: https://qwen.tee.swarm.cloud:8443
    trustedEvidence:
      - ` + pinB.String() + `
      - ` + pinA.String() + `
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence:
      - ` + pinA.String() + "\n"
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), endpoints)

	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	snap := store.Snapshot()
	if len(snap.Endpoints) != 2 || snap.Endpoints[0].Name != "llama" || snap.Endpoints[1].Name != "qwen" {
		t.Fatalf("endpoints are not sorted by name: %+v", snap.Endpoints)
	}
	qwen := snap.Endpoints[1]
	if qwen.Digests[0] > qwen.Digests[1] {
		t.Errorf("digests are not sorted: %v", qwen.Digests)
	}
	if len(qwen.DigestsHex) != 2 {
		t.Errorf("hex digests = %v, want two", qwen.DigestsHex)
	}
	if qwen.Hostname != "qwen.tee.swarm.cloud" {
		t.Errorf("hostname = %q, want the upstream host without its port", qwen.Hostname)
	}

	before := store.Hash()
	if before != store.Hash() {
		t.Error("Hash is not stable across calls")
	}
	if _, err := store.AddPin("llama", pinB); err != nil {
		t.Fatal(err)
	}
	if store.Hash() == before {
		t.Error("Hash did not change after a pin was added; the verdict cache would serve a stale decision")
	}
}

func TestSumMatchesCryptoSha256(t *testing.T) {
	data := []byte("deployment snapshot")
	sum := sha256.Sum256(data)
	want, err := trust.DigestFromBytes(sum[:])
	if err != nil {
		t.Fatal(err)
	}
	if got := trust.Sum(data); got != want {
		t.Errorf("Sum = %q, want %q", got, want)
	}
}

func TestStoreEndpointRoundTrip(t *testing.T) {
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), oneEndpointYAML(pinA))
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if err := store.AddEndpoint(config.EndpointSpec{
		Name: "qwen", Listen: "127.0.0.1:8444", Upstream: "https://qwen.example",
		FailMode: config.FailOpen, TrustedEvidence: []string{pinB.String()},
	}); err != nil {
		t.Fatalf("AddEndpoint: %v", err)
	}
	ep, ok := store.Endpoint("qwen")
	if !ok {
		t.Fatal("the new endpoint is not in the resolved state")
	}
	if ep.Hostname != "qwen.example" || ep.FailMode != config.FailOpen || !ep.IsPinned(pinB) {
		t.Errorf("endpoint = %+v, want the spec resolved", ep)
	}

	// A name that is taken is an explicit remove + add, never a silent replace:
	// the pins are the thing that would be quietly lost.
	if err := store.AddEndpoint(config.EndpointSpec{
		Name: "qwen", Listen: "127.0.0.1:9000", Upstream: "https://other.example",
	}); err == nil {
		t.Error("adding a duplicate endpoint succeeded")
	}
	if data, _ := os.ReadFile(path); strings.Contains(string(data), "127.0.0.1:9000") {
		t.Error("the rejected endpoint reached the file")
	}

	removed, err := store.RemoveEndpoint("qwen")
	if err != nil || !removed {
		t.Fatalf("RemoveEndpoint = %v, %v; want true, nil", removed, err)
	}
	if _, ok := store.Endpoint("qwen"); ok {
		t.Error("the endpoint survived its removal")
	}
	if again, err := store.RemoveEndpoint("qwen"); err != nil || again {
		t.Errorf("RemoveEndpoint(absent) = %v, %v; want false, nil", again, err)
	}
}

func TestStoreRejectsAMalformedEndpointWithoutWriting(t *testing.T) {
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), oneEndpointYAML(pinA))
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	before, _ := os.ReadFile(path)

	if err := store.AddEndpoint(config.EndpointSpec{
		Name: "qwen", Listen: "not-an-address", Upstream: "https://qwen.example",
	}); err == nil {
		t.Fatal("a malformed listen address was accepted")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Error("a rejected edit reached the file")
	}
	// And the in-memory state is not left holding the rejected edit either.
	if _, ok := store.Endpoint("qwen"); ok {
		t.Error("the rejected endpoint is in the resolved state")
	}
}

func TestStoreOpensAnUnfinishedConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("version: 1\ntrustedRoots: []\nendpoints: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// This is what `gatekeeper init` leaves behind, and every command that
	// finishes the setup has to be able to open it.
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if len(store.Roots()) != 0 || len(store.Endpoints()) != 0 {
		t.Error("an empty config resolved to something")
	}
	if _, err := store.AddRoot("prod", []byte(selfSignedPEM(t, "prod"))); err != nil {
		t.Errorf("AddRoot on a fresh config: %v", err)
	}
}

func TestStoreRefusesToWriteAfterAFailedRollback(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path,
		[]byte("version: 1\ntrustedRoots: []\nendpoints: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Make the save fail and the re-read fail with it: the document in hand
	// still holds the rejected root, so the store has nothing clean to fall
	// back to.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddRoot("evil", []byte(selfSignedPEM(t, "evil"))); err == nil {
		t.Fatal("the write succeeded against a directory")
	}

	// Without this the rejected root would ride along on the next successful
	// save — an edit the user was told had failed.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path,
		[]byte("version: 1\ntrustedRoots: []\nendpoints: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = store.AddRoot("prod", []byte(selfSignedPEM(t, "prod")))
	if !errors.Is(err, trust.ErrPoisoned) {
		t.Fatalf("err = %v, want ErrPoisoned", err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "evil") {
		t.Error("the rejected root reached the file after all")
	}

	// Re-opening is the way out.
	if _, err := trust.Open(path); err != nil {
		t.Errorf("reopening a clean config: %v", err)
	}
}
