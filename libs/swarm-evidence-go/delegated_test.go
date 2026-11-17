package swarmevidence_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// TestDelegatedPathMatchesTheOfflinePath is acceptance criterion 4 of SUP-648:
// the claim set a delegated appraisal establishes is the one the offline path
// establishes, for the same evidence.
//
// Both runs appraise the same collection with the same request values and the
// same trust anchors; only the quote appraiser differs. The three claims that
// are *allowed* to differ are the appraiser's own identity, and
// [appraiserIdentityClaims] says why each of them is. Everything else —
// platform, every register, the normalised image identity, who vouches for it,
// the binding, the envelope, the pod facts — is compared byte for byte.
func TestDelegatedPathMatchesTheOfflinePath(t *testing.T) {
	t.Parallel()

	for _, name := range delegatedFixtures {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			fixture := loadDelegatedFixture(t, name)
			registry := &fixtureRegistry{approved: fixture.ExpectedMrEnclave}

			c := newComposite(t)
			c.quote["type"] = "tdx-google"
			c.quote["evidenceBase64"] = base64.StdEncoding.EncodeToString(fixture.evidence(t))
			blob := c.blob(t)

			options := c.options()
			root := options.QuoteAppraiser

			options.QuoteAppraiser = &offlineEquivalentAppraiser{registry: registry, root: root}
			offline, err := swarmevidence.AppraiseComposite(t.Context(), blob, options)
			if err != nil {
				t.Fatalf("the offline path refused the collection: %v", err)
			}

			options.QuoteAppraiser = fixture.appraiser(t, root, registry)
			delegated, err := swarmevidence.AppraiseComposite(t.Context(), blob, options)
			if err != nil {
				t.Fatalf("the delegated path refused the collection: %v", err)
			}

			if delegated.MrEnclave != fixture.ExpectedMrEnclave {
				t.Errorf("mrenclave = %s, and the vector pins %s", delegated.MrEnclave, fixture.ExpectedMrEnclave)
			}
			if delegated.QuoteAppraiser != fixture.Verifier {
				t.Errorf("quote_appraiser = %q, want %q", delegated.QuoteAppraiser, fixture.Verifier)
			}
			got, want, equal := jsonEqual(t,
				claimsWithout(t, delegated, appraiserIdentityClaims),
				claimsWithout(t, offline, appraiserIdentityClaims))
			if !equal {
				t.Errorf("the delegated claim set is not the offline one.\ndelegated:\n%s\noffline:\n%s", got, want)
			}
		})
	}
}

// TestSwappingTheVerifierIsConfigurationOnly is acceptance criterion 3: the
// two recorded Verifiers produce the same claims about the same quote, and
// nothing but configuration differs between the two runs.
//
// The second Verifier reuses none of the first's vocabulary — different claim
// names, nested differently and with dots inside the names; base64 rather than
// hex; a different issuer, algorithm and signing key — because a fake that
// reused them would prove nothing.
func TestSwappingTheVerifierIsConfigurationOnly(t *testing.T) {
	t.Parallel()

	claimsByVerifier := map[string]map[string]any{}
	for _, name := range delegatedFixtures {
		fixture := loadDelegatedFixture(t, name)
		registry := &fixtureRegistry{approved: fixture.ExpectedMrEnclave}

		c := newComposite(t)
		c.quote["type"] = "tdx-google"
		c.quote["evidenceBase64"] = base64.StdEncoding.EncodeToString(fixture.evidence(t))
		options := c.options()
		options.QuoteAppraiser = fixture.appraiser(t, options.QuoteAppraiser, registry)

		claims, err := swarmevidence.AppraiseComposite(t.Context(), c.blob(t), options)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		claimsByVerifier[name] = claimsWithout(t, claims, append(
			// The PKI fixtures mint fresh keys per fixture, so the chain
			// fingerprints differ between the two runs and say nothing about
			// the Verifier.
			[]string{"pki_root_fingerprint", "node_cert_fingerprint", "statement_signer_fingerprint"},
			appraiserIdentityClaims...))
	}

	first, second := delegatedFixtures[0], delegatedFixtures[1]
	got, want, equal := jsonEqual(t, claimsByVerifier[second], claimsByVerifier[first])
	if !equal {
		t.Errorf("swapping %s for %s changed the claims.\n%s:\n%s\n%s:\n%s",
			first, second, second, got, first, want)
	}
}

