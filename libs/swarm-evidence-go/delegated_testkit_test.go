package swarmevidence_test

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	tdxabi "github.com/google/go-tdx-guest/abi"
	tdxpb "github.com/google/go-tdx-guest/proto/tdx"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// delegatedFixtureDir is where the recorded Verifier fixtures live.
const delegatedFixtureDir = "testdata/delegated"

// delegatedFixtures are the recorded Verifiers, and they appraise the *same*
// quote on purpose.
//
// `intel-trust-authority` is the stand-in on the demonstration stand.
// `acme-ear-verifier` is a second Verifier that shares nothing with it: other
// claim names — nested, and with dots inside the names, as a Veraison EAR has
// — base64 rather than hex, a different issuer, a different signature
// algorithm and a different signing key. A fake that reused ITA's names and
// key would prove nothing about swapping Verifiers, so this one reuses
// neither.
var delegatedFixtures = []string{"intel-trust-authority", "acme-ear-verifier"}

// delegatedFixture is one recorded Verifier: its token, the key set that
// authenticates it, where its claims live, and the quote it appraises.
type delegatedFixture struct {
	Verifier string `json:"verifier"`
	Note     string `json:"note"`
	Issuer   string `json:"issuer"`
	Audience string `json:"audience,omitempty"`
	// JWKS is the Verifier's key set exactly as its endpoint publishes it,
	// and VerificationKeyPEM the same key as a pinned SPKI. Both are
	// committed because both are configurations a relying party runs: a bank
	// that fetches the key set, and one that will not make an outbound
	// request on its credential path.
	JWKS               json.RawMessage `json:"jwks"`
	VerificationKeyPEM string          `json:"verification_key_pem"`
	Token              string          `json:"token"`

	Mapping swarmevidence.ClaimMapping `json:"mapping"`
	Quote   fixtureQuote               `json:"quote"`

	// ExpectedMrEnclave is the image identity this quote normalises to,
	// committed so that a change to the formula, the event replay or the
	// claim mapping fails the vector instead of being agreed on by two paths
	// that drifted together.
	ExpectedMrEnclave string `json:"expected_mrenclave"`
}

// fixtureQuote is the TD the fixture's token appraises. RTMR0 is absent on
// purpose: it is whatever the event list replays to, which is the property the
// normalisation depends on.
type fixtureQuote struct {
	Platform     string              `json:"platform"`
	TDAttributes string              `json:"tdattributes"`
	MRTD         string              `json:"mrtd"`
	RTMR1        string              `json:"rtmr1"`
	RTMR2        string              `json:"rtmr2"`
	RTMR3        string              `json:"rtmr3"`
	TeeTCBSVN    string              `json:"tee_tcb_svn"`
	EventLog     []fixtureEventEntry `json:"event_log"`
	// ReportData is the quote's guest-chosen field, hex: the binding digest
	// of the request the composite fixtures are appraised against.
	ReportData string `json:"report_data"`
}

type fixtureEventEntry struct {
	Type   string `json:"type"`
	Digest string `json:"digest"`
}

func loadDelegatedFixture(t *testing.T, name string) *delegatedFixture {
	t.Helper()
	octets, err := os.ReadFile(filepath.Join(delegatedFixtureDir, name+".json"))
	if err != nil {
		t.Fatalf("reading the %s fixture: %v", name, err)
	}
	var fixture delegatedFixture
	if err := json.Unmarshal(octets, &fixture); err != nil {
		t.Fatalf("parsing the %s fixture: %v", name, err)
	}
	return &fixture
}

// evidence rebuilds the serialised TeeEvidence the fixture's token appraises.
func (f *delegatedFixture) evidence(t *testing.T) []byte {
	t.Helper()
	return tdxTeeEvidence(t, f.Quote)
}

// recordedTokens replays this fixture's token for the quote it was issued for,
// and for nothing else.
func (f *delegatedFixture) recordedTokens(t *testing.T) *swarmevidence.RecordedTokens {
	t.Helper()
	digest := sha256.Sum256(f.evidence(t))
	return &swarmevidence.RecordedTokens{
		Tokens: map[string]string{hex.EncodeToString(digest[:]): f.Token},
	}
}

