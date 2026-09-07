package attestedroot

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot/internal/snpmeasure"
)

// swarmRootEvidence is the real Super Swarm Root CA evidence fixture; see
// testdata/README.md.
func swarmRootEvidence(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/swarm-root-sev-snp-evidence.bin")
	if err != nil {
		t.Fatalf("reading the evidence fixture: %v", err)
	}
	return raw
}

// build350 loads the reduced firmware descriptor of the build that evidence
// was produced on, so the measurement can be reproduced offline.
func build350(t *testing.T) *BuildArtifacts {
	t.Helper()
	raw, err := os.ReadFile("testdata/build-350-firmware.json")
	if err != nil {
		t.Fatalf("reading the firmware fixture: %v", err)
	}
	var document struct {
		Seed           string `json:"seed"`
		ResetEIP       string `json:"resetEip"`
		HashesTableGPA string `json:"hashesTableGpa"`
		Sections       []struct {
			GPA  string `json:"gpa"`
			Size string `json:"size"`
			Type uint32 `json:"type"`
		} `json:"sections"`
		KernelSHA256 string `json:"kernelSha256"`
		InitrdSHA256 string `json:"initrdSha256"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("parsing the firmware fixture: %v", err)
	}

	firmware := &snpmeasure.Firmware{
		Seed:           mustHex(t, document.Seed),
		ResetEIP:       mustUint32(t, document.ResetEIP),
		HashesTableGPA: mustUint32(t, document.HashesTableGPA),
	}
	for _, s := range document.Sections {
		firmware.Sections = append(firmware.Sections, snpmeasure.Section{
			GPA:  mustUint32(t, s.GPA),
			Size: mustUint32(t, s.Size),
			Type: snpmeasure.SectionType(s.Type),
		})
	}

	artifacts := &BuildArtifacts{Firmware: firmware}
	copy(artifacts.KernelHash[:], mustHex(t, document.KernelSHA256))
	copy(artifacts.InitrdHash[:], mustHex(t, document.InitrdSHA256))
	return artifacts
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("%q is not hex: %v", s, err)
	}
	return raw
}

func mustUint32(t *testing.T, s string) uint32 {
	t.Helper()
	value, err := strconv.ParseUint(s, 0, 32)
	if err != nil {
		t.Fatalf("%q is not a 32-bit number: %v", s, err)
	}
	return uint32(value)
}

// fixedArtifacts serves one build's artefacts and refuses every other, so a
// test that reaches for the network fails loudly instead of hanging.
type fixedArtifacts struct {
	build     string
	artifacts *BuildArtifacts
	err       error
}

func (f fixedArtifacts) Artifacts(_ context.Context, build string) (*BuildArtifacts, error) {
	if f.err != nil {
		return nil, f.err
	}
	if build != f.build {
		return nil, errUnexpectedBuild{want: f.build, got: build}
	}
	return f.artifacts, nil
}

type errUnexpectedBuild struct{ want, got string }

func (e errUnexpectedBuild) Error() string {
	return "test artifact source has build " + e.want + ", asked for " + e.got
}

// stubRegistry answers with a fixed verdict.
type stubRegistry struct {
	err    error
	asked  [][]byte
	folder EvidenceType
}

func (s *stubRegistry) Verify(_ context.Context, mrEnclave []byte, evidence EvidenceType) error {
	s.asked = append(s.asked, mrEnclave)
	s.folder = evidence
	return s.err
}
