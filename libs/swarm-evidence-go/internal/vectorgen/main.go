// Command vectorgen regenerates the composite-evidence conformance vectors in
// libs/attestation-fixtures/vectors/composite.
//
//	go run ./internal/vectorgen        # from libs/swarm-evidence-go
//
// It mints the fixture PKI from the committed keys in
// libs/attestation-fixtures/tools/keys, assembles one CMW collection per case,
// records the quote appraisal each case is appraised against — in the neutral
// spelling and as a signed token per appraiser profile — and writes the claim
// set every path must produce.
//
// Two properties are load-bearing, and both are the bundle generator's too:
//
//   - **Output is deterministic.** Fixed keys, fixed serials, fixed validity
//     windows and fixed timestamps, and both signature schemes are
//     deterministic (RSASSA-PKCS1-v1_5 is a function of the message and the
//     key). Running it twice produces byte-identical files, so a non-empty
//     `git diff` after a run is a real change to the contract.
//   - **Expectations are declared, not computed.** This program never calls
//     AppraiseComposite: it writes the claim set the profile says the evidence
//     establishes, assembled from the same facts it built the evidence out of.
//     A generator that asked the verifier what it thought would produce a
//     corpus that asserts nothing.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/conformance"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "vectorgen:", err)
		os.Exit(1)
	}
}

func run() error {
	vectorsFlag := flag.String("vectors", "", "the vectors directory (default: found by walking up)")
	keysFlag := flag.String("keys", "", "the fixture key directory (default: beside the vectors)")
	flag.Parse()

	vectorsDir := *vectorsFlag
	if vectorsDir == "" {
		found, err := findVectorsDir()
		if err != nil {
			return err
		}
		vectorsDir = found
	}
	keysDir := *keysFlag
	if keysDir == "" {
		keysDir = filepath.Join(filepath.Dir(vectorsDir), "tools", "keys")
	}

	m, err := newMaterial(keysDir, vectorsDir)
	if err != nil {
		return err
	}
	profiles, err := m.profiles()
	if err != nil {
		return err
	}

	// The whole output directory is rewritten, so a case that was renamed or
	// removed cannot leave an orphan behind that nothing replays.
	if err := os.RemoveAll(m.outDir); err != nil {
		return err
	}
	for _, sub := range []string{"collections", "appraisals"} {
		if err := os.MkdirAll(filepath.Join(m.outDir, sub), 0o755); err != nil {
			return err
		}
	}

	roots, err := m.roots()
	if err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(m.outDir, "roots.json"), roots); err != nil {
		return err
	}

	manifest := conformance.CompositeManifest{
		Version: "1",
		Description: "Composite Super Swarm Evidence conformance vectors: a CMW collection per case, " +
			"the recorded quote appraisal it is appraised against, and the SwarmClaims document every " +
			"appraisal path must produce. Every case is replayed through every appraiser profile.",
		Generator:    "libs/swarm-evidence-go/internal/vectorgen",
		ReferenceNow: referenceNow,
		RootsFile:    "composite/roots.json",
		Appraisers:   profiles,
	}

	seen := map[string]bool{}
	for _, spec := range cases() {
		if seen[spec.id] {
			return fmt.Errorf("duplicate case id %q", spec.id)
		}
		seen[spec.id] = true

		built, err := m.build(spec, profiles)
		if err != nil {
			return fmt.Errorf("case %q: %w", spec.id, err)
		}
		if err := writeJSON(filepath.Join(m.outDir, "collections", spec.id+".json"), built.collection); err != nil {
			return err
		}
		if err := writeJSON(filepath.Join(m.outDir, "appraisals", spec.id+".json"), built.appraisals); err != nil {
			return err
		}
		manifest.Cases = append(manifest.Cases, built.file)
	}

	if err := writeJSON(filepath.Join(m.outDir, "manifest.json"), manifest); err != nil {
		return err
	}
	fmt.Printf("vectorgen: wrote %d composite cases and %d appraiser profiles to %s\n",
		len(manifest.Cases), len(profiles), m.outDir)
	return nil
}

// roots is the trust-anchor file the cases name: the pinned Super Swarm PKI
// root, and the root of another cloud that nobody pinned.
func (m *material) roots() (map[string]any, error) {
	return map[string]any{
		"version": "1",
		"description": "Trust anchors referenced by composite/manifest.json cases. `fingerprint` is " +
			"sha256/<base64url> of the DER — the value a verifier matches on.",
		"roots": []any{
			map[string]any{
				"name":        rootName,
				"fingerprint": m.root.Fingerprint(),
				"pem":         m.root.PEM,
			},
			map[string]any{
				"name":        foreignRootName,
				"fingerprint": m.foreignRoot.Fingerprint(),
				"pem":         m.foreignRoot.PEM,
			},
		},
	}, nil
}

// findVectorsDir walks up from the working directory, so the generator runs
// from the module, the repository root or a worktree alike.
func findVectorsDir() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, filepath.FromSlash(conformance.VectorsDir))
		if info, err := os.Stat(filepath.Join(candidate, "manifest.json")); err == nil && !info.IsDir() {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("could not find " + conformance.VectorsDir + " above the working directory")
		}
		dir = parent
	}
}

func writeJSON(path string, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(encoded, '\n'), 0o644)
}
