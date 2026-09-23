package cli_test

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
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

// unsignedMeasurement stands for the stand Denis keeps hitting: a Swarm cloud
// whose image was built outside the flow that publishes signatures to
// sp-vm/signatures, so the registry has nothing to say about it.
const unsignedMeasurement = "bb6962eb20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab"

// mockRegistry is the signed-measurement registry with nothing in it. Every
// lookup 404s, which is how `ErrNotInRegistry` is produced for real rather than
// stubbed — the paths probed, the statuses interpreted and the fall-through
// between layouts are all the production ones.
type mockRegistry struct {
	server *httptest.Server
	asked  atomic.Int64
}

func newMockRegistry(t *testing.T) *mockRegistry {
	t.Helper()
	r := &mockRegistry{}
	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		r.asked.Add(1)
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(r.server.Close)
	return r
}

func (r *mockRegistry) baseURL() string { return r.server.URL }

// hardwareReport stands in for the one leg of the attested-root check that
// cannot be produced in a test: a report signed by a real AMD or Intel key, and
// bound to a certificate this test minted. Everything after it is the production
// code — [attestedroot.Verifier.AdmitMeasurement] decides who vouches for the
// measurement, against the mock registry and the pins in the config file as it
// stands at this moment.
//
// The hardware half is covered where it can be: pkg/attestation/attestedroot
// runs the real Super Swarm Root CA evidence, and asserts that pinning its
// measurement rescues neither a tampered report nor a key binding that fails.
type hardwareReport struct {
	measurement string
	network     attestedroot.NetworkType
	// integrity false is what a tampered report looks like from here: the vendor
	// chain refuses it, and no measurement is ever derived.
	integrity bool

	cfg *config.Config
}

func (h *hardwareReport) Verify(ctx context.Context, _ *x509.Certificate) (*attestedroot.Result, error) {
	result := &attestedroot.Result{
		EvidenceType:     attestedroot.EvidenceSevSnpQemu,
		EvidenceTypeName: attestedroot.EvidenceSevSnpQemu.String(),
		NetworkType:      h.network,
		ReportIntegrity:  h.integrity,
		KeyBinding:       h.integrity,
		ReportData:       make([]byte, 64),
		CPUGeneration:    "Genoa",
		SecurityFields:   attestedroot.SecurityFields{SnpFirmwareTCB: 27, ReportVersion: 5},
	}
	if !h.integrity {
		result.Reason = "attestation report: the report is not signed by the certificate chain it carries"
		return result, nil
	}

	raw, err := hex.DecodeString(h.measurement)
	if err != nil {
		return nil, err
	}
	result.Measurement = raw

	anchors := &attestedroot.Verifier{
		Registry:            &attestedroot.HTTPRegistry{BaseURL: h.cfg.AttestedRootsRegistryBaseURL()},
		TrustedMeasurements: h.cfg.AttestedRootsTrustedMeasurements(),
		CacheTTL:            -1,
	}
	result.Attested = anchors.AdmitMeasurement(ctx, result, result.EvidenceType)
	return result, nil
}

// liveVerifier is the real pipeline, rebuilt from the config file on every call.
//
// Rebuilding matters: the commands under test edit that file, and a verifier
// built once would answer from the configuration as it was before the pin — the
// exact thing this test is here to catch.
type liveVerifier struct {
	h        *harness
	hardware *hardwareReport
}