// verification is how this fixture's token is authenticated: its own issuer,
// and its own key set served from the committed JWKS rather than fetched.
func (f *delegatedFixture) verification(t *testing.T) swarmevidence.TokenVerification {
	t.Helper()
	return swarmevidence.TokenVerification{
		Format:   swarmevidence.TokenJWT,
		Issuer:   f.Issuer,
		Audience: f.Audience,
		Keys:     &swarmevidence.PinnedKeys{Keys: []swarmevidence.PinnedKey{{PEM: f.VerificationKeyPEM}}},
	}
}

// appraiser is the delegated appraiser this fixture configures. The root
// appraiser stays the composite fixtures' stub: the membership root's own
// embedded quote is the membership chain's business, not the bank Verifier's.
func (f *delegatedFixture) appraiser(
	t *testing.T, root swarmevidence.QuoteAppraiser, registry attestedroot.Registry,
) *swarmevidence.DelegatedQuoteAppraiser {
	t.Helper()
	return &swarmevidence.DelegatedQuoteAppraiser{
		AppraiserName: f.Verifier,
		Tokens:        f.recordedTokens(t),
		Token:         f.verification(t),
		Mapping:       f.Mapping,
		RootAppraiser: root,
		Registry:      registry,
		// The recorded tokens are dated, so every fixture run is clocked to
		// just after they were issued.
		Now: func() time.Time { return fixtureIssuedAt.Add(time.Minute) },
	}
}

// tdxTeeEvidence serialises a TeeEvidence protobuf carrying one synthetic TDX
// quote and its RTMR0 event list.
//
// The quote's ECDSA signature is filler, and deliberately so: the delegated
// path's whole premise is that the relying party's own Verifier appraises that
// signature, and this file is about everything else. Every part the delegated
// path reads out of the quote itself — the registers, the event list, the
// guest-chosen field — is real, and is what the assertions are about. A vector
// carrying an Intel-signed quote arrives with the demonstration stand
// (SUP-642); it changes the fixture, not the harness.
func tdxTeeEvidence(t *testing.T, quote fixtureQuote) []byte {
	t.Helper()
	return tdxTeeEvidenceWithRTMR0(t, quote, replayEventLog(t, quote.EventLog, nil))
}

// tdxTeeEvidenceWithRTMR0 is the same, with the register the event list is
// supposed to explain supplied separately — which is how a case builds a quote
// whose event list does not replay to it.
func tdxTeeEvidenceWithRTMR0(t *testing.T, quote fixtureQuote, rtmr0 []byte) []byte {
	t.Helper()

	body := &tdxpb.TDQuoteBody{
		TeeTcbSvn:      unhex(t, quote.TeeTCBSVN),
		MrSeam:         make([]byte, 48),
		MrSignerSeam:   make([]byte, 48),
		SeamAttributes: make([]byte, 8),
		TdAttributes:   unhex(t, quote.TDAttributes),
		Xfam:           make([]byte, 8),
		MrTd:           unhex(t, quote.MRTD),
		MrConfigId:     make([]byte, 48),
		MrOwner:        make([]byte, 48),
		MrOwnerConfig:  make([]byte, 48),
		Rtmrs:          [][]byte{rtmr0, unhex(t, quote.RTMR1), unhex(t, quote.RTMR2), unhex(t, quote.RTMR3)},
		ReportData:     unhex(t, quote.ReportData),
	}
	raw, err := tdxabi.QuoteToAbiBytes(syntheticQuoteV4(body))
	if err != nil {
		t.Fatalf("serialising the synthetic TD quote: %v", err)
	}

	inner := protoBytes(1, raw)
	for _, event := range quote.EventLog {
		entry := append(protoBytes(1, []byte(event.Type)), protoBytes(2, []byte(event.Digest))...)
		inner = append(inner, protoBytes(2, entry)...)
	}
	// Field 2 is intelTdxQemu and field 3 intelTdxGcp: which branch the
	// message carries is what names the platform.
	field := 2
	if quote.Platform == string(swarmevidence.PlatformTDXGCP) {
		field = 3
	}
	return protoBytes(field, inner)
}

