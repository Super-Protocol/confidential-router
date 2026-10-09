//go:build teststand

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
)

// registryLayout is the cut of the real sp-vm signatures tree the attestedroot
// package tests against; see its testdata/README.md. The stand serves the same
// directory, so what the e2e suite sees as `inRegistry` is a real lookup
// against the real layout.
const registryLayout = "../../pkg/attestation/attestedroot/testdata/registry"

// azureMeasurement is signed in the layout's sev-snp-azure/pre-release folder
// (the apps-448 cloud); unknownMeasurement is signed nowhere.
const (
	azureMeasurement   = "74c75a0ba5f36e55548a14aa0dae0d0c9de9cd6ad041a4f6c553c996e2c579a7"
	unknownMeasurement = "bb6962eb20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab"
)

func withRegistry(t *testing.T, handler http.Handler, body string) fileAttestedRoots {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	roots := fixture(t, body)
	roots.registry = &attestedroot.HTTPRegistry{BaseURL: server.URL, Client: server.Client()}
	roots.registryURL = server.URL
	return roots
}

// With a registry configured, the fixture's own inRegistry/measurementSource
// are ignored: the stand reports what the lookup found. A fixture that said
// "not in the registry" about a measurement the registry signs is corrected,
// so the e2e's `measurementSource: REGISTRY` is a product of the fetch.
func TestRegistryLookupOverridesTheFixture(t *testing.T) {
	roots := withRegistry(t, http.FileServer(http.Dir(registryLayout)),
		`{"attested":true,"measurement":"`+azureMeasurement+`","evidenceType":"AMD SEV-SNP (Azure)","inRegistry":false}`)

	result, err := roots.Verify(t.Context(), certificate(t))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !result.Attested || !result.InRegistry || result.MeasurementSource != attestedroot.SourceRegistry {
		t.Fatalf("attested = %v, inRegistry = %v, source = %q; want the registry to have signed it (%s)",
			result.Attested, result.InRegistry, result.MeasurementSource, result.Reason)
	}
	if result.MeasurementUnknown {
		t.Error("measurementUnknown = true for a signed measurement")
	}
	if !strings.Contains(strings.Join(result.Logs, "\n"), "is signed in the registry") {
		t.Errorf("logs = %v, want the lookup named", result.Logs)
	}
}

// The rotate-measurement beat under a real registry: the image nobody signed
// stays attested — the hardware leg is the fixture's to assert — but nothing
// vouches for it, which is what a cloud redeployed on an unsigned image looks
// like. A fixture claiming `inRegistry: true` for it is not believed.
func TestRegistryLookupReportsAMissWithoutDenying(t *testing.T) {
	roots := withRegistry(t, http.FileServer(http.Dir(registryLayout)),
		`{"attested":true,"measurement":"`+unknownMeasurement+`","measurementSource":"registry","inRegistry":true}`)

	result, err := roots.Verify(t.Context(), certificate(t))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !result.Attested {
		t.Fatalf("attested = false (%s); a registry miss is the admin list's call, not a denial here", result.Reason)
	}
	if result.InRegistry || result.MeasurementSource != "" || !result.MeasurementUnknown {
		t.Errorf("inRegistry = %v, source = %q, unknown = %v; want the miss reported",
			result.InRegistry, result.MeasurementSource, result.MeasurementUnknown)
	}
}

// The folder map is the stand's too: the same measurement under the QEMU type
// is a miss, because sev-snp-azure is never consulted for QEMU evidence.
func TestRegistryLookupHonoursTheEvidenceType(t *testing.T) {
	roots := withRegistry(t, http.FileServer(http.Dir(registryLayout)),
		`{"attested":true,"measurement":"`+azureMeasurement+`"}`)

	result, err := roots.Verify(t.Context(), certificate(t))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if result.InRegistry || !result.MeasurementUnknown {
		t.Errorf("inRegistry = %v, unknown = %v for an Azure-only measurement under the default QEMU type",
			result.InRegistry, result.MeasurementUnknown)
	}
}

// A registry that answers anything but "yes" or "no" is an outage, and the
// stand fails closed on it exactly as the shipped verifier does.
func TestRegistryOutageDenies(t *testing.T) {
	roots := withRegistry(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "mirror down", http.StatusBadGateway)
	}), `{"attested":true,"measurement":"`+azureMeasurement+`","evidenceType":"AMD SEV-SNP (Azure)"}`)

	result, err := roots.Verify(t.Context(), certificate(t))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if result.Attested || result.InRegistry {
		t.Fatalf("attested = %v, inRegistry = %v during a registry outage", result.Attested, result.InRegistry)
	}
	if !strings.Contains(result.Reason, "could not be consulted") {
		t.Errorf("reason = %q, want the outage named", result.Reason)
	}
}

// A fixture that already denies is not looked up: there is no measurement to
// vouch for, and a registry round trip would only add a second reason.
func TestRegistryIsNotConsultedForADeniedFixture(t *testing.T) {
	asked := false
	roots := withRegistry(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = true
		http.NotFound(w, r)
	}), `{"attested":false,"reason":"withdrawn","measurement":"`+azureMeasurement+`"}`)

	if _, err := roots.Verify(t.Context(), certificate(t)); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if asked {
		t.Error("the registry was consulted for a fixture that denies")
	}
}

func TestEvidenceTypeOfReadsTheDisplayName(t *testing.T) {
	for name, want := range map[string]attestedroot.EvidenceType{
		"AMD SEV-SNP (Azure)": attestedroot.EvidenceSevSnpAzure,
		"Intel TDX (Azure)":   attestedroot.EvidenceTdxAzure,
		"Intel TDX (GCP)":     attestedroot.EvidenceTdxGCP,
		"Intel TDX (QEMU)":    attestedroot.EvidenceTdxQemu,
		"AMD SEV-SNP (QEMU)":  attestedroot.EvidenceSevSnpQemu,
		"AMD SEV-SNP":         attestedroot.EvidenceSevSnpQemu,
		"":                    attestedroot.EvidenceSevSnpQemu,
	} {
		if got := evidenceTypeOf(name); got != want {
			t.Errorf("evidenceTypeOf(%q) = %v, want %v", name, got, want)
		}
	}
}
