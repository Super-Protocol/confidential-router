package attestedroot

import (
	"context"
	"encoding/hex"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

// registryLayoutDir is a copy of the real registry's directory layout — the
// `signatures/` tree of Super-Protocol/sp-vm, with a few entries per folder;
// see testdata/README.md. Served as files rather than as a path map so that a
// test exercises the URLs the code builds against the names the platform
// actually publishes under, folders SUP-251 added included.
const registryLayoutDir = "testdata/registry"

// Measurements the layout fixture holds, by the folder each is signed in.
// Each is the hex half of a file name under testdata/registry.
const (
	// layoutAzureSevSnp is the build-449 Azure SEV-SNP image, the one the
	// apps-448 root fixture attests (apps448Measurement). Signed only under
	// sev-snp-azure/pre-release.
	layoutAzureSevSnp = apps448Measurement
	// layoutAzureTdx is signed only under tdx-azure/pre-release.
	layoutAzureTdx = "5690b13a922698ece1e9b64512910b58f1d60e338ff1d9e16f26cf631cdf409a"
	// layoutSevSnpLatest is the one entry of sev-snp/latest.
	layoutSevSnpLatest = "c9e148780ef1aa945a2b8578926dc9faaf1fc37038bce04e9613037f1fe42442"
	// layoutTdxPreRelease is signed only under tdx/pre-release.
	layoutTdxPreRelease = "00359cf3e2b4e7070720b180bde8fe7dbb2e60f74b02c86d29ea98b99f4072b1"
	// layoutLegacy is signed only as a flat `mrenclave-<hex>.sign` at the top.
	layoutLegacy = "0049265a6ab64a26012521f82bc13987cab871ae1ea2dc7e4113c0fbd44ddb66"
)

// requestLog records the paths a layout server was asked for, in order, so a
// test can assert not just the verdict but which folders were consulted on the
// way to it.
type requestLog struct {
	mu    sync.Mutex
	paths []string
}

func (l *requestLog) record(path string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.paths = append(l.paths, path)
}

func (l *requestLog) seen() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.paths...)
}

// serveLayout serves a registry directory the way raw.githubusercontent.com
// serves the real one: the file at the path, 404 for anything absent.
func serveLayout(t *testing.T, dir string) (*HTTPRegistry, *requestLog) {
	t.Helper()
	log := &requestLog{}
	files := http.FileServer(http.Dir(dir))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.record(r.URL.Path)
		files.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	return &HTTPRegistry{BaseURL: server.URL, Client: server.Client()}, log
}

// layoutWithout copies the layout fixture into a scratch directory and removes
// the named entries, for the tests about a registry that lacks something.
func layoutWithout(t *testing.T, entries ...string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.CopyFS(dir, os.DirFS(registryLayoutDir)); err != nil {
		t.Fatalf("copying the layout fixture: %v", err)
	}
	for _, entry := range entries {
		if err := os.Remove(filepath.Join(dir, filepath.FromSlash(entry))); err != nil {
			t.Fatalf("removing %s from the copy: %v", entry, err)
		}
	}
	return dir
}

func entryPath(folder, channel, measurement string) string {
	return "/" + folder + "/" + channel + "/mrenclave-" + measurement + ".json"
}

func legacyPath(measurement string) string {
	return "/mrenclave-" + measurement + ".sign"
}

func mustMeasurement(t *testing.T, hexValue string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(hexValue)
	if err != nil {
		t.Fatalf("%q is not hex: %v", hexValue, err)
	}
	return raw
}

func assertProbes(t *testing.T, log *requestLog, want ...string) {
	t.Helper()
	got := log.seen()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("registry probes:\n  got  %v\n  want %v", got, want)
	}
}

// TestRegistryLayoutFindsAzureSevSnpInItsOwnFolder is the SUP-251 path: an
// Azure SEV-SNP measurement lives in the folder attestation-common's
// SignatureFolderMap names for it, and the lookup tries that folder's release
// channel before the pre-release one it is actually in. A regression that
// looked in the base folder only, or in pre-release first, fails here.
func TestRegistryLayoutFindsAzureSevSnpInItsOwnFolder(t *testing.T) {
	registry, log := serveLayout(t, registryLayoutDir)

	err := registry.Verify(context.Background(), mustMeasurement(t, layoutAzureSevSnp), EvidenceSevSnpAzure)
	if err != nil {
		t.Fatalf("the Azure SEV-SNP measurement was rejected: %v", err)
	}
	assertProbes(t, log,
		entryPath("sev-snp-azure", "latest", layoutAzureSevSnp),
		entryPath("sev-snp-azure", "pre-release", layoutAzureSevSnp),
	)
}

