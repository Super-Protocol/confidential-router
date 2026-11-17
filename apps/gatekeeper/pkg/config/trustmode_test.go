package config_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// cloudMeasurementConfig is a complete, valid `trust: cloud-measurement`
// deployment: one measurement listed globally, one endpoint pinning nothing.
const cloudMeasurementConfig = `version: 1
attestedRoots:
  trustedMeasurements:
    - 842c1f6b20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab
endpoints:
  - name: external
    listen: 127.0.0.1:8444
    upstream: https://llama.other-cloud.example
    trust: cloud-measurement
`

func TestTrustModeDefaultsToTheDigestPin(t *testing.T) {
	t.Parallel()
	// An endpoint that says nothing is digest-pinned. The weaker mode is never
	// implicit, and it is never what an upgrade turns an existing file into.
	cfg := mustParse(t, "version: 1\n"+roots+oneEndpoint)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := cfg.Endpoints[0].TrustMode(); got != config.TrustEvidenceDigest {
		t.Errorf("TrustMode() = %q, want %q", got, config.TrustEvidenceDigest)
	}
	// And the explicit spelling of the default is accepted, so a renderer can
	// always write the field.
	explicit := mustParse(t, "version: 1\n"+roots+strings.Replace(oneEndpoint,
		"    listen: 127.0.0.1:8443\n", "    listen: 127.0.0.1:8443\n    trust: evidence-digest\n", 1))
	if err := explicit.Validate(); err != nil {
		t.Fatalf("Validate with an explicit evidence-digest mode: %v", err)
	}
}

func TestCloudMeasurementConfigIsValidWithoutAnyPin(t *testing.T) {
	t.Parallel()
	cfg := mustParse(t, cloudMeasurementConfig)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := cfg.Endpoints[0].TrustMode(); got != config.TrustCloudMeasurement {
		t.Errorf("TrustMode() = %q, want %q", got, config.TrustCloudMeasurement)
	}
}

// The XOR, in both directions. "Both modes" is the dangerous one: a file that
// lists a pin next to `cloud-measurement` reads as though the pin were still
// enforced, and it is not.
func TestValidateRejectsAnEndpointInBothModesOrNeither(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		yaml string
		want string
	}{
		{
			name: "both modes",
			yaml: strings.Replace(cloudMeasurementConfig,
				"    trust: cloud-measurement\n",
				"    trust: cloud-measurement\n    trustedEvidence: [sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE]\n",
				1),
			want: "endpoints[0].trustedEvidence: must be empty when trust is cloud-measurement",
		},
		{
			name: "neither mode",
			yaml: "version: 1\n" + roots + `endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence: []
`,
			want: "endpoints[0].trustedEvidence: at least one pinned evidenceDigest is required",
		},
		{
			name: "an unknown mode",
			yaml: strings.Replace(cloudMeasurementConfig, "cloud-measurement", "cloud_measurement", 1),
			want: "endpoints[0].trust: must be one of evidence-digest, cloud-measurement, measurement-and-digest",
		},
		{
			// The mode *is* the attested-root check; with the anchor off it
			// could never admit anything, so the contradiction is reported
			// where it is, not as a silent deny at request time.
			name: "the attested-root anchor turned off",
			yaml: strings.Replace(cloudMeasurementConfig,
				"attestedRoots:\n", "attestedRoots:\n  enabled: false\n", 1),
			want: "cloud-measurement requires the attested-root anchor",
		},
		{
			name: "no measurements listed",
			yaml: "version: 1\n" + roots + `endpoints:
  - name: external
    listen: 127.0.0.1:8444
    upstream: https://llama.other-cloud.example
    trust: cloud-measurement
`,
			want: `attestedRoots.trustedMeasurements: at least one measurement is required by endpoint "external"`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := mustParse(t, tc.yaml).Validate()
			if err == nil {
				t.Fatalf("Validate accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v\nwant it to contain %q", err, tc.want)
			}
		})
	}
}

// An unknown mode and a pin on a cloud-measurement endpoint are *wrong values*,
// not unfinished setup, so even the editing commands refuse to save them — a
// missing measurement list, which the next command may fill in, is forgiven.
func TestValidateEditableOnTheTrustModes(t *testing.T) {
	t.Parallel()

	refused := mustParse(t, strings.Replace(cloudMeasurementConfig,
		"    trust: cloud-measurement\n",
		"    trust: cloud-measurement\n    trustedEvidence: [sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE]\n",
		1))
	if err := refused.ValidateEditable(); err == nil {
		t.Error("ValidateEditable accepted an endpoint in both trust modes")
	}

	unfinished := mustParse(t, "version: 1\n"+roots+`endpoints:
  - name: external
    listen: 127.0.0.1:8444
    upstream: https://llama.other-cloud.example
    trust: cloud-measurement
`)
	if err := unfinished.ValidateEditable(); err != nil {
		t.Errorf("ValidateEditable: %v, want nil — the measurement list is filled in by a later command", err)
	}
	err := unfinished.Validate()
	var invalid *config.ValidationError
	if !errors.As(err, &invalid) {
		t.Fatalf("Validate returned %T, want *config.ValidationError", err)
	}
	if len(invalid.Errors) != 1 || !invalid.Errors[0].Incomplete {
		t.Fatalf("problems = %v, want exactly one, reported as unfinished setup", invalid.Errors)
	}
}

// The measurement list is global. A deployment that renders many
// cloud-measurement endpoints — which is the caller this mode exists for —
// must be told once that the list is empty, not once per endpoint.
func TestTheEmptyMeasurementListIsReportedOnce(t *testing.T) {
	t.Parallel()
	yaml := "version: 1\n" + roots + `endpoints:
  - name: external-a
    listen: 127.0.0.1:8441
    upstream: https://a.other-cloud.example
    trust: cloud-measurement
  - name: external-b
    listen: 127.0.0.1:8442
    upstream: https://b.other-cloud.example
    trust: cloud-measurement
  - name: external-c
    listen: 127.0.0.1:8443
    upstream: https://c.other-cloud.example
    trust: cloud-measurement
`

	err := mustParse(t, yaml).Validate()
	var invalid *config.ValidationError
	if !errors.As(err, &invalid) {
		t.Fatalf("Validate returned %T, want *config.ValidationError", err)
	}
	if len(invalid.Errors) != 1 || invalid.Errors[0].Path != "attestedRoots.trustedMeasurements" {
		t.Errorf("problems = %v, want the empty measurement list reported exactly once", invalid.Errors)
	}
}
