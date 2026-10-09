//go:build teststand

// Command gatekeeper-teststand is the gatekeeper the external-endpoint e2e
// stand runs, with exactly one leg of the trust chain replaced: the
// attested-root check reads its verdict from a JSON file instead of from a CPU.
//
// # Why it has to exist
//
// A `trust: cloud-measurement` endpoint (ADR-008 §3) is admitted when the
// upstream cloud's root certificate carries a TEE evidence extension whose
// hardware report verifies against the CPU vendor's built-in root, commits to
// that certificate's own public key, and yields a launch measurement on the
// admin's list. The first three of those cannot be produced by a mock: a
// SEV-SNP report is signed by AMD, and the one real fixture the repository
// holds (pkg/attestation/attestedroot/testdata) is bound to a CA whose private
// key nobody outside the platform has, so no stand can issue leaves from it.
//
// Everything else in the loop is real and is exercised as such: the rendered
// configuration, the config loader and its validation, the evidence fetch over
// TLS, the JWS and chain verification, the channel binding against the leaf
// observed on the stand's own handshake, the freshness bounds, the Rego policy
// set including the built-in cloud-measurement clause, the trust store the
// admin list becomes, the verdict cache, the forced re-attestation, the
// connection pinning and the fail-closed drop of in-flight connections. The
// substituted leg is named in the verdict's own logs, so a report read out of
// the stand never claims hardware it did not see.
//
// # Why it is safe
//
// The `teststand` build tag. `go build ./cmd/...`, `.goreleaser.yaml` and
// `gatekeeper.dockerfile` all build without it, so a released binary does not
// contain this file; nothing under pkg/ references it, and no flag,
// environment variable or configuration key reaches it from a shipped build.
// The stand runs the real `gatekeeper-sidecar` supervising this binary, so the
// container entrypoint under test is the shipped one.
//
//	GATEKEEPER_TESTSTAND_ATTESTED_ROOT=/path/to/verdict.json \
//	  GATEKEEPER_TESTSTAND_REGISTRY_BASE_URL=http://127.0.0.1:port \
//	  gatekeeper-teststand --config /path/to/config.yaml run --headless
//
// The registry leg is the one part of the measurement check that *can* be
// real on a stand, so it is: with a registry base URL set (the variable, or
// `attestedRoots.registryBaseUrl` in the config), the fixture's measurement is
// looked up through the shipped [attestedroot.HTTPRegistry] — the same paths,
// folder map and pinned key as production — and `inRegistry` /
// `measurementSource` are what that lookup found, not what the fixture says.
package main

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/proxy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/verifier"
)

// FixtureEnv names the file the attested-root verdict is read from. It is
// required: a stand binary that silently fell back to the real hardware path
// would fail at a stage nobody is testing, with a reason that reads like a
// product bug.
const FixtureEnv = "GATEKEEPER_TESTSTAND_ATTESTED_ROOT"

// RegistryEnv names the signed-measurement registry the fixture's measurement
// is looked up in for real. Optional: without it (and without
// `attestedRoots.registryBaseUrl`) the fixture's own `inRegistry` and
// `measurementSource` are reported as written. It is an environment variable
// rather than only the config key because router-api renders the stand's
// config and does not emit that key.
const RegistryEnv = "GATEKEEPER_TESTSTAND_REGISTRY_BASE_URL"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr *os.File) int {
	fixture := os.Getenv(FixtureEnv)
	if fixture == "" {
		fmt.Fprintf(stderr, "gatekeeper-teststand: $%s is not set; there is no attested-root verdict to read\n",
			FixtureEnv)
		return cli.ExitUsage
	}
	registryURL := os.Getenv(RegistryEnv)

	ctx := context.Background()
	env := cli.Env{Stdin: os.Stdin, Stdout: stdout, Stderr: stderr}

	// A configuration that does not load is left entirely to the CLI: it prints
	// the diagnosis a user would get and exits with the code that goes with it,
	// and pre-empting that here would turn every config typo into "could not
	// build a supervisor".
	cfg, err := config.Load(config.Options{
		Environ:   os.Environ(),
		Overrides: config.Overrides{ConfigPath: configPathOf(args)},
	})
	if err == nil {
		supervisor, buildErr := proxy.New(ctx, proxy.Options{Config: cfg, Verifier: standVerifier(fixture, registryURL)})
		if buildErr != nil {
			fmt.Fprintf(stderr, "gatekeeper-teststand: %v\n", buildErr)
			return cli.ExitConfig
		}
		env.Supervisor = supervisor
	}

	return cli.Run(ctx, env, args)
}