// replayEventLog folds an event list into a register, the way the TDX
// specification states it, so the fixtures compute RTMR0 rather than copy the
// implementation's output.
func replayEventLog(t *testing.T, events []fixtureEventEntry, only map[string]bool) []byte {
	t.Helper()
	register := make([]byte, 48)
	for _, event := range events {
		if only != nil && !only[event.Type] {
			continue
		}
		next := sha512.Sum384(append(append([]byte{}, register...), unhex(t, event.Digest)...))
		register = next[:]
	}
	return register
}

// syntheticQuoteV4 wraps a TD quote body in the smallest well-formed V4
// envelope the ABI encoder accepts.
func syntheticQuoteV4(body *tdxpb.TDQuoteBody) *tdxpb.QuoteV4 {
	const (
		certificationDataSize = 459
		signedDataSize        = 593
	)
	return &tdxpb.QuoteV4{
		Header: &tdxpb.Header{
			Version: 4, AttestationKeyType: 2, TeeType: 0x81,
			QeSvn: make([]byte, 2), PceSvn: make([]byte, 2),
			QeVendorId: make([]byte, 16), UserData: make([]byte, 20),
		},
		TdQuoteBody:    body,
		SignedDataSize: signedDataSize,
		SignedData: &tdxpb.Ecdsa256BitQuoteV4AuthData{
			Signature:           make([]byte, 64),
			EcdsaAttestationKey: make([]byte, 64),
			CertificationData: &tdxpb.CertificationData{
				CertificateDataType: 6,
				Size:                certificationDataSize,
				QeReportCertificationData: &tdxpb.QEReportCertificationData{
					QeReport: &tdxpb.EnclaveReport{
						CpuSvn: make([]byte, 16), Reserved1: make([]byte, 28),
						Attributes: make([]byte, 16), MrEnclave: make([]byte, 32),
						Reserved2: make([]byte, 32), MrSigner: make([]byte, 32),
						Reserved3: make([]byte, 96), Reserved4: make([]byte, 60),
						ReportData: make([]byte, 64),
					},
					QeReportSignature: make([]byte, 64),
					QeAuthData:        &tdxpb.QeAuthData{},
					PckCertificateChainData: &tdxpb.PCKCertificateChainData{
						CertificateDataType: 5, Size: 3, PckCertChain: []byte("pck"),
					},
				},
			},
		},
	}
}

// protoBytes writes one length-delimited protobuf field.
func protoBytes(field int, value []byte) []byte {
	out := binary.AppendUvarint(nil, uint64(field)<<3|2)
	out = binary.AppendUvarint(out, uint64(len(value)))
	return append(out, value...)
}

// nonTDXEvidence is the smallest TeeEvidence of a branch the delegated path
// does not cover, for the coverage denials.
func nonTDXEvidence(platform swarmevidence.Platform) []byte {
	switch platform {
	case swarmevidence.PlatformSNPQemu:
		return protoBytes(1, protoBytes(1, protoBytes(1, []byte("an SEV-SNP attestation report"))))
	case swarmevidence.PlatformTDXAzure:
		return protoBytes(4, protoBytes(1, []byte("an HCL report")))
	case swarmevidence.PlatformSNPAzure:
		return protoBytes(5, protoBytes(1, []byte("an HCL report")))
	default:
		return nil
	}
}

// fixtureRegistry is the signed-measurement registry the fixtures are
// appraised against: it vouches for one image and knows nothing of any other.
type fixtureRegistry struct {
	approved string
	err      error
}

func (r *fixtureRegistry) Verify(_ context.Context, mrEnclave []byte, _ attestedroot.EvidenceType) error {
	if r.err != nil {
		return r.err
	}
	if hex.EncodeToString(mrEnclave) == r.approved {
		return nil
	}
	return attestedroot.ErrNotInRegistry
}

// offlineEquivalentAppraiser is the built-in TDX appraisal with the one step
// the delegated path delegates removed: the vendor signature check.
//
// It is what the parity assertion compares against, and it is written out of
// the same exported pieces the built-in appraiser is built from — the quote
// reader, the published mrEnclave formula and the registry admission — so the
// two paths share the formula and nothing else. The delegated path reaches the
// registers through a Verifier's token; this one reads them out of the quote.
// Agreement between them is therefore a property of the claim mapping, which
// is what the test is about.
type offlineEquivalentAppraiser struct {
	registry attestedroot.Registry
	root     swarmevidence.QuoteAppraiser
}