// TestRegistryLayoutAzureSevSnpFallsBackToSevSnp covers the other half of the
// folder map: a measurement signed before the per-platform folders existed is
// still found for an Azure root, in the base folder, after the Azure folder
// came up empty.
func TestRegistryLayoutAzureSevSnpFallsBackToSevSnp(t *testing.T) {
	registry, log := serveLayout(t, registryLayoutDir)

	err := registry.Verify(context.Background(), mustMeasurement(t, layoutSevSnpLatest), EvidenceSevSnpAzure)
	if err != nil {
		t.Fatalf("a measurement signed in the base sev-snp folder was rejected for Azure: %v", err)
	}
	assertProbes(t, log,
		entryPath("sev-snp-azure", "latest", layoutSevSnpLatest),
		entryPath("sev-snp-azure", "pre-release", layoutSevSnpLatest),
		entryPath("sev-snp", "latest", layoutSevSnpLatest),
	)
}

// TestRegistryLayoutAzureTdx is the same two properties for the TDX family:
// its own folder first, the base tdx folder as the fallback.
func TestRegistryLayoutAzureTdx(t *testing.T) {
	t.Run("own folder", func(t *testing.T) {
		registry, log := serveLayout(t, registryLayoutDir)
		if err := registry.Verify(context.Background(), mustMeasurement(t, layoutAzureTdx), EvidenceTdxAzure); err != nil {
			t.Fatalf("the Azure TDX measurement was rejected: %v", err)
		}
		assertProbes(t, log,
			entryPath("tdx-azure", "latest", layoutAzureTdx),
			entryPath("tdx-azure", "pre-release", layoutAzureTdx),
		)
	})
	t.Run("falls back to tdx", func(t *testing.T) {
		registry, log := serveLayout(t, registryLayoutDir)
		if err := registry.Verify(context.Background(), mustMeasurement(t, layoutTdxPreRelease), EvidenceTdxAzure); err != nil {
			t.Fatalf("a measurement signed in the base tdx folder was rejected for Azure: %v", err)
		}
		assertProbes(t, log,
			entryPath("tdx-azure", "latest", layoutTdxPreRelease),
			entryPath("tdx-azure", "pre-release", layoutTdxPreRelease),
			entryPath("tdx", "latest", layoutTdxPreRelease),
			entryPath("tdx", "pre-release", layoutTdxPreRelease),
		)
	})
}

// TestRegistryLayoutQemuNeverConsultsTheCloudFolders is the parity rule with
// attestation-common's SignatureFolderMap in the other direction: the cloud
// folders are reached only from the cloud evidence types. A QEMU root whose
// measurement is signed solely for Azure is a miss, and the request log proves
// the Azure folder was never even asked — a lookup that widened to "any folder
// of the same technology" would admit images across platforms.
func TestRegistryLayoutQemuNeverConsultsTheCloudFolders(t *testing.T) {
	for _, tc := range []struct {
		name        string
		measurement string
		evidence    EvidenceType
		base, cloud string
	}{
		{"sev-snp", layoutAzureSevSnp, EvidenceSevSnpQemu, "sev-snp", "sev-snp-azure"},
		{"tdx", layoutAzureTdx, EvidenceTdxQemu, "tdx", "tdx-azure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			registry, log := serveLayout(t, registryLayoutDir)

			err := registry.Verify(context.Background(), mustMeasurement(t, tc.measurement), tc.evidence)
			if !errors.Is(err, ErrNotInRegistry) {
				t.Fatalf("error = %v, want ErrNotInRegistry for a cloud-only measurement under %s", err, tc.evidence)
			}
			assertProbes(t, log,
				entryPath(tc.base, "latest", tc.measurement),
				entryPath(tc.base, "pre-release", tc.measurement),
				legacyPath(tc.measurement),
			)
			for _, path := range log.seen() {
				if strings.HasPrefix(path, "/"+tc.cloud+"/") {
					t.Errorf("the %s folder was consulted for %s evidence: %s", tc.cloud, tc.evidence, path)
				}
			}
		})
	}
}

// TestRegistryLayoutHonoursTheLegacyFlatFileLast keeps the pre-folder layout
// working — a raw PKCS#1 signature at the top of the tree — and keeps it where
// the platform's client has it: after every folder the type maps to.
func TestRegistryLayoutHonoursTheLegacyFlatFileLast(t *testing.T) {
	registry, log := serveLayout(t, registryLayoutDir)

	err := registry.Verify(context.Background(), mustMeasurement(t, layoutLegacy), EvidenceSevSnpAzure)
	if err != nil {
		t.Fatalf("the legacy flat signature was rejected: %v", err)
	}
	assertProbes(t, log,
		entryPath("sev-snp-azure", "latest", layoutLegacy),
		entryPath("sev-snp-azure", "pre-release", layoutLegacy),
		entryPath("sev-snp", "latest", layoutLegacy),
		entryPath("sev-snp", "pre-release", layoutLegacy),
		legacyPath(layoutLegacy),
	)
}

