package trust_test

import (
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// cloudMeasurementEndpointYAML is an endpoint that trusts its cloud by
// measurement, next to the measurement list that makes it runnable.
func cloudMeasurementEndpointYAML(measurements ...string) string {
	body := "attestedRoots:\n  trustedMeasurements:\n"
	for _, m := range measurements {
		body += "    - " + m + "\n"
	}
	return body + `endpoints:
  # the externally registered upstream
  - name: external
    listen: 127.0.0.1:8444
    upstream: https://llama.other-cloud.example
    trust: cloud-measurement
`
}

func TestStoreResolvesTheTrustMode(t *testing.T) {
	t.Parallel()
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"),
		cloudMeasurementEndpointYAML(measurementA)+
			// A second, digest-pinned endpoint in the same file: both modes
			// coexist, which is what the router's renderer produces.
			"  - name: llama\n    listen: 127.0.0.1:8443\n"+
			"    upstream: https://llama.tee.swarm.cloud\n    trustedEvidence:\n      - "+pinA.String()+"\n")

	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	external, ok := store.Endpoint("external")
	if !ok {
		t.Fatal("the cloud-measurement endpoint is missing from the store")
	}
	if !external.ByMeasurement() || external.Trust != config.TrustCloudMeasurement {
		t.Errorf("trust = %q, want %q", external.Trust, config.TrustCloudMeasurement)
	}
	if len(external.Pins) != 0 {
		t.Errorf("pins = %+v, want none", external.Pins)
	}

	// An endpoint that said nothing resolves to the digest-pinned default —
	// never to the weaker mode.
	pinned, ok := store.Endpoint("llama")
	if !ok {
		t.Fatal("the digest-pinned endpoint is missing from the store")
	}
	if pinned.ByMeasurement() || pinned.Trust != config.TrustEvidenceDigest {
		t.Errorf("trust = %q, want %q", pinned.Trust, config.TrustEvidenceDigest)
	}
}

// A pin on a cloud-measurement endpoint is refused by the store rather than
// written and then rejected by validation on save, which would report a problem
// that reads as though it were about the pin's format.
func TestAddPinIsRefusedOnACloudMeasurementEndpoint(t *testing.T) {
	t.Parallel()
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), cloudMeasurementEndpointYAML(measurementA))
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	added, err := store.AddPin("external", pinA)
	if err == nil {
		t.Fatal("AddPin wrote a pin onto a cloud-measurement endpoint")
	}
	if added {
		t.Error("AddPin reported a change it refused to make")
	}
	for _, want := range []string{"trusts its cloud by measurement", config.TrustEvidenceDigest} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %v\nwant it to mention %q", err, want)
		}
	}

	// Nothing was written: the endpoint still holds no pins and the file still
	// loads.
	if reopened, err := trust.Open(path); err != nil {
		t.Errorf("the config no longer opens: %v", err)
	} else if ep, _ := reopened.Endpoint("external"); len(ep.Pins) != 0 {
		t.Errorf("pins = %+v, want none", ep.Pins)
	}
}

// The measurement list is global, so the display question "is this cloud on the
// list?" is answered by the store — normalised, and never by prefix.
func TestIsTrustedMeasurement(t *testing.T) {
	t.Parallel()
	path := writeStoreConfig(t, selfSignedPEM(t, "prod"), cloudMeasurementEndpointYAML(measurementA))
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if !store.IsTrustedMeasurement(measurementA) {
		t.Error("a listed measurement reads as untrusted")
	}
	for _, absent := range []string{measurementB, "", measurementA[:32], strings.ToUpper(measurementA)} {
		if store.IsTrustedMeasurement(absent) {
			t.Errorf("IsTrustedMeasurement(%q) = true, want false — the argument is already normalised hex", absent)
		}
	}
}
