package config_test

import (
	"os"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// twoFactorEndpoint is a `trust: measurement-and-digest` endpoint with neither
// factor approved yet — the configuration a control loop renders the moment an
// upstream is registered.
const twoFactorEndpoint = `endpoints:
  - name: external
    listen: 127.0.0.1:8444
    upstream: https://llama.other-cloud.example
    trust: measurement-and-digest
`

// Two-factor trust is approved from what a verification has seen, so the
// first verification has to run before either factor exists: no measurement
// listed and no digest pinned is still a file `gatekeeper run` starts on.
func TestTwoFactorRunsBeforeEitherFactorIsApproved(t *testing.T) {
	t.Parallel()
	cfg := mustParse(t, "version: 1\n"+twoFactorEndpoint)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := cfg.Endpoints[0].TrustMode(); got != config.TrustMeasurementAndDigest {
		t.Errorf("TrustMode() = %q, want %q", got, config.TrustMeasurementAndDigest)
	}
	if !config.TrustsCloud(config.TrustMeasurementAndDigest) {
		t.Error("TrustsCloud(measurement-and-digest) = false")
	}
}

// Unlike `cloud-measurement`, a pin here is the second factor, not a stale
// value that reads as enforced — so it is accepted, and still shape-checked.
func TestTwoFactorAcceptsPinsAndChecksTheirShape(t *testing.T) {
	t.Parallel()
	pinned := mustParse(t, "version: 1\n"+twoFactorEndpoint+
		"    trustedEvidence: [sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE]\n")
	if err := pinned.Validate(); err != nil {
		t.Fatalf("Validate with a pinned digest: %v", err)
	}

	malformed := mustParse(t, "version: 1\n"+twoFactorEndpoint+"    trustedEvidence: [not-a-digest]\n")
	err := malformed.ValidateEditable()
	if err == nil || !strings.Contains(err.Error(), "is not an evidenceDigest") {
		t.Errorf("err = %v, want the malformed pin refused even when editable", err)
	}
}

// The cloud half is the attested-root check, so turning the anchor off is the
// same contradiction it is for `cloud-measurement`.
func TestTwoFactorRequiresTheAttestedRootAnchor(t *testing.T) {
	t.Parallel()
	err := mustParse(t, "version: 1\nattestedRoots:\n  enabled: false\n"+twoFactorEndpoint).Validate()
	if err == nil || !strings.Contains(err.Error(), "measurement-and-digest requires the attested-root anchor") {
		t.Errorf("err = %v, want the disabled anchor reported", err)
	}
}

// A pin beside `cloud-measurement` is still refused — and the refusal now
// points at the mode that does enforce both.
func TestAPinOnACloudMeasurementEndpointPointsAtTwoFactor(t *testing.T) {
	t.Parallel()
	err := mustParse(t, strings.Replace(cloudMeasurementConfig,
		"    trust: cloud-measurement\n",
		"    trust: cloud-measurement\n    trustedEvidence: [sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE]\n",
		1)).Validate()
	if err == nil || !strings.Contains(err.Error(), "use trust: measurement-and-digest to require both") {
		t.Errorf("err = %v, want it to name the two-factor mode", err)
	}
}

// The file router-api renders for its egress sidecar is the contract between
// the two (ADR-008 §5). Its golden copy has to be a configuration this binary
// runs — two-factor endpoints with a pin and without one — or the seam breaks
// with nothing on either side failing alone.
func TestRouterAPIsRenderedSidecarConfigRuns(t *testing.T) {
	t.Parallel()
	const golden = "../../../router-api/src/app/external-endpoints/testdata/sidecar-config.golden.yaml"
	body, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("reading the golden render: %v", err)
	}
	cfg := mustParse(t, string(body))
	if err := cfg.Validate(); err != nil {
		t.Fatalf("router-api's rendered config does not validate: %v", err)
	}
	for _, ep := range cfg.Endpoints {
		if ep.TrustMode() != config.TrustMeasurementAndDigest {
			t.Errorf("endpoint %q renders trust %q, want %q", ep.Name, ep.TrustMode(), config.TrustMeasurementAndDigest)
		}
	}
}
