package cli_test

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/verifier"
)

// cloudMeasurement is the launch measurement of the stand these tests run
// against — the root CA of one cloud, which is the only granularity that exists
// (ADR-007 §3a).
const cloudMeasurement = "842c5f2e1d0b4a9c7e6f3d8b5a2c9e0f1b4d7a6c3e8f5b2d9a0c7e4f1b6d3a8c"

// signingRegistry is a registry that vouches for one measurement and refuses
// every other, so a test can produce the one case the whole list-is-sole-
// authority ruling is about: a cloud Super Protocol *has* signed.
type signingRegistry struct {
	signs string
	asked atomic.Int64
}

func (r *signingRegistry) Verify(_ context.Context, mrEnclave []byte, _ attestedroot.EvidenceType) error {
	r.asked.Add(1)
	if hex.EncodeToString(mrEnclave) == r.signs {
		return nil
	}
	return attestedroot.ErrNotInRegistry
}

// cloudHardware stands in for the one leg a test cannot produce — a report
// signed by a real CPU vendor key — and runs the production measurement
// admission over whichever registry and config file it is given. Both anchors
// are therefore real code: which one vouched, and what that is worth, is
// decided by [attestedroot.Verifier.AdmitMeasurement].
type cloudHardware struct {
	measurement string
	registry    attestedroot.Registry

	cfg *config.Config
}

func (h *cloudHardware) Verify(ctx context.Context, _ *x509.Certificate) (*attestedroot.Result, error) {
	raw, err := hex.DecodeString(h.measurement)
	if err != nil {
		return nil, err
	}
	result := &attestedroot.Result{
		EvidenceType:     attestedroot.EvidenceSevSnpQemu,
		EvidenceTypeName: attestedroot.EvidenceSevSnpQemu.String(),
		NetworkType:      attestedroot.NetworkUntrusted,
		ReportIntegrity:  true,
		KeyBinding:       true,
		ReportData:       make([]byte, 64),
		CPUGeneration:    "Genoa",
		Measurement:      raw,
		SecurityFields:   attestedroot.SecurityFields{SnpFirmwareTCB: 27, ReportVersion: 5},
	}
	anchors := &attestedroot.Verifier{
		Registry:            h.registry,
		TrustedMeasurements: h.cfg.AttestedRootsTrustedMeasurements(),
		CacheTTL:            -1,
	}
	result.Attested = anchors.AdmitMeasurement(ctx, result, result.EvidenceType)
	return result, nil
}

// liveCloudVerifier rebuilds the real pipeline from the config file on every
// call, so a command that edited the file is answered from what it wrote.
type liveCloudVerifier struct {
	h        *harness
	hardware *cloudHardware
}

func (l *liveCloudVerifier) Verify(ctx context.Context, req status.VerifyRequest) (*status.Report, error) {
	cfg, err := config.Load(config.Options{Path: l.h.configPath, Environ: []string{}, Editable: true})
	if err != nil {
		return nil, err
	}
	built, err := verifier.New(ctx, cfg)
	if err != nil {
		return nil, err
	}
	l.hardware.cfg = cfg
	return built.WithAttestedRoots(l.hardware).Verify(ctx, req)
}

// cloudStand starts a live HTTPS endpoint whose certificate authority nobody
// listed, and wires the CLI to the real pipeline over it. The endpoint named
// `external` trusts its cloud by measurement; `pinned` is an ordinary
// digest-pinned endpoint on the same host, so every assertion below also shows
// what did *not* change for the user-side semantics (SUP-139).
func cloudStand(t *testing.T, registry attestedroot.Registry) (*harness, *evidenceHost, *cloudHardware) {
	t.Helper()
	host := newEvidenceHost(t, testDigest("deployment A"))
	hardware := &cloudHardware{measurement: cloudMeasurement, registry: registry}

	h := newHarness(t)
	// The bundle is signed against the real clock, so freshness is exercised.
	h.env.Now = time.Now
	h.mustRun("init")
	// Deliberately no `trust roots add`: this mode exists for a caller that
	// cannot fetch a certificate out of band for every new upstream.
	h.mustRun("endpoint", "add", "external", "--listen", "127.0.0.1:8787", "--upstream", host.Upstream())
	h.mustRun("endpoint", "add", "pinned", "--listen", "127.0.0.1:8788", "--upstream", host.Upstream())
	// No command writes the weaker mode, and that is the point: it is set by
	// editing the file, which is what the router's config renderer does
	// (ADR-008 §5 step 1).
	useCloudMeasurement(t, h, "external")
	h.env.Verifier = &liveCloudVerifier{h: h, hardware: hardware}
	return h, host, hardware
}

