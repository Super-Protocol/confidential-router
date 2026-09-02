package snpmeasure_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot/internal/snpmeasure"
)

// ovmfSHA256 is the checksum sp-vm release build-350 publishes for its
// OVMF_AMD.fd. Regenerating the fixture from a different image would silently
// change every measurement derived from it, so the source is pinned here too.
const ovmfSHA256 = "7fb16bb6915a52b9af664a0edea5314158a56703b0d6e4d19f1b233a8912eb15"

// TestWriteFirmwareFixture regenerates testdata/build-350-firmware.json from a
// local copy of the release's OVMF image. It is skipped unless GATEKEEPER_OVMF
// points at one; see testdata/README.md.
func TestWriteFirmwareFixture(t *testing.T) {
	path := os.Getenv("GATEKEEPER_OVMF")
	if path == "" {
		t.Skip("set GATEKEEPER_OVMF to the release's OVMF_AMD.fd to regenerate the fixture")
	}

	image, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(hashOf(image)); got != ovmfSHA256 {
		t.Fatalf("%s hashes to %s, but build-350 publishes %s", path, got, ovmfSHA256)
	}

	firmware, err := snpmeasure.ParseFirmware(image)
	if err != nil {
		t.Fatal(err)
	}

	type section struct {
		GPA  string `json:"gpa"`
		Size string `json:"size"`
		Type uint32 `json:"type"`
	}
	document := struct {
		Build          string    `json:"build"`
		Seed           string    `json:"seed"`
		ResetEIP       string    `json:"resetEip"`
		HashesTableGPA string    `json:"hashesTableGpa"`
		Sections       []section `json:"sections"`
		KernelSHA256   string    `json:"kernelSha256"`
		InitrdSHA256   string    `json:"initrdSha256"`
	}{
		Build:          "build-350",
		Seed:           hex.EncodeToString(firmware.Seed),
		ResetEIP:       fmt.Sprintf("%#x", firmware.ResetEIP),
		HashesTableGPA: fmt.Sprintf("%#x", firmware.HashesTableGPA),
		// From the same release's vm.json; build-350 publishes no initrd, so the
		// hash is SHA-256 of the empty string.
		KernelSHA256: "d09b58597c380b3e104166f6d48c638ebecfb60d9196f04fc7c452c0d5f98b50",
		InitrdSHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	}
	for _, s := range firmware.Sections {
		document.Sections = append(document.Sections, section{
			GPA: fmt.Sprintf("%#x", s.GPA), Size: fmt.Sprintf("%#x", s.Size), Type: uint32(s.Type),
		})
	}

	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("testdata/build-350-firmware.json:\n%s\n", encoded)
}

func hashOf(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}
