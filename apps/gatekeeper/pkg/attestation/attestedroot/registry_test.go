package attestedroot

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// registryFixture is one real entry of the signed-measurement registry; see
// testdata/README.md.
func registryFixture(t *testing.T) (measurement []byte, document []byte) {
	t.Helper()
	raw, err := os.ReadFile("testdata/registry-signature.json")
	if err != nil {
		t.Fatalf("reading the registry fixture: %v", err)
	}
	var entry struct {
		MrEnclave string `json:"mrenclave"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		t.Fatalf("parsing the registry fixture: %v", err)
	}
	measurement, err = hex.DecodeString(entry.MrEnclave)
	if err != nil {
		t.Fatalf("the fixture's mrenclave is not hex: %v", err)
	}
	return measurement, raw
}

// serveRegistry stands in for raw.githubusercontent.com, answering only the
// paths it is given and 404 for everything else — which is how the real
// registry says "not one of ours".
func serveRegistry(t *testing.T, files map[string][]byte) *HTTPRegistry {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return &HTTPRegistry{BaseURL: server.URL, Client: server.Client()}
}

// TestRegistryAcceptsAPublishedSignature exercises the pinned key against a
// signature Super Protocol actually published.
func TestRegistryAcceptsAPublishedSignature(t *testing.T) {
	measurement, document := registryFixture(t)
	registry := serveRegistry(t, map[string][]byte{
		"/sev-snp/latest/mrenclave-" + hex.EncodeToString(measurement) + ".json": document,
	})

	if err := registry.Verify(context.Background(), measurement, EvidenceSevSnpQemu); err != nil {
		t.Fatalf("a published signature was rejected: %v", err)
	}
}

// TestRegistryFallsThroughChannels checks the probe order: an entry that is
// only in pre-release still counts, and so does the legacy flat layout.
func TestRegistryFallsThroughChannels(t *testing.T) {
	measurement, document := registryFixture(t)
	name := "mrenclave-" + hex.EncodeToString(measurement)

	for _, path := range []string{
		"/sev-snp/pre-release/" + name + ".json",
		"/" + name + ".sign",
	} {
		t.Run(path, func(t *testing.T) {
			body := document
			if strings.HasSuffix(path, ".sign") {
				body = rawSignature(t, document)
			}
			registry := serveRegistry(t, map[string][]byte{path: body})
			if err := registry.Verify(context.Background(), measurement, EvidenceSevSnpQemu); err != nil {
				t.Fatalf("the signature at %s was rejected: %v", path, err)
			}
		})
	}
}

// TestRegistryReportsAMiss is the "not in the trusted registry" verdict, which
// the caller has to be able to tell apart from a registry it could not reach.
func TestRegistryReportsAMiss(t *testing.T) {
	measurement, _ := registryFixture(t)
	registry := serveRegistry(t, nil)

	err := registry.Verify(context.Background(), measurement, EvidenceSevSnpQemu)
	if !errors.Is(err, ErrNotInRegistry) {
		t.Fatalf("error = %v, want ErrNotInRegistry", err)
	}
}

// TestRegistryRejectsATamperedSignature is the reason the key is pinned: a
// registry host that can serve any bytes it likes still cannot mint a trusted
// measurement.
func TestRegistryRejectsATamperedSignature(t *testing.T) {
	measurement, document := registryFixture(t)

	var entry map[string]any
	if err := json.Unmarshal(document, &entry); err != nil {
		t.Fatal(err)
	}
	signature := entry["signature"].(string)
	// Flip one base64 character to a different, still-valid one.
	flipped := "A" + signature[1:]
	if flipped == signature {
		flipped = "B" + signature[1:]
	}
	entry["signature"] = flipped
	tampered, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}

	registry := serveRegistry(t, map[string][]byte{
		"/sev-snp/latest/mrenclave-" + hex.EncodeToString(measurement) + ".json": tampered,
	})
	err = registry.Verify(context.Background(), measurement, EvidenceSevSnpQemu)
	if err == nil {
		t.Fatal("a tampered signature was accepted")
	}
	if errors.Is(err, ErrNotInRegistry) {
		t.Fatalf("a tampered signature was reported as a miss: %v", err)
	}
}

// TestRegistryRejectsAnotherMeasurement covers the substitution the file name
// invites: a genuine signature served under the wrong measurement's name.
func TestRegistryRejectsAnotherMeasurement(t *testing.T) {
	measurement, document := registryFixture(t)
	other := make([]byte, len(measurement))
	copy(other, measurement)
	other[0] ^= 0xff

	registry := serveRegistry(t, map[string][]byte{
		"/sev-snp/latest/mrenclave-" + hex.EncodeToString(other) + ".json": document,
	})
	if err := registry.Verify(context.Background(), other, EvidenceSevSnpQemu); err == nil {
		t.Fatal("a signature over a different measurement was accepted")
	}
}

// TestRegistryFailsWhenItCannotBeConsulted keeps an unreachable registry from
// reading as a clean miss — or, worse, as a pass.
func TestRegistryFailsWhenItCannotBeConsulted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream is down", http.StatusBadGateway)
	}))
	t.Cleanup(server.Close)
	registry := &HTTPRegistry{BaseURL: server.URL, Client: server.Client()}

	err := registry.Verify(context.Background(), make([]byte, 32), EvidenceSevSnpQemu)
	if err == nil {
		t.Fatal("an unreachable registry was treated as an answer")
	}
	if errors.Is(err, ErrNotInRegistry) {
		t.Fatalf("an unreachable registry was reported as a miss: %v", err)
	}
}

func rawSignature(t *testing.T, document []byte) []byte {
	t.Helper()
	var entry struct {
		Signature []byte `json:"signature"`
	}
	if err := json.Unmarshal(document, &entry); err != nil {
		t.Fatal(err)
	}
	return entry.Signature
}