// useCloudMeasurement rewrites one endpoint's `trustedEvidence: []` line into
// `trust: cloud-measurement`.
func useCloudMeasurement(t *testing.T, h *harness, endpoint string) {
	t.Helper()
	body := h.config()
	anchor := "  - name: " + endpoint + "\n"
	start := strings.Index(body, anchor)
	if start < 0 {
		t.Fatalf("no endpoint %q in:\n%s", endpoint, body)
	}
	const pins = "    trustedEvidence: []\n"
	relative := strings.Index(body[start:], pins)
	if relative < 0 {
		t.Fatalf("endpoint %q has no empty pin list to replace:\n%s", endpoint, body)
	}
	at := start + relative
	updated := body[:at] + "    trust: cloud-measurement\n" + body[at+len(pins):]
	if err := os.WriteFile(h.configPath, []byte(updated), 0o600); err != nil {
		t.Fatalf("rewriting the config: %v", err)
	}
}

// listMeasurement appends a measurement to `attestedRoots.trustedMeasurements`
// through the real command, so the file the next verification reads is one the
// CLI wrote.
func listMeasurement(t *testing.T, h *harness, measurement string) {
	t.Helper()
	h.mustRun("trust", "measurements", "add", measurement)
}

// The mode's reason for existing, end to end against a live endpoint: an
// upstream nobody approved by digest is admitted once its cloud is on the list,
// and denied before that — with the fix named.
func TestACloudMeasurementEndpointAdmitsWithoutAnyDigestPin(t *testing.T) {
	// An empty registry: the operator's list is the only anchor there is.
	registry := &signingRegistry{signs: "none"}
	h, _, _ := cloudStand(t, registry)

	denied := h.run("verify", "external")
	if denied.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d, want %d\nstdout: %s\nstderr: %s",
			denied.code, cli.ExitDenied, denied.stdout, denied.stderr)
	}
	for _, want := range []string{"untrusted-root", cloudMeasurement, "trust measurements add"} {
		if !strings.Contains(denied.stdout, want) {
			t.Errorf("the denial does not mention %q:\n%s", want, denied.stdout)
		}
	}
	if registry.asked.Load() == 0 {
		t.Error("the registry was never consulted, so the denial did not come from a real lookup")
	}

	listMeasurement(t, h, cloudMeasurement)

	// Admitted with no `endpoint trust add` anywhere: the whole point of the
	// mode, and the thing the digest-pinned endpoint below still needs.
	after := h.mustRun("verify", "external")
	if !strings.Contains(after.stdout, "ADMITTED") {
		t.Fatalf("the endpoint was not admitted after listing its cloud:\n%s", after.stdout)
	}
	for _, want := range []string{
		"Endpoint trust mode",
		"a measurement admits a cloud, never a deployment",
		"Cloud measurement trusted",
	} {
		if !strings.Contains(after.stdout, want) {
			t.Errorf("the report does not say %q:\n%s", want, after.stdout)
		}
	}
	// And it never claims a pin it does not have.
	if strings.Contains(after.stdout, "Pinned for this endpoint") {
		t.Errorf("the report asks the digest question on an endpoint that pins nothing:\n%s", after.stdout)
	}

	report := h.mustRun("verify", "external", "--json")
	for _, want := range []string{
		`"trustMode": "cloud-measurement"`,
		`"measurementTrusted": true`,
		`"pinned": false`,
		`"rootAttested": true`,
	} {
		if !strings.Contains(report.stdout, want) {
			t.Errorf("the JSON report does not carry %s:\n%s", want, report.stdout)
		}
	}

	// The digest-pinned endpoint on the very same host is still unpinned, so it
	// is still denied: the measurement list did not quietly admit it.
	if got := h.run("verify", "pinned"); got.code != cli.ExitDenied {
		t.Fatalf("the digest-pinned endpoint was admitted without a pin: exit %d\n%s", got.code, got.stdout)
	}
	h.mustRun("endpoint", "trust", "add", "pinned", "--from-upstream", "--yes")
	if got := h.mustRun("verify", "pinned"); !strings.Contains(got.stdout, "Pinned for this endpoint  yes") {
		t.Errorf("the digest-pinned endpoint lost its own wording:\n%s", got.stdout)
	}

	// Removing the cloud from the list denies on the next check, not after the
	// verdict cache expires (ADR-003 §7) — which is what makes an admin edit a
	// control rather than a delayed one.
	h.mustRun("trust", "measurements", "rm", strings.ToUpper(cloudMeasurement))
	unlisted := h.run("verify", "external")
	if unlisted.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d after unlisting the cloud, want %d\n%s",
			unlisted.code, cli.ExitDenied, unlisted.stdout)
	}
	// `trustedMeasurements` is global, so unlisting the only anchor this stand
	// has takes its root down for every endpoint — including the pinned one,
	// whose pin is intact and whose root is now unvouched for. The denial has
	// to say so rather than blaming the pin.
	alsoDenied := h.run("verify", "pinned")
	if alsoDenied.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d for the pinned endpoint, want %d\n%s",
			alsoDenied.code, cli.ExitDenied, alsoDenied.stdout)
	}
	if !strings.Contains(alsoDenied.stdout, "untrusted-root") {
		t.Errorf("the pinned endpoint's denial is not about its root:\n%s", alsoDenied.stdout)
	}
}