// TestDelegatedPathDoesNotTrustAReportedReportData is acceptance criterion 6.
//
// The token here is impeccable and says the quote's report data is request
// B's. The quote carries request A's. The appraisal is asked to bind request
// B — so a path that believed the token would mint a credential for a request
// no attester answered. The binding digest is recomputed locally and compared
// with the quote's own field, so it denies instead.
func TestDelegatedPathDoesNotTrustAReportedReportData(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	registry := &fixtureRegistry{approved: fixture.ExpectedMrEnclave}

	// Request B: another subject, hence another binding digest.
	otherSubject := []byte("\x30\x59\x30\x13some other request's CEKpub SPKI")
	otherDigest := bindingDigest(testFreshness, testTarget, otherSubject)

	c := newComposite(t)
	c.quote["type"] = "tdx-google"
	c.quote["evidenceBase64"] = base64.StdEncoding.EncodeToString(fixture.evidence(t))
	options := c.options()
	options.RequestSubject = otherSubject
	// The envelope commits to the subject too, so this case has to disable
	// that check to reach the binding one it is about.
	c.envelope["subject_hash"] = b64(sha256Of(otherSubject))

	appraiser := fixture.appraiser(t, options.QuoteAppraiser, registry)
	// The Verifier reports request B's digest: either because it was asked
	// about another quote, or because it is lying.
	appraiser.Tokens = &staticToken{token: fixture.Token, submits: true}
	// With no report-data claim mapped, nothing but the quote itself can
	// supply the field the binding digest is compared against — which is the
	// property under test.
	appraiser.Mapping.BindingData = nil
	options.QuoteAppraiser = appraiser

	claims, err := swarmevidence.AppraiseComposite(t.Context(), c.blob(t), options)
	var denial *swarmevidence.Denial
	if !asDenial(err, &denial) {
		t.Fatalf("a quote that does not answer this request was accepted: %+v", claims)
	}
	if denial.Stage != swarmevidence.StageBinding {
		t.Errorf("denial stage = %q, want %q (reason: %s)", denial.Stage, swarmevidence.StageBinding, denial.Reason)
	}
	if !strings.Contains(denial.Reason, hex.EncodeToString(otherDigest)) {
		t.Errorf("the denial does not name the digest this request computes: %s", denial.Reason)
	}
}

// TestDelegatedPathRefusesARelayedTokenForAnotherQuote is the other half of
// the same property: when the token is relayed rather than obtained by
// submitting the quote, the token's own report data must be mapped and must
// match the quote's.
func TestDelegatedPathRefusesARelayedTokenForAnotherQuote(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	registry := &fixtureRegistry{approved: fixture.ExpectedMrEnclave}

	// A quote with the same registers — so the token's measurements still
	// agree — and a report data the holder chose.
	forged := fixture.Quote
	forged.ReportData = hex.EncodeToString(bindingDigest(testFreshness, testTarget,
		[]byte("\x30\x59\x30\x13a request the holder of the token invented")))
	evidence := tdxTeeEvidence(t, forged)

	c := newComposite(t)
	c.quote["type"] = "tdx-google"
	c.quote["evidenceBase64"] = base64.StdEncoding.EncodeToString(evidence)
	options := c.options()

	digest := sha256.Sum256(evidence)
	appraiser := fixture.appraiser(t, options.QuoteAppraiser, registry)
	appraiser.Tokens = &swarmevidence.RecordedTokens{
		Tokens: map[string]string{hex.EncodeToString(digest[:]): fixture.Token},
	}
	options.QuoteAppraiser = appraiser

	_, err := swarmevidence.AppraiseComposite(t.Context(), c.blob(t), options)
	var denial *swarmevidence.Denial
	if !asDenial(err, &denial) {
		t.Fatal("a genuine token was accepted beside a quote it does not appraise")
	}
	if !strings.Contains(denial.Reason, "appraises a different quote") {
		t.Errorf("the denial does not say the token is about another quote: %s", denial.Reason)
	}
}

// TestITAClaimMappingFindsIntelsPublishedClaims is what holds
// [swarmevidence.ITAClaimMapping] to the Verifier it is named after.
//
// The fixture token is built in the shape of Intel's published sample —
// https://docs.trustauthority.intel.com/main/articles/concept-attestation-tokens.html
// — and this appraises it with the mapping the package exports, not with the
// copy committed in the fixture. Editing one without the other now fails
// here, which is the only check standing between a wrong claim name and a
// demonstration stand that denies every request.
func TestITAClaimMappingFindsIntelsPublishedClaims(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	quote := swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(fixture.evidence(t)),
	}

	appraiser := fixture.appraiser(t, nil, &fixtureRegistry{approved: fixture.ExpectedMrEnclave})
	appraiser.Mapping = swarmevidence.ITAClaimMapping()

	appraisal, err := appraiser.AppraiseQuote(t.Context(), quote)
	if err != nil {
		t.Fatalf("the exported ITA mapping did not appraise Intel's token shape: %v", err)
	}
	// Intel answers in Intel's vocabulary, and it is reported verbatim.
	if appraisal.TCBStatus != "UpToDate" {
		t.Errorf("tcb_status = %q, want Intel's own %q", appraisal.TCBStatus, "UpToDate")
	}
	if !appraisal.CollateralChecked {
		t.Error("collateral_checked is false for a Verifier that reported a TCB status")
	}
}

