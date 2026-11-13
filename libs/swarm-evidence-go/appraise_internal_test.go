package swarmevidence

import (
	_ "embed"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
)

//go:embed DENIAL-STAGES.md
var denialStagesDoc string

// TestPipelineStageMappingIsPinned fixes the lossy translation from the bundle
// pipeline's stage vocabulary into the claim set's, every arm of it including
// the default.
//
// It is pinned rather than left to read off the switch because the two
// vocabularies are allowed to drift — the pipeline's names are about our
// implementation and the claim set's are a published contract — and the only
// way that drift stays deliberate is if changing it has to change a test and
// the note beside it (SUP-647 review follow-up).
func TestPipelineStageMappingIsPinned(t *testing.T) {
	t.Parallel()

	for stage, want := range map[attestation.Stage]DenialStage{
		attestation.StageFetch:                             StageBlob,
		attestation.StageCertChain:                         StagePKIChain,
		attestation.StageUntrustedRoot:                     StagePKIChain,
		attestation.StageJWS:                               StageStatement,
		attestation.StageTLSFingerprint:                    StageBinding,
		attestation.Stage("a stage a later pipeline adds"): StageBlob,
	} {
		if got := denialStageOf(stage); got != want {
			t.Errorf("denialStageOf(%q) = %q, want %q", stage, got, want)
		}
	}
}

// TestDenialStagesAreDocumented keeps DENIAL-STAGES.md from falling behind the
// constants. The note is the contract a relying party branches on, and a stage
// nobody wrote down is one a policy author cannot handle.
func TestDenialStagesAreDocumented(t *testing.T) {
	t.Parallel()

	for _, stage := range []DenialStage{
		StageOptions, StageBlob, StagePKIChain, StageRootQuote,
		StageBinding, StageEnvelope, StageStatement,
	} {
		if !strings.Contains(denialStagesDoc, "| `"+string(stage)+"` |") {
			t.Errorf("DENIAL-STAGES.md has no row for the %q stage", stage)
		}
	}
	for _, stage := range []attestation.Stage{
		attestation.StageFetch, attestation.StageCertChain, attestation.StageUntrustedRoot,
		attestation.StageJWS, attestation.StageTLSFingerprint,
	} {
		if !strings.Contains(denialStagesDoc, "| `"+string(stage)+"` |") {
			t.Errorf("DENIAL-STAGES.md does not say what the pipeline's %q stage folds into", stage)
		}
	}
}