func (a *offlineEquivalentAppraiser) Name() string { return "builtin" }

func (a *offlineEquivalentAppraiser) AppraiseRootQuote(
	ctx context.Context, cert *x509.Certificate,
) (*swarmevidence.QuoteAppraisal, error) {
	return a.root.AppraiseRootQuote(ctx, cert)
}

func (a *offlineEquivalentAppraiser) AppraiseQuote(
	ctx context.Context, quote swarmevidence.Quote,
) (*swarmevidence.QuoteAppraisal, error) {
	evidence, err := quote.Evidence()
	if err != nil {
		return nil, err
	}
	structure, err := attestedroot.ReadQuote(evidence)
	if err != nil {
		return nil, err
	}
	mrEnclave, err := attestedroot.TDXMrEnclave(structure.Measurements, structure.EventLog)
	if err != nil {
		return nil, err
	}

	verifier := &attestedroot.Verifier{Registry: a.registry}
	result := &attestedroot.Result{Measurement: mrEnclave}
	approved := verifier.AdmitMeasurement(ctx, result, structure.EvidenceType)

	appraisal := &swarmevidence.QuoteAppraisal{
		Platform:          platformOfEvidence(structure.EvidenceType),
		QuoteVerified:     true,
		TCBStatus:         swarmevidence.TCBUnknown,
		CollateralChecked: false,
		BindingData:       structure.ReportData,
		BindingDataSource: swarmevidence.BindingFromReportData,
		Measurements: swarmevidence.Measurements{
			TDAttributes: structure.Measurements.TDAttributes,
			MRTD:         structure.Measurements.MRTD,
			RTMR0:        structure.Measurements.RTMR0,
			RTMR1:        structure.Measurements.RTMR1,
			RTMR2:        structure.Measurements.RTMR2,
			RTMR3:        structure.Measurements.RTMR3,
		},
		MrEnclave:         hex.EncodeToString(mrEnclave),
		MrEnclaveApproved: approved,
	}
	if approved {
		appraisal.MrEnclaveSource = swarmevidence.SourceRegistry
	}
	return appraisal, nil
}

func platformOfEvidence(evidence attestedroot.EvidenceType) swarmevidence.Platform {
	if evidence == attestedroot.EvidenceTdxGCP {
		return swarmevidence.PlatformTDXGCP
	}
	return swarmevidence.PlatformTDXQemu
}

// claimsWithout drops the claims an appraiser is *expected* to differ on, so
// the parity assertion is about what the two paths established rather than
// about which of them established it.
//
// Exactly three claims are dropped, and each is the appraiser's own identity
// rather than a fact about the attester: `quote_appraiser` names what ran,
// `tcb_status` is that appraiser's own vocabulary, and `collateral_checked`
// says whether it fetched vendor collateral — which a delegated Verifier
// always does and the built-in one does only when asked. Anything else
// differing is a real disagreement.
var appraiserIdentityClaims = []string{"quote_appraiser", "tcb_status", "collateral_checked"}

func claimsWithout(t *testing.T, claims swarmevidence.SwarmClaims, drop []string) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshalling the claim set: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("re-reading the claim set: %v", err)
	}
	for _, claim := range drop {
		delete(document, claim)
	}
	return document
}

func unhex(t *testing.T, value string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("fixture value %q is not hex: %v", value, err)
	}
	return raw
}

// jsonEqual compares two documents by their canonical JSON, so a difference is
// reported as the documents a reader can diff.
func jsonEqual(t *testing.T, got, want any) (string, string, bool) {
	t.Helper()
	render := func(value any) string {
		encoded, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			t.Fatalf("marshalling for comparison: %v", err)
		}
		return string(encoded)
	}
	a, b := render(got), render(want)
	return a, b, a == b
}

func base64Std(octets []byte) string { return base64.StdEncoding.EncodeToString(octets) }