// TestITAFixtureUsesThePublishedMapping keeps the committed fixture and the
// exported mapping from drifting apart. Without it the fixture would simply
// carry whatever mapping it was generated with, and every test that runs off
// the fixture would agree with itself.
func TestITAFixtureUsesThePublishedMapping(t *testing.T) {
	t.Parallel()

	committed, err := json.Marshal(loadDelegatedFixture(t, "intel-trust-authority").Mapping)
	if err != nil {
		t.Fatalf("marshalling the committed mapping: %v", err)
	}
	exported, err := json.Marshal(swarmevidence.ITAClaimMapping())
	if err != nil {
		t.Fatalf("marshalling the exported mapping: %v", err)
	}
	if string(committed) != string(exported) {
		t.Errorf("the committed fixture mapping and ITAClaimMapping() differ; regenerate the "+
			"fixture.\ncommitted: %s\nexported:  %s", committed, exported)
	}
}

// TestITAMappingReadsTheReportDataAndNotTheHeldData pins the one mapping
// mistake that would look like a working configuration right up until a live
// token arrived.
//
// Intel's `attester_held_data` is the *caller's* own binary runtime data, not
// the quote's REPORT_DATA — that is `tdx_report_data`. A mapping pointed at
// the first would compare the caller's data against the quote's report data
// and deny every genuine token. The fixture carries both claims so the
// mistake fails here rather than on the demonstration stand.
func TestITAMappingReadsTheReportDataAndNotTheHeldData(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	quote := swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(fixture.evidence(t)),
	}
	if got := strings.Join(swarmevidence.ITAClaimMapping().BindingData, "."); got != "tdx.tdx_report_data" {
		t.Errorf("ITAClaimMapping reads its report data from %q", got)
	}

	wrong := fixture.appraiser(t, nil, &fixtureRegistry{approved: fixture.ExpectedMrEnclave})
	wrong.Mapping = swarmevidence.ITAClaimMapping()
	wrong.Mapping.BindingData = swarmevidence.ClaimPath{"tdx", "attester_held_data"}
	wrong.Mapping.BindingDataEncoding = swarmevidence.EncodingBase64
	if _, err := wrong.AppraiseQuote(t.Context(), quote); err == nil {
		t.Error("the caller's own held data was accepted as the quote's report data")
	}
}

// TestRelayedTokenNeedsAMappedReportData is the configuration guard behind the
// case above: a relaying token source with no report-data claim mapped has
// nothing tying the token to the quote, and the appraiser says so rather than
// proceeding.
func TestRelayedTokenNeedsAMappedReportData(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	appraiser := fixture.appraiser(t, nil, &fixtureRegistry{approved: fixture.ExpectedMrEnclave})
	appraiser.Mapping.BindingData = nil

	_, err := appraiser.AppraiseQuote(t.Context(), swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(fixture.evidence(t)),
	})
	if err == nil {
		t.Fatal("a relayed token with no report-data claim mapped was accepted")
	}
	if !strings.Contains(err.Error(), "ClaimMapping.BindingData") {
		t.Errorf("the refusal does not name the configuration that is missing: %v", err)
	}
}

