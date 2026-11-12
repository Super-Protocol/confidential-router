package swarmevidence

import (
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// TestAppraisalFromDrawsTheAnswerFailureLine is the test for the one decision
// in this file that an attacker benefits from getting wrong.
//
// Two of the attested-root outcomes look alike and must not be treated alike.
// "The registry answered, and this image is not one of ours" is an answer: the
// hardware held up, and whether to accept an unsigned build belongs to the
// relying party's policy. "The registry could not be consulted" is a failure to
// reach an answer, and reporting it as an unapproved image would hand whoever
// can cut off the registry a say in what the claim set says.
func TestAppraisalFromDrawsTheAnswerFailureLine(t *testing.T) {
	t.Parallel()

	sound := func() *attestedroot.Result {
		return &attestedroot.Result{
			EvidenceType:     attestedroot.EvidenceSevSnpQemu,
			EvidenceTypeName: attestedroot.EvidenceSevSnpQemu.String(),
			NetworkType:      attestedroot.NetworkUntrusted,
			ReportIntegrity:  true,
			KeyBinding:       true,
			Measurement:      make([]byte, 32),
			Build:            "build-448-release",
		}
	}

	for _, c := range []struct {
		name          string
		result        func() *attestedroot.Result
		wantErr       string
		wantApproved  bool
		wantSource    MrEnclaveSource
		wantTCBStatus TCBStatus
	}{{
		name: "a registry-signed image is approved",
		result: func() *attestedroot.Result {
			r := sound()
			r.Attested = true
			r.InRegistry = true
			r.MeasurementSource = attestedroot.SourceRegistry
			return r
		},
		wantApproved:  true,
		wantSource:    SourceRegistry,
		wantTCBStatus: TCBUnknown,
	}, {
		name: "an image admitted by reference values says so",
		result: func() *attestedroot.Result {
			r := sound()
			r.Attested = true
			r.MeasurementSource = attestedroot.SourceOperatorPinned
			return r
		},
		wantApproved:  true,
		wantSource:    SourceReferenceValues,
		wantTCBStatus: TCBUnknown,
	}, {
		name: "an image nobody has signed is a claim, not a denial",
		result: func() *attestedroot.Result {
			r := sound()
			r.MeasurementUnknown = true
			r.Reason = "measurement is not in the Super Protocol trusted registry"
			return r
		},
		wantApproved:  false,
		wantSource:    "",
		wantTCBStatus: TCBUnknown,
	}, {
		name: "a registry that could not be consulted denies",
		result: func() *attestedroot.Result {
			r := sound()
			r.Reason = "the trusted registry could not be consulted: dial tcp: no route to host"
			return r
		},
		wantErr: "could not be appraised",
	}, {
		name: "a quote whose signature did not verify denies",
		result: func() *attestedroot.Result {
			r := sound()
			r.ReportIntegrity = false
			r.Reason = "attestation report: bad signature"
			return r
		},
		wantErr: "did not verify",
	}, {
		name: "a quote that does not commit to the certificate key denies",
		result: func() *attestedroot.Result {
			r := sound()
			r.KeyBinding = false
			r.Reason = "reportData does not commit to this certificate's public key"
			return r
		},
		wantErr: "does not commit to the root certificate's public key",
	}, {
		name: "no derived image identity denies",
		result: func() *attestedroot.Result {
			r := sound()
			r.Measurement = nil
			r.Reason = "the event list replays to something else"
			return r
		},
		wantErr: "no image identity could be derived",
	}, {
		name: "a certificate with no TEE evidence denies",
		result: func() *attestedroot.Result {
			return &attestedroot.Result{Reason: "the root certificate carries no TEE evidence extension"}
		},
		wantErr: "TEE evidence cannot be appraised",
	}, {
		name: "a clean collateral check is reported as such",
		result: func() *attestedroot.Result {
			r := sound()
			r.Attested = true
			r.MeasurementSource = attestedroot.SourceRegistry
			r.RevocationChecked, r.NotRevoked = true, true
			return r
		},
		wantApproved:  true,
		wantSource:    SourceRegistry,
		wantTCBStatus: TCBOK,
	}, {
		name: "a collateral check that did not come back clean is reported as such",
		result: func() *attestedroot.Result {
			r := sound()
			r.Attested = true
			r.MeasurementSource = attestedroot.SourceRegistry
			r.RevocationChecked, r.NotRevoked = true, false
			return r
		},
		wantApproved:  true,
		wantSource:    SourceRegistry,
		wantTCBStatus: TCBRevokedOrIndeterminate,
	}} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			appraisal, err := appraisalFrom(c.result())

			if c.wantErr != "" {
				if err == nil {
					t.Fatalf("appraisalFrom = %+v, want an error containing %q", appraisal, c.wantErr)
				}
				if !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("error %q does not contain %q", err, c.wantErr)
				}
				if appraisal != nil {
					t.Errorf("appraisal = %+v, want none beside an error", appraisal)
				}
				return
			}

			if err != nil {
				t.Fatalf("appraisalFrom: %v", err)
			}
			if appraisal.MrEnclaveApproved != c.wantApproved {
				t.Errorf("MrEnclaveApproved = %v, want %v", appraisal.MrEnclaveApproved, c.wantApproved)
			}
			if appraisal.MrEnclaveSource != c.wantSource {
				t.Errorf("MrEnclaveSource = %q, want %q", appraisal.MrEnclaveSource, c.wantSource)
			}
			if appraisal.TCBStatus != c.wantTCBStatus {
				t.Errorf("TCBStatus = %q, want %q", appraisal.TCBStatus, c.wantTCBStatus)
			}
			if appraisal.Platform != PlatformSNPQemu {
				t.Errorf("Platform = %q, want %q", appraisal.Platform, PlatformSNPQemu)
			}
			if appraisal.SpvmBuild != "build-448-release" {
				t.Errorf("SpvmBuild = %q, want the build the evidence named", appraisal.SpvmBuild)
			}
		})
	}
}