// Ruling 2 on SUP-221 at the CLI: a cloud the Super Protocol registry *does*
// sign is still refused by a cloud-measurement endpoint until the operator
// lists it, while the same signature keeps admitting a digest-pinned endpoint's
// root exactly as SUP-139 shipped it.
func TestARegistrySignedCloudStillNeedsTheOperatorsList(t *testing.T) {
	registry := &signingRegistry{signs: cloudMeasurement}
	h, _, _ := cloudStand(t, registry)

	// The digest-pinned endpoint: the registry signature admits its root, so
	// pinning the deployment is all it needs. Unchanged semantics.
	h.mustRun("endpoint", "trust", "add", "pinned", "--from-upstream", "--yes")
	pinned := h.mustRun("verify", "pinned")
	if !strings.Contains(pinned.stdout, "ADMITTED") {
		t.Fatalf("a registry-signed root no longer admits a digest-pinned endpoint:\n%s", pinned.stdout)
	}
	if !strings.Contains(pinned.stdout, "attested (registry)") {
		t.Errorf("the anchor is not reported as the registry's:\n%s", pinned.stdout)
	}

	// The cloud-measurement endpoint, same host, same signature: denied.
	denied := h.run("verify", "external")
	if denied.code != cli.ExitDenied {
		t.Fatalf("a registry-signed cloud the operator never listed was admitted: exit %d\n%s",
			denied.code, denied.stdout)
	}
	for _, want := range []string{
		"not listed in attestedRoots.trustedMeasurements",
		"the list is the sole authority",
		"admits nothing on its own",
	} {
		if !strings.Contains(denied.stdout, want) {
			t.Errorf("the denial does not say %q:\n%s", want, denied.stdout)
		}
	}
	// The signature is still reported — it is display state, not an anchor here.
	if !strings.Contains(denied.stdout, "attested (registry)") {
		t.Errorf("the registry signature is no longer reported:\n%s", denied.stdout)
	}

	// Listing it is what admits it, and nothing else had to change.
	listMeasurement(t, h, cloudMeasurement)
	if got := h.mustRun("verify", "external"); !strings.Contains(got.stdout, "ADMITTED") {
		t.Fatalf("listing the cloud did not admit the endpoint:\n%s", got.stdout)
	}
}

// A pin on a cloud-measurement endpoint would not be enforced by anything, so
// the command refuses rather than writing a file that misleads its reader — and
// `endpoint list` says which mode each endpoint is in instead of reporting
// "0 pins (never admits)" for one that admits perfectly well.
func TestPinningIsRefusedOnACloudMeasurementEndpoint(t *testing.T) {
	h, _, _ := cloudStand(t, &signingRegistry{signs: "none"})
	listMeasurement(t, h, cloudMeasurement)
	before := h.config()

	refused := h.run("endpoint", "trust", "add", "external", "--from-upstream", "--yes")
	if refused.code == cli.ExitOK {
		t.Fatalf("a pin was written onto a cloud-measurement endpoint\n%s", h.config())
	}
	if !strings.Contains(refused.stderr, "trusts its cloud by measurement") {
		t.Errorf("stderr = %q, want the refusal to explain the mode", refused.stderr)
	}
	if h.config() != before {
		t.Errorf("the config changed despite the refusal:\n%s", h.config())
	}

	listed := h.mustRun("endpoint", "list")
	external := rowFor(t, listed.stdout, "external")
	if !strings.Contains(external, "trusts its cloud by measurement") {
		t.Errorf("endpoint list does not name the mode:\n%s", listed.stdout)
	}
	if strings.Contains(external, "never admits") {
		t.Errorf("endpoint list calls a cloud-measurement endpoint unusable:\n%s", listed.stdout)
	}
	// The digest-pinned endpoint keeps the wording that is true of it.
	if pinned := rowFor(t, listed.stdout, "pinned"); !strings.Contains(pinned, "0 (never admits)") {
		t.Errorf("the digest-pinned endpoint lost its own wording:\n%s", listed.stdout)
	}
}