// TestDelegatedPathDeniesOutsideItsCoverage is acceptance criterion 7: a
// platform the delegated path cannot honestly complete is refused with a typed
// denial naming the limitation — never a partial verdict.
func TestDelegatedPathDeniesOutsideItsCoverage(t *testing.T) {
	t.Parallel()

	for _, c := range []struct {
		platform swarmevidence.Platform
		names    string
	}{
		{swarmevidence.PlatformSNPQemu, "rebuilt from the published firmware"},
		{swarmevidence.PlatformTDXAzure, "vTPM PCR4"},
		{swarmevidence.PlatformSNPAzure, "vTPM PCR4"},
	} {
		t.Run(string(c.platform), func(t *testing.T) {
			t.Parallel()
			fixture := loadDelegatedFixture(t, "intel-trust-authority")
			appraiser := fixture.appraiser(t, nil, &fixtureRegistry{})

			_, err := appraiser.AppraiseQuote(t.Context(), swarmevidence.Quote{
				Type:           string(c.platform),
				EvidenceBase64: base64.StdEncoding.EncodeToString(nonTDXEvidence(c.platform)),
			})
			var denial *swarmevidence.Denial
			if !asDenial(err, &denial) {
				t.Fatalf("%s was appraised rather than refused", c.platform)
			}
			if denial.Stage != swarmevidence.StageCoverage {
				t.Errorf("denial stage = %q, want %q", denial.Stage, swarmevidence.StageCoverage)
			}
			if !strings.Contains(denial.Reason, string(c.platform)) {
				t.Errorf("the denial does not name the platform: %s", denial.Reason)
			}
			if !strings.Contains(denial.Reason, c.names) {
				t.Errorf("the denial does not name the limitation: %s", denial.Reason)
			}
		})
	}
}

// TestCoverageDenialReachesTheClaimSetAsItsOwnStage checks that the stage
// survives the seam: a relying party reading `denial.stage` must be able to
// tell "your Verifier does not cover this node" from "this node's quote did
// not appraise", because only the first is cleared by configuration.
func TestCoverageDenialReachesTheClaimSetAsItsOwnStage(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	c := newComposite(t)
	c.quote["type"] = "sev-snp"
	c.quote["evidenceBase64"] = base64.StdEncoding.EncodeToString(
		nonTDXEvidence(swarmevidence.PlatformSNPQemu))
	options := c.options()
	options.QuoteAppraiser = fixture.appraiser(t, options.QuoteAppraiser, &fixtureRegistry{})

	claims, err := swarmevidence.AppraiseComposite(t.Context(), c.blob(t), options)
	var denial *swarmevidence.Denial
	if !asDenial(err, &denial) {
		t.Fatal("an uncovered platform was appraised")
	}
	if claims.Denial == nil || claims.Denial.Stage != swarmevidence.StageCoverage {
		t.Fatalf("the claim set's denial = %+v, want stage %q", claims.Denial, swarmevidence.StageCoverage)
	}
	// A refusal is never a partial pass, and the freshness is still echoed so
	// the caller can match the answer to the challenge it issued.
	if claims.QuoteVerified != nil || claims.MrEnclave != "" || claims.Platform != "" {
		t.Errorf("the refused claim set carries appraisal claims: %+v", claims)
	}
	if claims.FreshnessInput != hex.EncodeToString(testFreshness) {
		t.Errorf("freshness_input = %q, want the input verbatim", claims.FreshnessInput)
	}
}

// TestDelegatedPathReportsTheFreshnessVerbatim is the other half of acceptance
// criterion 6: the freshness element is echoed exactly as the caller supplied
// it, and the subject digest beside it is the one this request computes.
func TestDelegatedPathReportsTheFreshnessVerbatim(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	c := newComposite(t)
	c.quote["type"] = "tdx-google"
	c.quote["evidenceBase64"] = base64.StdEncoding.EncodeToString(fixture.evidence(t))
	options := c.options()
	options.QuoteAppraiser = fixture.appraiser(t, options.QuoteAppraiser,
		&fixtureRegistry{approved: fixture.ExpectedMrEnclave})

	claims, err := swarmevidence.AppraiseComposite(t.Context(), c.blob(t), options)
	if err != nil {
		t.Fatalf("appraising: %v", err)
	}
	if claims.FreshnessInput != hex.EncodeToString(testFreshness) {
		t.Errorf("freshness_input = %q, want %q", claims.FreshnessInput, hex.EncodeToString(testFreshness))
	}
	if claims.BindingOK == nil || !*claims.BindingOK {
		t.Error("binding_ok is not true for a quote that answers this request")
	}
	want := sha256.Sum256(testRequestee)
	if claims.BindingSubjectDigest != hex.EncodeToString(want[:]) {
		t.Errorf("binding_subject_digest = %q, want the SHA-256 of this request's subject",
			claims.BindingSubjectDigest)
	}
}

// TestDelegatedPathDeniesWhenTheTokenDescribesAnotherTD is the register
// cross-check: the token is genuine and the quote is not the one it appraises.
func TestDelegatedPathDeniesWhenTheTokenDescribesAnotherTD(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	other := fixture.Quote
	other.MRTD = strings.Repeat("ab", 48)
	evidence := tdxTeeEvidence(t, other)

	digest := sha256.Sum256(evidence)
	appraiser := fixture.appraiser(t, nil, &fixtureRegistry{approved: fixture.ExpectedMrEnclave})
	appraiser.Tokens = &swarmevidence.RecordedTokens{
		Tokens: map[string]string{hex.EncodeToString(digest[:]): fixture.Token},
	}

	_, err := appraiser.AppraiseQuote(t.Context(), swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(evidence),
	})
	if err == nil {
		t.Fatal("a token describing another TD was accepted")
	}
	if !strings.Contains(err.Error(), "mrtd") {
		t.Errorf("the refusal does not name the register that disagrees: %v", err)
	}
}