// configPathOf picks `--config`/`-c` out of the argv, so that the supervisor
// built here and the one the CLI reloads on SIGHUP read the same file. An
// absent flag leaves the path to the environment layers, which
// [config.Load] resolves itself.
func configPathOf(args []string) string {
	for i, arg := range args {
		switch {
		case arg == "--config" || arg == "-c":
			if i+1 < len(args) {
				return args[i+1]
			}
		case len(arg) > len("--config=") && arg[:len("--config=")] == "--config=":
			return arg[len("--config="):]
		}
	}
	return ""
}

// standVerifier is the real pipeline with the attested-root anchor swapped for
// the fixture. It is a [proxy.VerifierFunc] rather than one built value because
// a SIGHUP rebuilds it against the reloaded configuration — which is the whole
// mechanism behind "an admin's trust-list edit takes effect on the next check"
// (ADR-008 §5).
//
// registryURL is [RegistryEnv]; empty defers to the config's own
// `attestedRoots.registryBaseUrl`, and both empty leaves the registry leg to
// the fixture.
func standVerifier(fixture, registryURL string) proxy.VerifierFunc {
	return func(ctx context.Context, cfg *config.Config) (status.Verifier, error) {
		built, err := verifier.New(ctx, cfg)
		if err != nil {
			return nil, err
		}
		roots := fileAttestedRoots{path: fixture}
		if base := orElse(registryURL, cfg.AttestedRootsRegistryBaseURL()); base != "" {
			// The shipped registry client, so the stand proves the real probe
			// order and the pinned key, not a stand-in. The timeout is the
			// stand's: a hung mirror must surface as a denial within one
			// re-attestation interval, not stall the loop.
			roots.registry = &attestedroot.HTTPRegistry{BaseURL: base, Client: &http.Client{Timeout: 10 * time.Second}}
			roots.registryURL = base
		}
		return built.WithAttestedRoots(roots), nil
	}
}

// standVerdict is the fixture document. It is deliberately the shape of an
// answer rather than of a report: the stand decides what the hardware would
// have said, and the rest of the chain is left to judge it.
type standVerdict struct {
	// Attested is whether the hardware leg held up. False stands in for a
	// report that did not verify at all.
	Attested bool `json:"attested"`
	// Reason explains a false Attested, as the real check's would.
	Reason string `json:"reason,omitempty"`
	// Measurement is the normalised mrEnclave hex the report yielded — the
	// value the admin list is compared against, and the one the stand rotates
	// to stand in for the upstream cloud redeploying on another image.
	Measurement string `json:"measurement"`
	// MeasurementSource and InRegistry are reported, never admitting: ruling 2
	// on SUP-221 makes the admin list the sole authority, and a stand that
	// could not say "the registry does sign this, and it still does not get in"
	// could not exercise that. They are read as written only when no registry
	// is configured; with one, the real lookup decides both and these are
	// ignored, so a stand cannot claim a signature the registry does not hold.
	MeasurementSource string `json:"measurementSource,omitempty"`
	InRegistry        bool   `json:"inRegistry,omitempty"`
	// NetworkType is the platform's own trusted/untrusted split. The live Swarm
	// root declares `untrusted`, which is the default here for the same reason
	// `attestedRoots.requireNetworkType` defaults to `any`.
	NetworkType  string `json:"networkType,omitempty"`
	EvidenceType string `json:"evidenceType,omitempty"`
}

// fileAttestedRoots answers every attested-root question from one file, re-read
// on each call.
//
// No caching, on purpose: the real [attestedroot.Verifier] caches because a
// verdict costs a firmware download, and the stand's costs a `stat`. Re-reading
// is what makes rewriting the file a visible event on the very next forced
// re-attestation, which is the rotate-measurement beat.
type fileAttestedRoots struct {
	path string
	// registry, when set, is consulted for the fixture's measurement instead
	// of trusting the fixture's inRegistry/measurementSource. registryURL is
	// only for the log line.
	registry    attestedroot.Registry
	registryURL string
}