// TestRegistryLayoutRejectsAnEntryRenamedForAnotherMeasurement is the
// substitution the directory layout invites: a real, validly signed entry
// copied under another measurement's file name. The signature is over the
// original measurement's bytes, so the pinned key refuses it — and it is a
// refusal, not a miss, because somebody served a document that lies.
func TestRegistryLayoutRejectsAnEntryRenamedForAnotherMeasurement(t *testing.T) {
	other := mustMeasurement(t, layoutAzureSevSnp)
	other[0] ^= 0xff
	otherHex := hex.EncodeToString(other)

	dir := layoutWithout(t)
	genuine := filepath.Join(dir, "sev-snp-azure", "pre-release", "mrenclave-"+layoutAzureSevSnp+".json")
	renamed := filepath.Join(dir, "sev-snp-azure", "pre-release", "mrenclave-"+otherHex+".json")
	document, err := os.ReadFile(genuine)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(renamed, document, 0o600); err != nil {
		t.Fatal(err)
	}
	registry, log := serveLayout(t, dir)

	err = registry.Verify(context.Background(), other, EvidenceSevSnpAzure)
	if err == nil {
		t.Fatal("a signature over a different measurement was accepted")
	}
	if errors.Is(err, ErrNotInRegistry) {
		t.Fatalf("a mis-filed signature was reported as a miss: %v", err)
	}
	// The lookup stopped at the first hit, and that hit is the one that lied.
	assertProbes(t, log,
		entryPath("sev-snp-azure", "latest", otherHex),
		entryPath("sev-snp-azure", "pre-release", otherHex),
	)
}

// TestRegistryLayoutEveryEntryVerifies walks the fixture and checks every
// entry in a folder the lookup can reach, under an evidence type that reaches
// it. It is what keeps the fixture honest: a file that was edited, truncated or
// re-encoded on its way into the repository fails here, not in a test whose
// assertion it silently satisfies. It also shows the two-byte test entries the
// registry publishes are real signatures, not junk the code has to special-case.
func TestRegistryLayoutEveryEntryVerifies(t *testing.T) {
	reachedBy := map[string]EvidenceType{
		"sev-snp":       EvidenceSevSnpQemu,
		"sev-snp-azure": EvidenceSevSnpAzure,
		"tdx":           EvidenceTdxQemu,
		"tdx-azure":     EvidenceTdxAzure,
	}
	registry, _ := serveLayout(t, registryLayoutDir)

	checked := 0
	err := fs.WalkDir(os.DirFS(registryLayoutDir), ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		name := d.Name()
		hexValue := strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(name, "mrenclave-"), ".json"), ".sign")
		evidence, reachable := EvidenceSevSnpQemu, strings.HasSuffix(name, ".sign")
		if folder := strings.SplitN(path, "/", 2)[0]; !reachable {
			evidence, reachable = reachedBy[folder]
		}
		if !reachable {
			return nil
		}
		t.Run(path, func(t *testing.T) {
			if err := registry.Verify(context.Background(), mustMeasurement(t, hexValue), evidence); err != nil {
				t.Errorf("rejected: %v", err)
			}
		})
		checked++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 15 {
		t.Fatalf("only %d entries were reachable; the fixture is not the layout this test expects", checked)
	}
}

// TestRegistryFoldersMatchTheLayout pins the folder map to the names that
// exist in the registry, so a rename on either side — a new per-platform
// folder in sp-vm, or a typo here — is a test failure rather than a cloud that
// is silently never found. The folders the map leaves out are listed too:
// they hold measurements of other products, and reading them for a VM root
// would be a bug of its own.
func TestRegistryFoldersMatchTheLayout(t *testing.T) {
	cases := map[EvidenceType][]string{
		EvidenceUnspecified: nil,
		EvidenceSevSnpQemu:  {"sev-snp"},
		EvidenceTdxQemu:     {"tdx"},
		EvidenceTdxGCP:      {"tdx-google", "tdx"},
		EvidenceTdxAzure:    {"tdx-azure", "tdx"},
		EvidenceSevSnpAzure: {"sev-snp-azure", "sev-snp"},
	}
	// tdx-google has no entry in the registry yet; it is the one folder of
	// the map that is named ahead of being published to.
	unpublished := map[string]bool{"tdx-google": true}

	entries, err := os.ReadDir(registryLayoutDir)
	if err != nil {
		t.Fatal(err)
	}
	inLayout := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() {
			inLayout[entry.Name()] = true
		}
	}

	mapped := map[string]bool{}
	for evidence, want := range cases {
		got := evidence.registryFolders()
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%v.registryFolders() = %v, want %v", evidence, got, want)
		}
		for _, folder := range got {
			mapped[folder] = true
			if !inLayout[folder] && !unpublished[folder] {
				t.Errorf("%v maps to folder %q, which the registry layout does not have", evidence, folder)
			}
		}
	}

	var unmapped []string
	for folder := range inLayout {
		if !mapped[folder] {
			unmapped = append(unmapped, folder)
		}
	}
	sort.Strings(unmapped)
	if want := []string{"arm-v9", "pki-solution"}; strings.Join(unmapped, ",") != strings.Join(want, ",") {
		t.Errorf("layout folders no evidence type reads = %v, want %v", unmapped, want)
	}
}

