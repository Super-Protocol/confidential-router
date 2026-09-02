package attestedroot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot/internal/snpmeasure"
)

// Defaults of the artefact sources a SEV-SNP measurement is rebuilt from. The
// firmware is content-addressed and the manifest is release-tagged, so neither
// source has to be trusted: a substituted file fails the checksum, and a
// substituted manifest produces a launch digest the hardware report does not
// confirm.
const (
	// DefaultVMManifestBaseURL is the GitHub releases API the per-build
	// `vm.json` manifest is published under.
	DefaultVMManifestBaseURL = "https://api.github.com/repos/Super-Protocol/sp-vm/releases/tags"
	// DefaultFirmwareEndpoint is the S3-compatible gateway the OVMF images live
	// behind.
	DefaultFirmwareEndpoint = "https://gateway.storjshare.io"
	// vmManifestAsset is the release asset that describes a build.
	vmManifestAsset = "vm.json"
)

// Public read-only credentials for the firmware bucket. They are published by
// the platform (they are compiled into @super-protocol/attestation-common) and
// grant nothing but GetObject on world-readable build artefacts; the firmware
// they fetch is verified by checksum afterwards, so they are a transport
// detail, not a secret.
const (
	defaultFirmwareAccessKeyID = "jxekrow2wxmjps6pr2jv22hamtha"
	defaultFirmwareSecretKey   = "jztnpl532njcljtdolnpbszq66lgqmwmgkbh747342hwc72grkohi"
	defaultFirmwareRegion      = "us-east-1"
)

// emptyInitrdDigest is SHA-256 of an empty byte string — what a build with no
// initrd contributes to the kernel hashes table.
var emptyInitrdDigest = mustHash32("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")

// BuildArtifacts is everything about one sp-vm build that a launch measurement
// needs, once the 4 MiB firmware image has been reduced away.
type BuildArtifacts struct {
	Firmware   *snpmeasure.Firmware
	KernelHash [32]byte
	InitrdHash [32]byte
}

// ArtifactSource resolves an sp-vm build identifier to its artefacts.
type ArtifactSource interface {
	Artifacts(ctx context.Context, build string) (*BuildArtifacts, error)
}

// HTTPArtifactSource is the real source: a release manifest over HTTPS and the
// firmware image out of the platform's object store.
//
// Results are memoised per build for the process's lifetime. A build is
// immutable — the manifest names checksums, and the checksums are enforced —
// so re-fetching four megabytes on every re-attestation would buy nothing.
type HTTPArtifactSource struct {
	// ManifestBaseURL defaults to [DefaultVMManifestBaseURL].
	ManifestBaseURL string
	// Client defaults to http.DefaultClient.
	Client *http.Client
	// Firmware overrides where OVMF images are fetched from.
	Firmware FirmwareStore

	// mu guards cache and is deliberately held across the fetch: two
	// verifications of the same build must not both download the firmware.
	mu    sync.Mutex
	cache map[string]*BuildArtifacts
}

// vmManifest is the subset of the release's `vm.json` the measurement uses.
type vmManifest struct {
	Kernel struct {
		SHA256 string `json:"sha256"`
	} `json:"kernel"`
	Initrd *struct {
		SHA256 string `json:"sha256"`
	} `json:"initrd"`
	// BiosAMD is preferred over Bios: a host with both publishes the AMD image
	// under the specific key, and measuring the wrong one would fail loudly but
	// pointlessly.
	BiosAMD *firmwareRef `json:"bios_amd"`
	Bios    *firmwareRef `json:"bios"`
}

type firmwareRef struct {
	SHA256   string `json:"sha256"`
	Bucket   string `json:"bucket"`
	Prefix   string `json:"prefix"`
	Filename string `json:"filename"`
}

