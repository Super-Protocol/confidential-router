package swarmevidence_test

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// The live test's configuration. Everything about it is an environment
// variable rather than a committed value, because the Intel tenant is a paid
// human-owned account (SUP-642) and the quote has to come off real TDX
// hardware.
const (
	liveVerifierURL     = "SWARM_VERIFIER_URL"
	liveVerifierKey     = "SWARM_VERIFIER_API_KEY"
	liveVerifierJWKS    = "SWARM_VERIFIER_JWKS_URL"
	liveVerifierIssuer  = "SWARM_VERIFIER_ISSUER"
	liveVerifierQuote   = "SWARM_VERIFIER_QUOTE_FILE"
	liveVerifierAPIName = "SWARM_VERIFIER_NAME"
)

// TestLiveVerifierAppraisesARealQuote runs the delegated path against a real
// Verifier and a real quote. It is skipped unless the environment names both,
// which is why CI runs on the recorded fixtures instead.
//
// With Intel Trust Authority as the stand-in, and a serialised TeeEvidence
// captured from a bare-metal or GCP TDX node:
//
//	SWARM_VERIFIER_URL=https://api.trustauthority.intel.com/appraise/v2/attest \
//	SWARM_VERIFIER_API_KEY=... \
//	SWARM_VERIFIER_JWKS_URL=https://portal.trustauthority.intel.com/certs \
//	SWARM_VERIFIER_ISSUER=https://portal.trustauthority.intel.com \
//	SWARM_VERIFIER_QUOTE_FILE=./tdx-evidence.bin \
//	go test -run TestLiveVerifierAppraisesARealQuote -v ./...
//
// **This is the only check that ever confirms [swarmevidence.ITAClaimMapping]
// against a real token.** The committed ITA fixture is reconstructed from
// Intel's published sample
// (https://docs.trustauthority.intel.com/main/articles/concept-attestation-tokens.html),
// so it pins the mapping against Intel's *documentation* and cannot pin it
// against Intel's production output. Three of those claim names are a
// plausible guess away from denying every live appraisal —
// `tdx_td_attributes`, `attester_tcb_status`, `tdx_report_data` — so run this
// once against the tenant of SUP-642 before the demonstration stand depends
// on it, and again whenever Intel revises its token version (the sample this
// was written from is `ver: 2.0.0`).
//
// What it also proves that the fixtures cannot: that the live endpoint still
// takes the request body this module sends, and that its key set still
// authenticates its tokens. What it does *not* prove is anything about the
// appraisal logic — that is what the committed vectors are for, and they run
// on every pull request.
//
// For another Verifier, set SWARM_VERIFIER_NAME and supply its mapping in
// SWARM_VERIFIER_MAPPING as the JSON form of [swarmevidence.ClaimMapping].
func TestLiveVerifierAppraisesARealQuote(t *testing.T) {
	url, key := os.Getenv(liveVerifierURL), os.Getenv(liveVerifierKey)
	quoteFile := os.Getenv(liveVerifierQuote)
	if url == "" || quoteFile == "" {
		t.Skipf("set %s and %s to run the live Verifier test", liveVerifierURL, liveVerifierQuote)
	}

	evidence, err := os.ReadFile(quoteFile)
	if err != nil {
		t.Fatalf("reading the quote at %s: %v", quoteFile, err)
	}

	name := os.Getenv(liveVerifierAPIName)
	if name == "" {
		name = "intel-trust-authority"
	}
	mapping := swarmevidence.ITAClaimMapping()
	if document := os.Getenv("SWARM_VERIFIER_MAPPING"); document != "" {
		mapping = swarmevidence.ClaimMapping{}
		if err := json.Unmarshal([]byte(document), &mapping); err != nil {
			t.Fatalf("reading SWARM_VERIFIER_MAPPING: %v", err)
		}
	}
	issuer := os.Getenv(liveVerifierIssuer)
	if issuer == "" {
		issuer = "https://portal.trustauthority.intel.com"
	}
	jwks := os.Getenv(liveVerifierJWKS)
	if jwks == "" {
		jwks = "https://portal.trustauthority.intel.com/certs"
	}

	appraiser := &swarmevidence.DelegatedQuoteAppraiser{
		AppraiserName: name,
		Tokens: &swarmevidence.HTTPTokenSource{
			URL:     url,
			Headers: map[string]string{"x-api-key": key},
			Body:    map[string]string{"quote": "${quote_base64}"},
		},
		Token: swarmevidence.TokenVerification{
			Format:      swarmevidence.TokenJWT,
			Issuer:      issuer,
			Keys:        &swarmevidence.JWKSKeys{URL: jwks},
			MaxTokenAge: 10 * time.Minute,
		},
		Mapping: mapping,
	}

	appraisal, err := appraiser.AppraiseQuote(t.Context(), swarmevidence.Quote{
		Type:           "tdx",
		EvidenceBase64: base64.StdEncoding.EncodeToString(evidence),
	})
	if err != nil {
		t.Fatalf("%s did not appraise the quote: %v", name, err)
	}
	t.Logf("platform %s, tcb %q, image %s (approved=%v, source=%q)",
		appraisal.Platform, appraisal.TCBStatus, appraisal.MrEnclave,
		appraisal.MrEnclaveApproved, appraisal.MrEnclaveSource)
	for _, line := range appraisal.Logs {
		t.Log(line)
	}
	if appraisal.MrEnclave == "" {
		t.Error("the live appraisal produced no image identity")
	}
}