// TestVerifyRealAzureSevSnpRootAdmittedByRegistryLayout is the whole chain
// over the real Azure root with the real registry layout and an empty trust
// store: nothing is pinned, and the root is admitted because the registry
// fetch found Super Protocol's signature in sev-snp-azure/pre-release. It is
// the Go-level proof behind SUP-255's acceptance criterion — the Registry-
// signed badge for 74c75a0b… comes from the fetch, not from a local pin.
func TestVerifyRealAzureSevSnpRootAdmittedByRegistryLayout(t *testing.T) {
	registry, log := serveLayout(t, registryLayoutDir)
	verifier := &Verifier{Registry: registry, Now: apps448Clock, CacheTTL: -1}

	result, err := verifier.Verify(context.Background(), apps448Root(t))
	if err != nil {
		t.Fatalf("Verify returned an error: %v", err)
	}
	if !result.Attested {
		t.Fatalf("attested = false: %s", result.Reason)
	}
	if !result.InRegistry || result.MeasurementSource != SourceRegistry {
		t.Errorf("inRegistry = %v, source = %q; want the registry to have admitted the root",
			result.InRegistry, result.MeasurementSource)
	}
	if result.MeasurementUnknown || result.NeedsMeasurementAnchor() {
		t.Errorf("measurementUnknown = %v, needsAnchor = %v for an admitted root",
			result.MeasurementUnknown, result.NeedsMeasurementAnchor())
	}
	if got := result.MeasurementHex(); got != apps448Measurement {
		t.Errorf("measurement = %s, want %s", got, apps448Measurement)
	}
	if got, want := result.EvidenceType, EvidenceSevSnpAzure; got != want {
		t.Errorf("evidence type = %v, want %v", got, want)
	}
	assertProbes(t, log,
		entryPath("sev-snp-azure", "latest", apps448Measurement),
		entryPath("sev-snp-azure", "pre-release", apps448Measurement),
	)
}

// TestVerifyRealAzureSevSnpRootDeniedWhenTheRegistryLacksIt is the negative
// of the test above with one file gone: the hardware leg still verifies, the
// measurement is still reported, and the verdict is the "nobody vouches for
// this image" denial that pinning clears — not a hardware failure, and not a
// registry outage.
func TestVerifyRealAzureSevSnpRootDeniedWhenTheRegistryLacksIt(t *testing.T) {
	dir := layoutWithout(t, "sev-snp-azure/pre-release/mrenclave-"+apps448Measurement+".json")
	registry, log := serveLayout(t, dir)
	verifier := &Verifier{Registry: registry, Now: apps448Clock, CacheTTL: -1}

	result, err := verifier.Verify(context.Background(), apps448Root(t))
	if err != nil {
		t.Fatalf("Verify returned an error: %v", err)
	}
	if result.Attested || result.InRegistry || result.MeasurementSource != "" {
		t.Fatalf("attested = %v, inRegistry = %v, source = %q for a measurement the registry does not hold",
			result.Attested, result.InRegistry, result.MeasurementSource)
	}
	if !result.ReportIntegrity || !result.KeyBinding {
		t.Errorf("integrity = %v, key binding = %v; the hardware leg should still hold",
			result.ReportIntegrity, result.KeyBinding)
	}
	if got := result.MeasurementHex(); got != apps448Measurement {
		t.Errorf("measurement = %s, want %s reported even on denial", got, apps448Measurement)
	}
	if !result.MeasurementUnknown || !result.NeedsMeasurementAnchor() {
		t.Errorf("measurementUnknown = %v, needsAnchor = %v; want the pin-able denial",
			result.MeasurementUnknown, result.NeedsMeasurementAnchor())
	}
	if !strings.Contains(result.Reason, "not in the Super Protocol trusted registry") {
		t.Errorf("reason = %q, want it to name the registry miss", result.Reason)
	}
	// Every folder the type maps to was tried, and then the legacy name.
	assertProbes(t, log,
		entryPath("sev-snp-azure", "latest", apps448Measurement),
		entryPath("sev-snp-azure", "pre-release", apps448Measurement),
		entryPath("sev-snp", "latest", apps448Measurement),
		entryPath("sev-snp", "pre-release", apps448Measurement),
		legacyPath(apps448Measurement),
	)
}
