package attestedroot

import (
	"encoding/hex"
	"strings"
	"testing"

	"github.com/google/go-sev-guest/abi"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot/internal/snpmeasure"
)

// swarmRootMrEnclave is the normalised measurement of the fixture root's VM.
//
// It is not a value this package chose: the same evidence and the same
// published artefacts produce it in the platform's WASM verifier, and the
// intermediate step — the launch digest of the VM as it actually ran — has to
// equal the MEASUREMENT the AMD firmware signed, which no re-implementation can
// fake. That check is what [snpmeasure.Normalize] performs, so this constant
// pins the whole port.
const swarmRootMrEnclave = "842c5f2eb016c04fa61e0ac3d0ff48bae16b4c08c61d80cdfdaf332a9b3625c2"

// TestNormalizeReproducesHardwareMeasurement is the port's proof: real evidence,
// the real firmware of the build it names, and the measurement that comes out.
func TestNormalizeReproducesHardwareMeasurement(t *testing.T) {
	evidence, err := ParseEvidence(swarmRootEvidence(t))
	if err != nil {
		t.Fatalf("parsing the evidence: %v", err)
	}
	report, err := abi.ReportToProto(evidence.SevSnp.RawReport)
	if err != nil {
		t.Fatalf("parsing the attestation report: %v", err)
	}
	artifacts := build350(t)

	hashes := snpmeasure.Hashes{Kernel: artifacts.KernelHash, Initrd: artifacts.InitrdHash}
	copy(hashes.Cmdline[:], evidence.SevSnp.CmdLineHash)

	measurement, err := snpmeasure.Normalize(artifacts.Firmware, hashes, snpmeasure.Report{
		Measurement: report.GetMeasurement(),
		CPUSig:      evidence.SevSnp.CPUSig,
		Cores:       evidence.SevSnp.Cores,
		Build:       evidence.SevSnp.Build,
	})
	if err != nil {
		t.Fatalf("normalizing: %v", err)
	}
	if got := hex.EncodeToString(measurement); got != swarmRootMrEnclave {
		t.Errorf("mrEnclave = %s, want %s", got, swarmRootMrEnclave)
	}
}

// TestLaunchDigestReproducesTheRunningVM checks the intermediate result on its
// own, so a failure says which half of the normalisation broke.
func TestLaunchDigestReproducesTheRunningVM(t *testing.T) {
	evidence, err := ParseEvidence(swarmRootEvidence(t))
	if err != nil {
		t.Fatalf("parsing the evidence: %v", err)
	}
	report, err := abi.ReportToProto(evidence.SevSnp.RawReport)
	if err != nil {
		t.Fatalf("parsing the attestation report: %v", err)
	}
	artifacts := build350(t)
	hashes := snpmeasure.Hashes{Kernel: artifacts.KernelHash, Initrd: artifacts.InitrdHash}
	copy(hashes.Cmdline[:], evidence.SevSnp.CmdLineHash)

	digest, err := snpmeasure.LaunchDigest(
		artifacts.Firmware, hashes, evidence.SevSnp.CPUSig, evidence.SevSnp.Cores)
	if err != nil {
		t.Fatalf("launch digest: %v", err)
	}
	if got, want := hex.EncodeToString(digest), hex.EncodeToString(report.GetMeasurement()); got != want {
		t.Errorf("launch digest = %s, want the report's MEASUREMENT %s", got, want)
	}
}

// TestNormalizeRejectsTheWrongVM covers the check that makes a build identifier
// worth anything: change what the VM claims to have run with, and the digest no
// longer reproduces the signed MEASUREMENT.
func TestNormalizeRejectsTheWrongVM(t *testing.T) {
	evidence, err := ParseEvidence(swarmRootEvidence(t))
	if err != nil {
		t.Fatalf("parsing the evidence: %v", err)
	}
	report, err := abi.ReportToProto(evidence.SevSnp.RawReport)
	if err != nil {
		t.Fatalf("parsing the attestation report: %v", err)
	}
	artifacts := build350(t)
	hashes := snpmeasure.Hashes{Kernel: artifacts.KernelHash, Initrd: artifacts.InitrdHash}
	copy(hashes.Cmdline[:], evidence.SevSnp.CmdLineHash)

	tampered := hashes
	tampered.Cmdline[0] ^= 0xff

	for _, tc := range []struct {
		name   string
		hashes snpmeasure.Hashes
		cores  int
	}{
		{name: "a different vCPU count", hashes: hashes, cores: evidence.SevSnp.Cores + 1},
		{name: "a different kernel command line", hashes: tampered, cores: evidence.SevSnp.Cores},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := snpmeasure.Normalize(artifacts.Firmware, tc.hashes, snpmeasure.Report{
				Measurement: report.GetMeasurement(),
				CPUSig:      evidence.SevSnp.CPUSig,
				Cores:       tc.cores,
				Build:       evidence.SevSnp.Build,
			})
			if err == nil {
				t.Fatal("normalize accepted a VM the report does not describe")
			}
			if !strings.Contains(err.Error(), "does not match the attestation report's MEASUREMENT") {
				t.Errorf("error = %v, want it to name the MEASUREMENT mismatch", err)
			}
		})
	}
}