// TestPlatformOfCoversEveryEvidenceType keeps the claim set's platform
// vocabulary complete. A new evidence type that nobody maps here would be
// refused at the root-quote stage — fail-closed, but silently, and the fleet
// would look broken rather than unmapped.
func TestPlatformOfCoversEveryEvidenceType(t *testing.T) {
	t.Parallel()
	for evidence, want := range map[attestedroot.EvidenceType]Platform{
		attestedroot.EvidenceSevSnpQemu:  PlatformSNPQemu,
		attestedroot.EvidenceTdxQemu:     PlatformTDXQemu,
		attestedroot.EvidenceTdxGCP:      PlatformTDXGCP,
		attestedroot.EvidenceTdxAzure:    PlatformTDXAzure,
		attestedroot.EvidenceSevSnpAzure: PlatformSNPAzure,
	} {
		got, ok := platformOf(evidence)
		if !ok || got != want {
			t.Errorf("platformOf(%s) = %q, %v; want %q, true", evidence, got, ok, want)
		}
	}
	if _, ok := platformOf(attestedroot.EvidenceUnspecified); ok {
		t.Error("platformOf admitted an unspecified evidence type")
	}
}

// TestChannelBindingOfIsClosed keeps the binding vocabulary a closed set. The
// claim set publishes an enum, so a mode translated by a bare string conversion
// could put a value in the document that the schema does not list — and a
// policy requiring channel binding would then read something it has no rule for.
func TestChannelBindingOfIsClosed(t *testing.T) {
	t.Parallel()
	for binding, want := range map[attestation.ChannelBinding]ChannelBinding{
		attestation.BindingObserved:                    BindingObserved,
		attestation.BindingProducerAsserted:            BindingProducerAsserted,
		attestation.ChannelBinding("some-future-mode"): "",
		"": "",
	} {
		if got := channelBindingOf(binding); got != want {
			t.Errorf("channelBindingOf(%q) = %q, want %q", binding, got, want)
		}
	}
}