// rowFor returns the table line describing one endpoint.
func rowFor(t *testing.T, table, endpoint string) string {
	t.Helper()
	for _, line := range strings.Split(table, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), endpoint+" ") {
			return line
		}
	}
	t.Fatalf("no row for %q in:\n%s", endpoint, table)
	return ""
}

// Emptying the measurement list leaves a configuration a cloud-measurement
// endpoint cannot run on at all — `config validate` refuses it and a restart
// would not come up. The command has to say so while it is still a warning,
// the way `endpoint trust rm` warns about its last pin.
func TestUnpinningTheLastMeasurementWarnsAboutTheEndpointsItStrands(t *testing.T) {
	h, _, _ := cloudStand(t, &signingRegistry{signs: "none"})
	listMeasurement(t, h, cloudMeasurement)

	removed := h.mustRun("trust", "measurements", "rm", cloudMeasurement)
	for _, want := range []string{"warning:", `"external"`, "trust their cloud by measurement", "will not start"} {
		if !strings.Contains(removed.stderr, want) {
			t.Errorf("stderr = %q\nwant it to mention %q", removed.stderr, want)
		}
	}
	// The warning is accurate: this config really does not validate any more.
	if got := h.run("config", "validate"); got.code == cli.ExitOK {
		t.Errorf("config validate accepted a config with no measurements:\n%s", got.stdout)
	}
}

// `endpoint discover` must not print a command the configuration refuses. On a
// cloud-measurement endpoint the thing to accept is the cloud, not a digest.
func TestDiscoverOffersTheMeasurementNotAPin(t *testing.T) {
	h, _, _ := cloudStand(t, &signingRegistry{signs: "none"})
	listMeasurement(t, h, cloudMeasurement)

	// Already admitted: there is nothing left to accept, so nothing is offered.
	admitted := h.mustRun("endpoint", "discover", "external")
	if strings.Contains(admitted.stdout, "endpoint trust add") {
		t.Errorf("discover offered a pin on a cloud-measurement endpoint:\n%s", admitted.stdout)
	}

	// Unlisted: the fix is the measurement, and discover names it.
	h.mustRun("trust", "measurements", "rm", cloudMeasurement)
	unlisted := h.run("endpoint", "discover", "external")
	if strings.Contains(unlisted.stdout, "endpoint trust add") {
		t.Errorf("discover offered a pin on a cloud-measurement endpoint:\n%s", unlisted.stdout)
	}

	// The digest-pinned endpoint keeps the offer that is right for it.
	listMeasurement(t, h, cloudMeasurement)
	pinned := h.mustRun("endpoint", "discover", "pinned")
	if !strings.Contains(pinned.stdout, "gatekeeper endpoint trust add pinned") {
		t.Errorf("discover no longer offers a pin on a digest-pinned endpoint:\n%s", pinned.stdout)
	}
}

// `endpoint trust add --from-upstream` has to refuse before the network round
// trip and the confirmation prompt, not after the operator has reviewed a
// report and answered a question for nothing.
func TestPinningIsRefusedBeforeAnyPrompt(t *testing.T) {
	h, _, _ := cloudStand(t, &signingRegistry{signs: "none"})
	listMeasurement(t, h, cloudMeasurement)

	// No --yes: a command that got as far as the prompt would block on stdin,
	// which the harness leaves empty.
	refused := h.run("endpoint", "trust", "add", "external", "--from-upstream")
	if refused.code != cli.ExitUsage {
		t.Fatalf("exit = %d, want %d (a usage refusal)\nstdout: %s\nstderr: %s",
			refused.code, cli.ExitUsage, refused.stdout, refused.stderr)
	}
	if !strings.Contains(refused.stderr, "trusts its cloud by measurement") {
		t.Errorf("stderr = %q, want the refusal to explain the mode", refused.stderr)
	}
	// Nothing was verified: the review panel the prompt would have shown — the
	// thing that costs a network round trip — never ran.
	for _, panel := range []string{"Trusted root", "Observed TLS leaf", "Certificate chain"} {
		if strings.Contains(refused.stdout+refused.stderr, panel) {
			t.Errorf("the endpoint was verified before the refusal (saw %q):\nstdout: %s\nstderr: %s",
				panel, refused.stdout, refused.stderr)
		}
	}
}