func (l *liveVerifier) Verify(ctx context.Context, req status.VerifyRequest) (*status.Report, error) {
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

// attestedStand starts a live endpoint whose certificate authority nobody
// listed, with an empty registry behind it, and wires the CLI to the real
// pipeline over both.
func attestedStand(t *testing.T) (*harness, *evidenceHost, *hardwareReport, *mockRegistry) {
	t.Helper()
	registry := newMockRegistry(t)
	host := newEvidenceHost(t, testDigest("deployment A"))
	hardware := &hardwareReport{
		measurement: unsignedMeasurement,
		// What today's Swarm Cloud root actually declares.
		network:   attestedroot.NetworkUntrusted,
		integrity: true,
	}

	h := newHarness(t)
	// The bundle is signed against the real clock, so freshness is exercised.
	h.env.Now = time.Now
	h.mustRun("init")
	// Deliberately no `trust roots add`: needing it is the problem being fixed.
	h.mustRun("endpoint", "add", "router", "--listen", "127.0.0.1:8787", "--upstream", host.Upstream())
	h.appendConfig("attestedRoots:\n  registryBaseUrl: " + registry.baseURL() + "\n")
	h.env.Verifier = &liveVerifier{h: h, hardware: hardware}
	return h, host, hardware, registry
}

// setAttestedRoot rewrites one setting inside the config's `attestedRoots`
// block, for the knobs no command edits.
func setAttestedRoot(t *testing.T, h *harness, line string) {
	t.Helper()
	// Anchored on the newline so the commented-out example block `gatekeeper
	// init` writes is not the one edited.
	updated := strings.Replace(h.config(), "\nattestedRoots:\n", "\nattestedRoots:\n  "+line+"\n", 1)
	if updated == h.config() {
		t.Fatalf("no attestedRoots block to edit:\n%s", h.config())
	}
	if err := os.WriteFile(h.configPath, []byte(updated), 0o600); err != nil {
		t.Fatalf("rewriting the config: %v", err)
	}
}

// TestAnUnsignedMeasurementIsDeniedUntilTheOperatorPinsIt is SUP-139 end to end,
// against a live endpoint with nothing injected but the vendor signature:
//
// unsigned stand → denied, with the fix named → `trust measurements add
// --from-upstream` → the same endpoint verifies, reported as operator-pinned →
// unpin → denied again.
func TestAnUnsignedMeasurementIsDeniedUntilTheOperatorPinsIt(t *testing.T) {
	h, _, _, registry := attestedStand(t)

	// Nothing is pinned yet, and `list` says so with the command that fixes it.
	empty := h.mustRun("trust", "measurements", "list")
	if !strings.Contains(empty.stdout, "No pinned measurements") {
		t.Errorf("stdout = %q, want the empty list to say so", empty.stdout)
	}
	if !strings.Contains(empty.stdout, "trust measurements add --from-upstream") {
		t.Errorf("stdout = %q, want the empty list to name the command", empty.stdout)
	}

	denied := h.run("verify", "router")
	if denied.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d, want %d\nstdout: %s\nstderr: %s",
			denied.code, cli.ExitDenied, denied.stdout, denied.stderr)
	}
	for _, want := range []string{
		"untrusted-root",
		unsignedMeasurement,
		"NOT in trusted registry",
		// The denial Denis pasted, now ending in the two things he can do.
		"gatekeeper trust measurements add --from-upstream router",
		"gatekeeper trust roots add",
	} {
		if !strings.Contains(denied.stdout, want) {
			t.Errorf("the denial does not mention %q:\n%s", want, denied.stdout)
		}
	}
	if registry.asked.Load() == 0 {
		t.Error("the registry was never consulted, so the denial did not come from a real lookup")
	}

	// Pinning prints the full attested panel before it writes anything.
	pinned := h.mustRun("trust", "measurements", "add", "--from-upstream", "router", "--yes")
	for _, want := range []string{"Report integrity", "SNP firmware TCB", "Debug mode",
		"Ciphertext hiding", "Page swap disabled", "Network type", unsignedMeasurement} {
		if !strings.Contains(pinned.stderr, want) {
			t.Errorf("the review panel does not show %q:\n%s", want, pinned.stderr)
		}
	}
	if !strings.Contains(pinned.stdout, "Pinned measurement "+unsignedMeasurement) {
		t.Errorf("stdout = %q, want the pin confirmed", pinned.stdout)
	}
	if !strings.Contains(h.config(), unsignedMeasurement) {
		t.Fatalf("the measurement did not reach the config file:\n%s", h.config())
	}

	// The endpoint's own digest still has to be pinned — a measurement admits the
	// cloud, never the deployment.
	h.mustRun("endpoint", "trust", "add", "router", "--from-upstream", "--yes")

	after := h.mustRun("verify", "router")
	for _, want := range []string{
		"ADMITTED",
		"attested (operator-pinned), not from trustedRoots",
		"you pinned this measurement; Super Protocol has not signed it",
	} {
		if !strings.Contains(after.stdout, want) {
			t.Errorf("the verified report does not say %q:\n%s", want, after.stdout)
		}
	}

	report := h.mustRun("verify", "router", "--json")
	for _, want := range []string{
		`"measurementSource": "operator-pinned"`,
		`"inRegistry": false`,
		`"rootAttested": true`,
	} {
		if !strings.Contains(report.stdout, want) {
			t.Errorf("the JSON report does not carry %s:\n%s", want, report.stdout)
		}
	}

	// And it is reversible: unpinning puts the denial back, on the next check
	// rather than after the verdict cache expires.
	h.mustRun("trust", "measurements", "rm", strings.ToUpper(unsignedMeasurement))
	if got := h.run("verify", "router"); got.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d after unpinning, want %d\nstdout: %s", got.code, cli.ExitDenied, got.stdout)
	}
}