// TestDelegatedPathDeniesAnEventLogThatDoesNotReplay keeps the one step the
// Verifier cannot do honest: the RTMR0 the token reports has to be the one the
// event list folds into, or the normalisation would measure a boot nobody
// attested.
func TestDelegatedPathDeniesAnEventLogThatDoesNotReplay(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	appraiser := fixture.appraiser(t, nil, &fixtureRegistry{approved: fixture.ExpectedMrEnclave})

	// The quote and the token agree about RTMR0; the event list does not
	// explain it, because one of its digests was changed after the fact.
	tampered := fixture.Quote
	tampered.EventLog = append([]fixtureEventEntry{}, tampered.EventLog...)
	tampered.EventLog[1] = fixtureEventEntry{Type: "EV_SEPARATOR", Digest: strings.Repeat("ee", 48)}
	withBadLog := tdxTeeEvidenceWithRTMR0(t, tampered, replayEventLog(t, fixture.Quote.EventLog, nil))

	digest := sha256.Sum256(withBadLog)
	appraiser.Tokens = &swarmevidence.RecordedTokens{
		Tokens: map[string]string{hex.EncodeToString(digest[:]): fixture.Token},
	}
	_, err := appraiser.AppraiseQuote(t.Context(), swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(withBadLog),
	})
	if err == nil {
		t.Fatal("an event list that does not replay to RTMR0 was accepted")
	}
	if !strings.Contains(err.Error(), "RTMR0") {
		t.Errorf("the refusal does not name RTMR0: %v", err)
	}
}

// TestUnapprovedImageIsAClaimNotADenial: the registry answered, and the answer
// was "not one of ours". Whether to accept an unsigned build is the policy's
// decision, so the delegated path reports it exactly as the offline one does.
func TestUnapprovedImageIsAClaimNotADenial(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	c := newComposite(t)
	c.quote["type"] = "tdx-google"
	c.quote["evidenceBase64"] = base64.StdEncoding.EncodeToString(fixture.evidence(t))
	options := c.options()
	options.QuoteAppraiser = fixture.appraiser(t, options.QuoteAppraiser,
		&fixtureRegistry{approved: "not this image"})

	claims, err := swarmevidence.AppraiseComposite(t.Context(), c.blob(t), options)
	if err != nil {
		t.Fatalf("an unsigned image was refused rather than reported: %v", err)
	}
	if claims.MrEnclaveApproved == nil || *claims.MrEnclaveApproved {
		t.Errorf("mrenclave_approved = %v, want a reported false", claims.MrEnclaveApproved)
	}
	if claims.MrEnclaveSource != "" {
		t.Errorf("mrenclave_source = %q, and nothing vouched for this image", claims.MrEnclaveSource)
	}
}

// TestReferenceValuesAdmitAnImageTheRegistryDoesNot: the relying party's own
// CoRIM reference values (SUP-640) work on the delegated path exactly as they
// do offline, and say so through `mrenclave_source`.
func TestReferenceValuesAdmitAnImageTheRegistryDoesNot(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	appraiser := fixture.appraiser(t, nil, &fixtureRegistry{approved: "not this image"})
	appraiser.ReferenceValues = swarmevidence.ReferenceValues{MrEnclaves: []string{fixture.ExpectedMrEnclave}}

	appraisal, err := appraiser.AppraiseQuote(t.Context(), swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(fixture.evidence(t)),
	})
	if err != nil {
		t.Fatalf("appraising: %v", err)
	}
	if !appraisal.MrEnclaveApproved || appraisal.MrEnclaveSource != swarmevidence.SourceReferenceValues {
		t.Errorf("approved=%v source=%q, want a reference-value approval",
			appraisal.MrEnclaveApproved, appraisal.MrEnclaveSource)
	}
}

// TestARegistryThatCannotBeConsultedDenies: unknown is not untrusted, but it
// cannot be admitted either — whoever can cut the registry off must not
// thereby get an image accepted.
func TestARegistryThatCannotBeConsultedDenies(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	appraiser := fixture.appraiser(t, nil, &fixtureRegistry{err: errStub})

	_, err := appraiser.AppraiseQuote(t.Context(), swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(fixture.evidence(t)),
	})
	if err == nil {
		t.Fatal("an image nothing could vouch for was admitted")
	}
	if !strings.Contains(err.Error(), "registry could not be consulted") {
		t.Errorf("the refusal does not say the registry was unreachable: %v", err)
	}
}

