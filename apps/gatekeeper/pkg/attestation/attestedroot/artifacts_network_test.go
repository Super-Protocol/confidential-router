package attestedroot

import (
	"context"
	"encoding/hex"
	"os"
	"testing"
	"time"
)

// TestArtifactsAgainstTheRealSources fetches a real sp-vm release manifest and
// the firmware it names, and checks that the result matches the committed
// fixture byte for byte.
//
// It is skipped unless GATEKEEPER_NETWORK_TESTS is set: the rest of the suite
// must stay offline and deterministic. What it guards is the half of the code
// no offline test can reach — the release lookup, the signed object request,
// and the checksum enforcement — so that a change to either fails here rather
// than in production.
func TestArtifactsAgainstTheRealSources(t *testing.T) {
	if os.Getenv("GATEKEEPER_NETWORK_TESTS") == "" {
		t.Skip("set GATEKEEPER_NETWORK_TESTS=1 to exercise the live artefact sources")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	got, err := (&HTTPArtifactSource{}).Artifacts(ctx, "build-350")
	if err != nil {
		t.Fatalf("fetching the artefacts of build-350: %v", err)
	}
	want := build350(t)

	if hex.EncodeToString(got.Firmware.Seed) != hex.EncodeToString(want.Firmware.Seed) {
		t.Errorf("firmware seed = %x, want %x", got.Firmware.Seed, want.Firmware.Seed)
	}
	if got.Firmware.ResetEIP != want.Firmware.ResetEIP {
		t.Errorf("reset EIP = %#x, want %#x", got.Firmware.ResetEIP, want.Firmware.ResetEIP)
	}
	if got.Firmware.HashesTableGPA != want.Firmware.HashesTableGPA {
		t.Errorf("hashes table GPA = %#x, want %#x", got.Firmware.HashesTableGPA, want.Firmware.HashesTableGPA)
	}
	if len(got.Firmware.Sections) != len(want.Firmware.Sections) {
		t.Fatalf("read %d metadata sections, want %d", len(got.Firmware.Sections), len(want.Firmware.Sections))
	}
	for i := range got.Firmware.Sections {
		if got.Firmware.Sections[i] != want.Firmware.Sections[i] {
			t.Errorf("section %d = %+v, want %+v", i, got.Firmware.Sections[i], want.Firmware.Sections[i])
		}
	}
	if got.KernelHash != want.KernelHash || got.InitrdHash != want.InitrdHash {
		t.Errorf("kernel/initrd hashes = %x/%x, want %x/%x",
			got.KernelHash, got.InitrdHash, want.KernelHash, want.InitrdHash)
	}
}

// TestRegistryAgainstTheRealMirror checks the live registry the same way: the
// probe order, the paths and the pinned key, against what is published now.
func TestRegistryAgainstTheRealMirror(t *testing.T) {
	if os.Getenv("GATEKEEPER_NETWORK_TESTS") == "" {
		t.Skip("set GATEKEEPER_NETWORK_TESTS=1 to exercise the live registry")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	measurement, _ := registryFixture(t)
	if err := (&HTTPRegistry{}).Verify(ctx, measurement, EvidenceSevSnpQemu); err != nil {
		t.Fatalf("the live registry rejected a measurement it publishes: %v", err)
	}
}
