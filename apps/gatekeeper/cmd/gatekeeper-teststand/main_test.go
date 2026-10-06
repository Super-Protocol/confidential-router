//go:build teststand

package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
)

const measurement = "842c5f2e1d0b4a9c7e6f3d8b5a2c9e0f1b4d7a6c3e8f5b2d9a0c7e4f1b6d3a8c"

func fixture(t *testing.T, body string) fileAttestedRoots {
	t.Helper()
	path := filepath.Join(t.TempDir(), "attested-root.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the fixture: %v", err)
	}
	return fileAttestedRoots{path: path}
}

func certificate(t *testing.T) *x509.Certificate {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generating a key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "stand root"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("creating a certificate: %v", err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parsing the certificate: %v", err)
	}
	return parsed
}

// The happy path, and the property that keeps the stand honest: the verdict it
// hands back says in its own logs that no hardware was checked.
func TestFixtureAdmitsAndSaysWhatItSubstituted(t *testing.T) {
	source := fixture(t, `{"attested":true,"measurement":"`+measurement+`","measurementSource":"registry","inRegistry":true}`)

	result, err := source.Verify(t.Context(), certificate(t))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !result.Attested {
		t.Fatalf("attested = false (%s)", result.Reason)
	}
	if result.MeasurementHex() != measurement {
		t.Errorf("measurement = %q, want %q", result.MeasurementHex(), measurement)
	}
	if result.MeasurementSource != attestedroot.SourceRegistry || !result.InRegistry {
		t.Errorf("source = %q inRegistry = %v, want the registry signature reported",
			result.MeasurementSource, result.InRegistry)
	}
	// The default, matching the live Swarm root rather than the flattering value.
	if result.NetworkType != attestedroot.NetworkUntrusted {
		t.Errorf("networkType = %q, want %q", result.NetworkType, attestedroot.NetworkUntrusted)
	}
	if len(result.Logs) == 0 || !strings.Contains(result.Logs[0], "no hardware report was verified") {
		t.Errorf("logs = %v, want the substitution named", result.Logs)
	}
}

// A fixture that cannot be read or understood denies — it never falls back to
// something more permissive, and it never returns an error, because the caller
// renders a denial either way (pkg/verifier/attestedroot.go).
func TestFixtureFailsClosed(t *testing.T) {
	cases := map[string]fileAttestedRoots{
		"missing":           {path: filepath.Join(t.TempDir(), "absent.json")},
		"not json":          fixture(t, "{"),
		"short measurement": fixture(t, `{"attested":true,"measurement":"abcd"}`),
	}
	for name, source := range cases {
		t.Run(name, func(t *testing.T) {
			result, err := source.Verify(t.Context(), certificate(t))
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if result.Attested {
				t.Fatal("attested = true for a fixture that could not be used")
			}
			if result.Reason == "" {
				t.Error("a denial has to say why")
			}
		})
	}
}

// Nil is a caller mistake, and the real verifier reports it as an error rather
// than as a denial. The substitute keeps that contract.
func TestFixtureRejectsNoCertificate(t *testing.T) {
	if _, err := fixture(t, `{"attested":true}`).Verify(t.Context(), nil); err == nil {
		t.Fatal("Verify(nil) should be an error, not a verdict")
	}
}

// The supervisor built at startup and the one a SIGHUP rebuilds have to read
// the same file, which is only true if the flag is honoured here too.
func TestConfigPathOfReadsTheFlag(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"run", "--headless", "--config", "/etc/gatekeeper/config.yaml"}, "/etc/gatekeeper/config.yaml"},
		{[]string{"--config=/tmp/a.yaml", "run"}, "/tmp/a.yaml"},
		{[]string{"-c", "/tmp/b.yaml", "run"}, "/tmp/b.yaml"},
		{[]string{"run", "--headless"}, ""},
		{[]string{"run", "--config"}, ""},
	} {
		if got := configPathOf(tc.args); got != tc.want {
			t.Errorf("configPathOf(%v) = %q, want %q", tc.args, got, tc.want)
		}
	}
}
