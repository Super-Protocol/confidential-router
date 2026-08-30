package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// commentedConfig exercises what a hand-written file looks like: header
// comments, inline comments, block scalars and a comment between entries.
const commentedConfig = `# ~/.config/confidential-gatekeeper/config.yaml
version: 1

# Trusted Clouds.
trustedRoots:
  - name: swarm-cloud-prod
    pem: |
      -----BEGIN CERTIFICATE-----
      MIIBkTCB+w==
      -----END CERTIFICATE-----

endpoints:
  # The production llama endpoint.
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence:
      # current release
      - sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE
    failMode: closed # explicit for clarity
`

func openDocument(t *testing.T, body string) (*config.Document, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	doc, err := config.OpenDocument(path)
	if err != nil {
		t.Fatalf("OpenDocument: %v", err)
	}
	return doc, path
}

func TestDocumentAddTrustedEvidenceKeepsComments(t *testing.T) {
	doc, path := openDocument(t, commentedConfig)

	added, err := doc.AddTrustedEvidence("llama", "sha256/pxKq2dS9fLm3nT7vW1yB4cE6gH8jK0mN2pR4sU6wX8z")
	if err != nil {
		t.Fatalf("AddTrustedEvidence: %v", err)
	}
	if !added {
		t.Fatal("AddTrustedEvidence reported no change, want the pin to be added")
	}
	if err := doc.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	saved := readFile(t, path)
	for _, comment := range []string{
		"# ~/.config/confidential-gatekeeper/config.yaml",
		"# Trusted Clouds.",
		"# The production llama endpoint.",
		"# current release",
		"# explicit for clarity",
	} {
		if !strings.Contains(saved, comment) {
			t.Errorf("comment %q was lost:\n%s", comment, saved)
		}
	}
	if !strings.Contains(saved, "sha256/pxKq2dS9fLm3nT7vW1yB4cE6gH8jK0mN2pR4sU6wX8z") {
		t.Errorf("the new pin is missing:\n%s", saved)
	}
	// The literal block scalar of the PEM must survive as a block, not be
	// folded into a quoted one-liner.
	if !strings.Contains(saved, "pem: |") {
		t.Errorf("the PEM block scalar was rewritten:\n%s", saved)
	}

	cfg, err := config.Load(config.Options{Path: path, Environ: []string{}})
	if err != nil {
		t.Fatalf("reloading the saved file: %v", err)
	}
	ep, _ := cfg.Endpoint("llama")
	if len(ep.TrustedEvidence) != 2 {
		t.Errorf("trustedEvidence = %v, want two pins", ep.TrustedEvidence)
	}
}

func TestDocumentAddTrustedEvidenceIsIdempotent(t *testing.T) {
	doc, _ := openDocument(t, commentedConfig)

	added, err := doc.AddTrustedEvidence("llama", "sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE")
	if err != nil {
		t.Fatalf("AddTrustedEvidence: %v", err)
	}
	if added {
		t.Error("AddTrustedEvidence added a pin that was already there")
	}
}

func TestDocumentRemoveTrustedEvidence(t *testing.T) {
	doc, path := openDocument(t, commentedConfig)

	removed, err := doc.RemoveTrustedEvidence("llama", []string{"sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE"})
	if err != nil {
		t.Fatalf("RemoveTrustedEvidence: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if err := doc.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if strings.Contains(readFile(t, path), "sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE") {
		t.Error("the pin is still in the file")
	}
}

func TestDocumentUnknownEndpoint(t *testing.T) {
	doc, _ := openDocument(t, commentedConfig)

	if _, err := doc.AddTrustedEvidence("mistral", "sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE"); err == nil ||
		!strings.Contains(err.Error(), `no endpoint named "mistral"`) {
		t.Fatalf("err = %v, want a missing-endpoint error", err)
	}
}

func TestDocumentTrustedRootRoundTrip(t *testing.T) {
	doc, path := openDocument(t, commentedConfig)

	const pem = "-----BEGIN CERTIFICATE-----\nMIIBkTCB+w==\n-----END CERTIFICATE-----"
	if err := doc.AddTrustedRoot("swarm-cloud-staging", pem); err != nil {
		t.Fatalf("AddTrustedRoot: %v", err)
	}
	if err := doc.AddTrustedRoot("swarm-cloud-staging", pem); err == nil {
		t.Error("AddTrustedRoot accepted a duplicate name; replacing an anchor must be explicit")
	}
	if err := doc.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	cfg, err := config.Load(config.Options{Path: path, Environ: []string{}})
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(cfg.TrustedRoots) != 2 {
		t.Fatalf("trustedRoots = %d, want 2", len(cfg.TrustedRoots))
	}

	removed, err := doc.RemoveTrustedRoot("swarm-cloud-staging")
	if err != nil || !removed {
		t.Fatalf("RemoveTrustedRoot = %v, %v", removed, err)
	}
	if err := doc.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if strings.Contains(readFile(t, path), "swarm-cloud-staging") {
		t.Error("the removed root is still in the file")
	}

	if removed, err := doc.RemoveTrustedRoot("never-there"); err != nil || removed {
		t.Errorf("RemoveTrustedRoot(absent) = %v, %v; want false, nil", removed, err)
	}
}

func TestDocumentSaveIsAtomicAndKeepsPermissions(t *testing.T) {
	doc, path := openDocument(t, commentedConfig)
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	reopened, err := config.OpenDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.AddTrustedEvidence("llama", "sha256/pxKq2dS9fLm3nT7vW1yB4cE6gH8jK0mN2pR4sU6wX8z"); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := info.Mode().Perm(), os.FileMode(0o640); got != want {
		t.Errorf("mode = %v, want %v", got, want)
	}
	// No temp file may be left behind next to the config.
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "config.yaml" {
			t.Errorf("unexpected leftover %q in the config directory", e.Name())
		}
	}
	_ = doc
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}