// TestTheRootQuoteIsNotDelegatedByDefault pins the architecture: the bank's
// Verifier appraises the per-request quote, and the membership root's own
// embedded quote — which is Super Swarm-specific — stays with the appraiser
// configured for it.
func TestTheRootQuoteIsNotDelegatedByDefault(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	root := &stubAppraiser{appraisal: stubAppraisal()}
	appraiser := fixture.appraiser(t, root, &fixtureRegistry{})
	appraiser.RootAppraiser = root

	appraisal, err := appraiser.AppraiseRootQuote(t.Context(), nil)
	if err != nil {
		t.Fatalf("appraising the root quote: %v", err)
	}
	if appraisal.MrEnclave != stubAppraisal().MrEnclave {
		t.Error("the root quote did not reach the configured root appraiser")
	}
	if appraiser.Name() != "intel-trust-authority" {
		t.Errorf("Name() = %q, want the configured Verifier's name", appraiser.Name())
	}
}

// --- the token itself -------------------------------------------------------

// TestEATVerificationRefusals covers what authenticating a Verifier's result
// has to refuse. Each case starts from the recorded ITA fixture and changes
// exactly one thing.
func TestEATVerificationRefusals(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	evidence := fixture.evidence(t)
	quote := swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(evidence),
	}

	for _, c := range []struct {
		name    string
		mutate  func(*swarmevidence.DelegatedQuoteAppraiser)
		expects string
	}{
		{
			name:    "another issuer",
			mutate:  func(a *swarmevidence.DelegatedQuoteAppraiser) { a.Token.Issuer = "https://someone.else" },
			expects: "configured Verifier is",
		},
		{
			name:    "an issuer nobody configured",
			mutate:  func(a *swarmevidence.DelegatedQuoteAppraiser) { a.Token.Issuer = "" },
			expects: "no expected issuer is configured",
		},
		{
			name: "an audience the token does not carry",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Token.Audience = "https://vault.another-bank.example"
			},
			expects: "audience does not include",
		},
		{
			name: "an algorithm outside the allow-list",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Token.Algorithms = []string{"ES256"}
			},
			expects: "not in the configured allow-list",
		},
		{
			name: "another key",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				other := loadDelegatedFixture(t, "acme-ear-verifier")
				a.Token.Keys = &swarmevidence.PinnedKeys{
					Keys: []swarmevidence.PinnedKey{{PEM: other.VerificationKeyPEM}},
				}
			},
			expects: "does not verify under any configured key",
		},
		{
			name: "no key at all",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Token.Keys = nil
			},
			expects: "no verification keys are configured",
		},
		{
			name: "a token past its expiry",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Now = func() time.Time { return fixtureIssuedAt.Add(2 * time.Hour) }
			},
			expects: "expired at",
		},
		{
			name: "a token older than the configured window",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Token.MaxTokenAge = time.Minute
				a.Now = func() time.Time { return fixtureIssuedAt.Add(4 * time.Minute) }
			},
			expects: "beyond the configured",
		},
		{
			name: "a token with no expiry and no configured window",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Tokens = &staticToken{token: reissue(t, fixture, func(claims map[string]any) {
					delete(claims, "exp")
				}), submits: true}
			},
			expects: "no `exp`",
		},
		{
			name: "the CWT serialisation",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Token.Format = swarmevidence.TokenCWT
			},
			expects: "CWT serialisation is not implemented",
		},
		{
			name: "a tampered signature",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Tokens = &staticToken{token: flipLastSegment(fixture.Token), submits: true}
			},
			expects: "does not verify under any configured key",
		},
		{
			name: "a claim mapping pointed at nothing",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Mapping.MRTD = swarmevidence.ClaimPath{"tdx", "no_such_claim"}
			},
			expects: "carries no mrtd",
		},
		{
			name: "a claim mapping missing a register",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Mapping.RTMR3 = nil
			},
			expects: "does not say where this Verifier reports rtmr3",
		},
		{
			name: "a claim mapping with the wrong encoding",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Mapping.Encoding = swarmevidence.EncodingBase64
			},
			// A register that decodes under the wrong rule is not a decode
			// failure — it is a plausible wrong answer, which is what the
			// cross-check against the quote exists to catch.
			expects: "appraises a different TD",
		},
		{
			name: "no token source",
			mutate: func(a *swarmevidence.DelegatedQuoteAppraiser) {
				a.Tokens = nil
			},
			expects: "no token source is configured",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			appraiser := fixture.appraiser(t, nil, &fixtureRegistry{approved: fixture.ExpectedMrEnclave})
			appraiser.Now = func() time.Time { return fixtureIssuedAt.Add(time.Minute) }
			c.mutate(appraiser)

			_, err := appraiser.AppraiseQuote(t.Context(), quote)
			if err == nil {
				t.Fatalf("%s was accepted", c.name)
			}
			if !strings.Contains(err.Error(), c.expects) {
				t.Errorf("error = %v, want it to mention %q", err, c.expects)
			}
		})
	}
}