// Artifacts implements [ArtifactSource].
func (s *HTTPArtifactSource) Artifacts(ctx context.Context, build string) (*BuildArtifacts, error) {
	if build == "" {
		return nil, errors.New("artifacts: the evidence names no sp-vm build")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cached, ok := s.cache[build]; ok {
		return cached, nil
	}

	manifest, err := s.manifest(ctx, build)
	if err != nil {
		return nil, err
	}
	firmwareRef := manifest.BiosAMD
	if firmwareRef == nil {
		firmwareRef = manifest.Bios
	}
	if firmwareRef == nil {
		return nil, fmt.Errorf("artifacts: build %q publishes no OVMF image", build)
	}

	kernelHash, err := hash32(manifest.Kernel.SHA256)
	if err != nil {
		return nil, fmt.Errorf("artifacts: build %q kernel sha256: %w", build, err)
	}
	initrdHash := emptyInitrdDigest
	if manifest.Initrd != nil {
		if initrdHash, err = hash32(manifest.Initrd.SHA256); err != nil {
			return nil, fmt.Errorf("artifacts: build %q initrd sha256: %w", build, err)
		}
	}
	expected, err := hash32(firmwareRef.SHA256)
	if err != nil {
		return nil, fmt.Errorf("artifacts: build %q OVMF sha256: %w", build, err)
	}

	store := s.Firmware
	if store == nil {
		store = DefaultFirmwareStore()
	}
	prefix := strings.TrimSuffix(firmwareRef.Prefix, "/")
	image, err := store.Get(ctx, firmwareRef.Bucket, prefix+"/"+firmwareRef.Filename)
	if err != nil {
		return nil, fmt.Errorf("artifacts: build %q OVMF: %w", build, err)
	}
	if got := sha256.Sum256(image); got != expected {
		return nil, fmt.Errorf("artifacts: build %q OVMF hashes to %x, but its manifest says %x", build, got, expected)
	}

	firmware, err := snpmeasure.ParseFirmware(image)
	if err != nil {
		return nil, fmt.Errorf("artifacts: build %q OVMF: %w", build, err)
	}

	out := &BuildArtifacts{Firmware: firmware, KernelHash: kernelHash, InitrdHash: initrdHash}
	if s.cache == nil {
		s.cache = map[string]*BuildArtifacts{}
	}
	s.cache[build] = out
	return out, nil
}

func (s *HTTPArtifactSource) manifest(ctx context.Context, build string) (*vmManifest, error) {
	base := strings.TrimSuffix(s.ManifestBaseURL, "/")
	if base == "" {
		base = DefaultVMManifestBaseURL
	}
	client := s.Client
	if client == nil {
		client = http.DefaultClient
	}

	release, err := getJSON[struct {
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}](ctx, client, base+"/"+build)
	if err != nil {
		return nil, fmt.Errorf("artifacts: build %q release: %w", build, err)
	}
	for _, asset := range release.Assets {
		if asset.Name != vmManifestAsset {
			continue
		}
		manifest, err := getJSON[vmManifest](ctx, client, asset.URL)
		if err != nil {
			return nil, fmt.Errorf("artifacts: build %q %s: %w", build, vmManifestAsset, err)
		}
		return manifest, nil
	}
	return nil, fmt.Errorf("artifacts: release %q publishes no %s asset", build, vmManifestAsset)
}

func getJSON[T any](ctx context.Context, client *http.Client, url string) (*T, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s: unexpected status %d", url, resp.StatusCode)
	}
	var out T
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("%s: %w", url, err)
	}
	return &out, nil
}

func hash32(s string) ([32]byte, error) {
	var out [32]byte
	raw, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return out, fmt.Errorf("%q is not hex: %w", s, err)
	}
	if len(raw) != len(out) {
		return out, fmt.Errorf("%q is %d bytes, expected 32", s, len(raw))
	}
	copy(out[:], raw)
	return out, nil
}

func mustHash32(s string) [32]byte {
	out, err := hash32(s)
	if err != nil {
		panic("attestedroot: " + err.Error())
	}
	return out
}