// TestAPinnedMeasurementDoesNotRescueATamperedReport is the guarantee the escape
// hatch is sold on, at the CLI: with the measurement pinned and everything else
// unchanged, a report the vendor chain refuses is still denied, and the pin
// cannot be re-established from it either.
func TestAPinnedMeasurementDoesNotRescueATamperedReport(t *testing.T) {
	h, _, hardware, _ := attestedStand(t)
	h.mustRun("trust", "measurements", "add", unsignedMeasurement)
	h.mustRun("endpoint", "trust", "add", "router", "--from-upstream", "--yes")
	if got := h.mustRun("verify", "router"); !strings.Contains(got.stdout, "ADMITTED") {
		t.Fatalf("the pinned stand does not verify to begin with:\n%s", got.stdout)
	}

	hardware.integrity = false

	tampered := h.run("verify", "router")
	if tampered.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d for a tampered report, want %d\nstdout: %s",
			tampered.code, cli.ExitDenied, tampered.stdout)
	}
	for _, want := range []string{"NOT attested", "Report integrity    FAILED"} {
		if !strings.Contains(tampered.stdout, want) {
			t.Errorf("the denial does not show %q:\n%s", want, tampered.stdout)
		}
	}

	// Nor may the operator pin their way out of it: there is no measurement to
	// accept, and the report that would have produced one did not hold up.
	refused := h.run("trust", "measurements", "add", "--from-upstream", "router", "--yes")
	if refused.code != cli.ExitDenied {
		t.Errorf("add --from-upstream exit = %d for a tampered report, want %d\nstderr: %s",
			refused.code, cli.ExitDenied, refused.stderr)
	}
	if !strings.Contains(refused.stderr, "does not verify against the CPU vendor's root") {
		t.Errorf("stderr = %q, want the refusal to name the leg that failed", refused.stderr)
	}
}

// TestRequireNetworkTypeOutranksAPin is the other leg a pin must not replace:
// today's Swarm root declares `untrusted`, and an operator who asked for
// `trusted` still gets a denial with the measurement pinned.
func TestRequireNetworkTypeOutranksAPin(t *testing.T) {
	h, _, _, _ := attestedStand(t)
	h.mustRun("trust", "measurements", "add", unsignedMeasurement)
	setAttestedRoot(t, h, "requireNetworkType: trusted")

	got := h.run("verify", "router")
	if got.code != cli.ExitDenied {
		t.Fatalf("verify exit = %d, want %d\nstdout: %s\nstderr: %s\nconfig:\n%s",
			got.code, cli.ExitDenied, got.stdout, got.stderr, h.config())
	}
	if !strings.Contains(got.stdout, "requireNetworkType") {
		t.Errorf("the denial does not name the setting that refused the root:\n%s", got.stdout)
	}
}

// TestMeasurementCommandsRunOnAnIncompleteConfig is the SUP-111 rule applied to
// the new commands: `endpoint add` leaves a config `run` would refuse, and the
// commands that finish it must not be the ones that need it finished.
func TestMeasurementCommandsRunOnAnIncompleteConfig(t *testing.T) {
	h, _, _, _ := attestedStand(t)

	// This config has an endpoint with no pins — `config validate` says so.
	if got := h.run("config", "validate"); got.code != cli.ExitConfig {
		t.Fatalf("config validate exit = %d, want the config reported as unfinished (%d)", got.code, cli.ExitConfig)
	}
	for _, args := range [][]string{
		{"trust", "measurements", "list"},
		{"trust", "measurements", "list", "--json"},
		{"trust", "measurements", "add", unsignedMeasurement},
		{"trust", "measurements", "rm", unsignedMeasurement},
	} {
		if got := h.run(args...); got.code != cli.ExitOK {
			t.Errorf("gatekeeper %s: exit %d, want 0\nstderr: %s",
				strings.Join(args, " "), got.code, got.stderr)
		}
	}
}

// TestMeasurementAddRejectsWhatItCannotCompare keeps the config free of values
// no verifier could ever match, and says which argument was wrong.
func TestMeasurementAddRejectsWhatItCannotCompare(t *testing.T) {
	h, _, _, _ := attestedStand(t)

	for _, tc := range []struct {
		args []string
		want string
	}{
		{args: []string{"trust", "measurements", "add", "deadbeef"}, want: "expected 32"},
		{args: []string{"trust", "measurements", "add"}, want: "--from-upstream"},
		{
			args: []string{"trust", "measurements", "add", unsignedMeasurement, "--from-upstream", "router"},
			want: "not both",
		},
	} {
		got := h.run(tc.args...)
		if got.code != cli.ExitUsage {
			t.Errorf("gatekeeper %s: exit %d, want %d", strings.Join(tc.args, " "), got.code, cli.ExitUsage)
		}
		if !strings.Contains(got.stderr, tc.want) {
			t.Errorf("stderr = %q, want it to mention %q", got.stderr, tc.want)
		}
	}
	if strings.Contains(h.config(), "deadbeef") {
		t.Errorf("a rejected measurement reached the file anyway:\n%s", h.config())
	}
}

// TestMeasurementRmRefusesWhatWasNeverPinned keeps a typo from looking like a
// successful removal.
func TestMeasurementRmRefusesWhatWasNeverPinned(t *testing.T) {
	h, _, _, _ := attestedStand(t)
	got := h.run("trust", "measurements", "rm", unsignedMeasurement)
	if got.code != cli.ExitError {
		t.Fatalf("exit = %d, want %d\nstderr: %s", got.code, cli.ExitError, got.stderr)
	}
	if !strings.Contains(got.stderr, "is not pinned") {
		t.Errorf("stderr = %q, want it to say the measurement was not pinned", got.stderr)
	}
}