func (f fileAttestedRoots) Verify(ctx context.Context, cert *x509.Certificate) (*attestedroot.Result, error) {
	if cert == nil {
		return nil, errors.New("gatekeeper-teststand: no certificate to verify")
	}

	raw, err := os.ReadFile(f.path)
	if err != nil {
		return denied("the stand's attested-root fixture %s could not be read: %v", f.path, err), nil
	}
	var document standVerdict
	if err := json.Unmarshal(raw, &document); err != nil {
		return denied("the stand's attested-root fixture %s is not JSON: %v", f.path, err), nil
	}
	measurement, err := hex.DecodeString(document.Measurement)
	if err != nil || (document.Measurement != "" && len(measurement) != 32) {
		return denied("the stand's attested-root fixture names measurement %q, which is not 32 bytes of hex",
			document.Measurement), nil
	}

	result := &attestedroot.Result{
		Attested:          document.Attested,
		Reason:            document.Reason,
		EvidenceTypeName:  orElse(document.EvidenceType, "AMD SEV-SNP"),
		NetworkType:       attestedroot.NetworkType(orElse(document.NetworkType, string(attestedroot.NetworkUntrusted))),
		ReportIntegrity:   document.Attested,
		KeyBinding:        document.Attested,
		Measurement:       measurement,
		InRegistry:        document.InRegistry,
		MeasurementSource: attestedroot.MeasurementSource(document.MeasurementSource),
		// MeasurementUnknown stays false even for a measurement the admin did
		// not list: it means "the registry was reached and holds nothing for
		// this image", which is a statement about the registry and not about
		// the list (see Result.NeedsMeasurementAnchor). Only a real lookup
		// (consultRegistry, below) is entitled to set it.
	}
	// The substitution is named in the verdict's own logs, which `/verdicts`,
	// `gatekeeper verify` and the dashboard all print. A report read out of the
	// stand therefore never claims a hardware check that did not happen.
	result.Logs = []string{fmt.Sprintf(
		"teststand: attested-root verdict read from %s — no hardware report was verified", f.path)}
	if f.registry != nil && result.Attested && len(result.Measurement) > 0 {
		f.consultRegistry(ctx, result, evidenceTypeOf(document.EvidenceType))
	}
	return result, nil
}

// consultRegistry replaces the fixture's word on the registry leg with a real
// lookup, mirroring [attestedroot.Verifier.AdmitMeasurement] for the one
// difference the stand has: the admin list is applied by the verifier that
// wraps this result, not here, so a miss is reported rather than denied —
// which is exactly the "rotated to an image nobody signed" beat. An outage is
// still a denial: the real check fails closed there, and so must the stand.
func (f fileAttestedRoots) consultRegistry(ctx context.Context, result *attestedroot.Result, evidence attestedroot.EvidenceType) {
	err := f.registry.Verify(ctx, result.Measurement, evidence)
	switch {
	case err == nil:
		result.InRegistry = true
		result.MeasurementSource = attestedroot.SourceRegistry
		result.MeasurementUnknown = false
		result.Logs = append(result.Logs, fmt.Sprintf("teststand: measurement %s is signed in the registry at %s (%s)",
			result.MeasurementHex(), f.registryURL, evidence))
	case errors.Is(err, attestedroot.ErrNotInRegistry):
		result.InRegistry = false
		result.MeasurementSource = ""
		result.MeasurementUnknown = true
		result.Logs = append(result.Logs, fmt.Sprintf("teststand: measurement %s is not in the registry at %s (%s)",
			result.MeasurementHex(), f.registryURL, evidence))
	default:
		result.Attested = false
		result.InRegistry = false
		result.MeasurementSource = ""
		result.Reason = fmt.Sprintf("the trusted registry could not be consulted: %v", err)
		result.Logs = append(result.Logs, "teststand: denied: "+result.Reason)
	}
}

// evidenceTypeOf maps the fixture's display name back to the type that picks
// the registry folders. The fixture spells the type the way the UI does
// (`attestedroot.EvidenceType.String`), and anything else — including the
// stand's historical default label — is the QEMU SEV-SNP folder.
func evidenceTypeOf(name string) attestedroot.EvidenceType {
	for t := attestedroot.EvidenceSevSnpQemu; t <= attestedroot.EvidenceSevSnpAzure; t++ {
		if t.String() == name {
			return t
		}
	}
	return attestedroot.EvidenceSevSnpQemu
}

func denied(format string, args ...any) *attestedroot.Result {
	reason := fmt.Sprintf(format, args...)
	return &attestedroot.Result{Reason: reason, Logs: []string{"teststand: " + reason}}
}

func orElse(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