// TestATokenWithNoExpiryIsUsableWithAConfiguredWindow is the other side of
// that refusal: a Verifier that does not date its results is usable, once the
// relying party says how long one is good for.
func TestATokenWithNoExpiryIsUsableWithAConfiguredWindow(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	appraiser := fixture.appraiser(t, nil, &fixtureRegistry{approved: fixture.ExpectedMrEnclave})
	appraiser.Now = func() time.Time { return fixtureIssuedAt.Add(time.Minute) }
	appraiser.Token.MaxTokenAge = 10 * time.Minute
	appraiser.Tokens = &staticToken{token: reissue(t, fixture, func(claims map[string]any) {
		delete(claims, "exp")
	}), submits: true}

	if _, err := appraiser.AppraiseQuote(t.Context(), swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(fixture.evidence(t)),
	}); err != nil {
		t.Fatalf("a dateless token inside the configured window was refused: %v", err)
	}
}

// reissue re-signs a fixture's token with one thing about its claims changed,
// under the same key the fixture is recorded with.
func reissue(t *testing.T, fixture *delegatedFixture, mutate func(map[string]any)) string {
	t.Helper()
	segments := strings.Split(fixture.Token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		t.Fatalf("decoding the recorded token: %v", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatalf("reading the recorded token: %v", err)
	}
	mutate(claims)
	return signJWT(t, "PS384", "ita-2026-11", rsaFixtureKey(t, fixture.Verifier), claims)
}

// TestJWKSKeysServeAFetchedKeySet exercises the other key source: the
// Verifier's published key set, fetched, cached, re-fetched when a `kid` it
// does not hold turns up — which is what key rotation looks like — and
// rate-limited, because on any path where the attester carries its own token
// the `kid` is attacker-chosen.
func TestJWKSKeysServeAFetchedKeySet(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	var fetches int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(fixture.JWKS)
	}))
	t.Cleanup(server.Close)

	now := fixtureIssuedAt.Add(time.Minute)
	keys := &swarmevidence.JWKSKeys{URL: server.URL, Now: func() time.Time { return now }}
	appraiser := fixture.appraiser(t, nil, &fixtureRegistry{approved: fixture.ExpectedMrEnclave})
	appraiser.Token.Keys = keys
	appraiser.Now = func() time.Time { return now }

	quote := swarmevidence.Quote{
		Type:           "tdx-google",
		EvidenceBase64: base64.StdEncoding.EncodeToString(fixture.evidence(t)),
	}
	for range 2 {
		if _, err := appraiser.AppraiseQuote(t.Context(), quote); err != nil {
			t.Fatalf("appraising with a fetched key set: %v", err)
		}
	}
	if fetches != 1 {
		t.Errorf("the key set was fetched %d times; it is cached", fetches)
	}

	// A `kid` nobody published, straight away: refused from the cache. A
	// stream of invented identifiers must not be a stream of outbound
	// requests aimed at the Verifier.
	if _, err := keys.KeysFor(t.Context(), "a-kid-that-is-not-published"); err == nil {
		t.Error("an unknown kid resolved to a key")
	}
	if fetches != 1 {
		t.Errorf("an unknown kid was chased immediately (%d fetches); the refetch is rate-limited", fetches)
	}

	// Past the floor, the same unknown `kid` does force one refetch —
	// otherwise a real rotation would deny every request until the cache
	// expired.
	now = now.Add(swarmevidence.DefaultJWKSMinRefetchInterval + time.Second)
	if _, err := keys.KeysFor(t.Context(), "a-kid-that-is-not-published"); err == nil {
		t.Error("an unknown kid resolved to a key")
	}
	if fetches != 2 {
		t.Errorf("an unknown kid did not force a refetch past the floor (%d fetches)", fetches)
	}
}

// TestHTTPTokenSourceWithoutTheQuoteDoesNotClaimToSubmitIt: a request body of
// literals alone asks the Verifier about nothing in particular, and the
// appraiser must not treat the answer as structurally bound to this quote —
// that is the distinction the report-data check hangs off.
func TestHTTPTokenSourceWithoutTheQuoteDoesNotClaimToSubmitIt(t *testing.T) {
	t.Parallel()

	for _, c := range []struct {
		name    string
		body    map[string]string
		submits bool
	}{
		{"the default body", nil, true},
		{"the quote as base64", map[string]string{"quote": "${quote_base64}"}, true},
		{"the bare TD quote", map[string]string{"q": "${tdx_quote_base64url}", "policy": "none"}, true},
		{"literals only", map[string]string{"policy_ids": "none"}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			source := &swarmevidence.HTTPTokenSource{URL: "https://verifier.invalid", Body: c.body}
			if got := source.SubmitsEvidence(); got != c.submits {
				t.Errorf("SubmitsEvidence() = %v, want %v", got, c.submits)
			}
		})
	}
}

// TestHTTPTokenSourceSubmitsTheQuote covers the live-Verifier source: the
// request body, the headers and where the token sits in the answer are all
// configuration, and the quote it submits is the one it was handed.
func TestHTTPTokenSourceSubmitsTheQuote(t *testing.T) {
	t.Parallel()

	fixture := loadDelegatedFixture(t, "intel-trust-authority")
	evidence := fixture.evidence(t)

	var submitted map[string]string
	var apiKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiKey = r.Header.Get("x-api-key")
		if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"result":{"attestation_token":` + strconvQuote(fixture.Token) + `}}`))
	}))
	t.Cleanup(server.Close)

	source := &swarmevidence.HTTPTokenSource{
		URL:       server.URL + "/appraise/v2/attest",
		Headers:   map[string]string{"x-api-key": "a-tenant-key"},
		Body:      map[string]string{"quote": "${quote_base64}", "policy_ids": "none"},
		TokenPath: swarmevidence.ClaimPath{"result", "attestation_token"},
	}
	if !source.SubmitsEvidence() {
		t.Error("an HTTP token source submits the quote it is given")
	}
	token, err := source.Token(t.Context(), evidence)
	if err != nil {
		t.Fatalf("asking the Verifier: %v", err)
	}
	if token != fixture.Token {
		t.Error("the token read out of the answer is not the one the Verifier returned")
	}
	if apiKey != "a-tenant-key" {
		t.Errorf("the configured header was not sent (got %q)", apiKey)
	}
	if submitted["quote"] != base64.StdEncoding.EncodeToString(evidence) {
		t.Error("the Verifier was not given the quote the appraisal holds")
	}
	if submitted["policy_ids"] != "none" {
		t.Error("a literal member of the configured request body was not sent")
	}
}

// TestClaimPathReadsBothSpellings: a path is configuration, and configuration
// is written by hand. The dotted form is the convenient one; the array form is
// the one that survives a claim name with a dot in it.
func TestClaimPathReadsBothSpellings(t *testing.T) {
	t.Parallel()

	var mapping swarmevidence.ClaimMapping
	document := `{
	  "mrtd": "tdx.tdx_mrtd",
	  "rtmr0": ["submods", "TDX", "ear.veraison.annotated-evidence", "tdx.rtmr0"],
	  "encoding": "base64"
	}`
	if err := json.Unmarshal([]byte(document), &mapping); err != nil {
		t.Fatalf("reading a claim mapping: %v", err)
	}
	if got := []string(mapping.MRTD); len(got) != 2 || got[0] != "tdx" || got[1] != "tdx_mrtd" {
		t.Errorf("the dotted path read as %v", got)
	}
	if got := []string(mapping.RTMR0); len(got) != 4 || got[3] != "tdx.rtmr0" {
		t.Errorf("the array path read as %v", got)
	}
	if mapping.Encoding != swarmevidence.EncodingBase64 {
		t.Errorf("encoding = %q", mapping.Encoding)
	}
}

func flipLastSegment(token string) string {
	segments := strings.Split(token, ".")
	signature, _ := base64.RawURLEncoding.DecodeString(segments[2])
	signature[0] ^= 0xff
	segments[2] = base64.RawURLEncoding.EncodeToString(signature)
	return strings.Join(segments, ".")
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

// staticToken is a token source that answers with one token whatever it is
// asked about.
type staticToken struct {
	token   string
	submits bool
}

func (s *staticToken) Token(context.Context, []byte) (string, error) { return s.token, nil }
func (s *staticToken) SubmitsEvidence() bool                         { return s.submits }
