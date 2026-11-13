package swarmevidence

import (
	"context"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// DelegatedQuoteAppraiser is the [QuoteAppraiser] for a relying party that
// already runs a Verifier and will not deploy a second one for Super Swarm.
//
// It hands the hardware quote to that Verifier, consumes the answer as an
// EAT, and completes the appraisal here with the work a quote-only Verifier
// structurally cannot do: replay the RTMR0 event list, normalise it, compute
// the image identity, and ask who vouches for it.
//
// # Nothing in it names a Verifier
//
// Intel Trust Authority is the stand-in on the demonstration stand, not the
// target: there is no ITA type, no ITA branch and no ITA default anywhere in
// this file. What an EAT calls a TD's measurement registers is not
// standardised — ITA emits `tdx_mrtd`, a Veraison EAR carries annotated
// evidence, Azure MAA uses `x-ms-*` — so the claim names, their encoding, the
// token format, the issuer and the verification keys are all configuration
// ([ClaimMapping], [TokenVerification]). [ITAClaimMapping] is one value of
// that configuration, kept beside the others rather than privileged.
// Swapping Verifiers is a configuration change; it is not a code change here
// and it is not a code change in the policy module, which reads
// [SwarmClaims] and never the token.
//
// # What it still does locally, and why
//
//   - **The binding digest.** [QuoteAppraisal.BindingData] is read out of the
//     quote in hand, never out of the token. A Verifier that does not surface
//     the report data is therefore usable, and a Verifier that surfaces the
//     wrong one cannot make a quote answer a request it does not answer.
//   - **The image identity.** `mrEnclave = SHA-256(TDATTRIBUTES ‖ MRTD ‖
//     normalizedRTMR0 ‖ RTMR1 ‖ RTMR2 ‖ RTMR3)` needs the RTMR0 event log,
//     which no quote-only Verifier consumes. Raw `rtmr0` is not a usable
//     reference value — it accumulates boot events — so a Verifier's result
//     alone is never sufficient evidence of image identity.
//   - **Who vouches for it.** The signed-measurement registry and the relying
//     party's own reference values are consulted here, exactly as on the
//     offline path and through the same code.
//
// # Coverage
//
// It appraises the two Intel TDX branches, `tdx-qemu` and `tdx-gcp`.
// Everything else is refused with a [Denial] at [StageCoverage] naming the
// limitation — never a partial verdict. See [DelegatedQuoteAppraiser.AppraiseQuote].
type DelegatedQuoteAppraiser struct {
	// AppraiserName is reported as the `quote_appraiser` claim, and is what
	// makes the `tcb_status` beside it readable. Name the Verifier, not this
	// adapter: "intel-trust-authority", "veraison-corim-1".
	AppraiserName string

	// Tokens obtains the Verifier's Attestation Result for one quote.
	Tokens TokenSource
	// Token is how that result is authenticated.
	Token TokenVerification
	// Mapping is where the token's claims live.
	Mapping ClaimMapping

	// RootAppraiser appraises the membership root's own embedded quote.
	//
	// It defaults to the built-in offline appraiser, and that default is the
	// architecture rather than a convenience: the bank's Verifier appraises
	// the per-request quote of the evidence collection, and the PKI root's
	// quote is part of the membership chain, which is Super Swarm-specific
	// and therefore ours to check. Set it to this same appraiser to delegate
	// both.
	RootAppraiser QuoteAppraiser

	// Registry decides whether Super Protocol vouches for the image identity
	// computed here. Defaults to the published registry over HTTPS.
	Registry attestedroot.Registry
	// ReferenceValues are the image identities the relying party accepts
	// besides the registry-signed ones.
	ReferenceValues ReferenceValues
	// Now overrides the clock.
	Now func() time.Time

	once     sync.Once
	admitter *attestedroot.Verifier
}

// TokenSource obtains one Attestation Result token.
type TokenSource interface {
	// Token returns the configured Verifier's appraisal of these serialised
	// TeeEvidence octets, as a token in the configured format.
	Token(ctx context.Context, evidence []byte) (string, error)

	// SubmitsEvidence reports whether Token obtained that token by handing
	// the Verifier exactly the octets it was given.
	//
	// It decides one thing, and it is not cosmetic. When it is false the
	// token is relayed — recorded, or carried by the attester — and nothing
	// structural ties it to the quote beside it, so the appraiser requires
	// [ClaimMapping.BindingData] to be configured and checks the token's
	// report data against the quote's. Without that check a holder of any
	// genuine token for a VM could pair it with a quote blob of their own
	// carrying the same registers and a report data they chose, and the
	// binding step would compare against a value they wrote.
	SubmitsEvidence() bool
}

// Name implements [QuoteAppraiser].
func (a *DelegatedQuoteAppraiser) Name() string {
	if a.AppraiserName == "" {
		return "delegated"
	}
	return a.AppraiserName
}

// AppraiseRootQuote implements [QuoteAppraiser] by handing the membership
// root's embedded quote to [DelegatedQuoteAppraiser.RootAppraiser].
func (a *DelegatedQuoteAppraiser) AppraiseRootQuote(
	ctx context.Context, cert *x509.Certificate,
) (*QuoteAppraisal, error) {
	return a.rootAppraiser().AppraiseRootQuote(ctx, cert)
}

func (a *DelegatedQuoteAppraiser) rootAppraiser() QuoteAppraiser {
	if a.RootAppraiser != nil {
		return a.RootAppraiser
	}
	return &BuiltinQuoteAppraiser{
		Registry:        a.Registry,
		ReferenceValues: a.ReferenceValues,
		Now:             a.Now,
	}
}

func (a *DelegatedQuoteAppraiser) now() time.Time {
	if a.Now == nil {
		return time.Now()
	}
	return a.Now()
}

// AppraiseQuote implements [QuoteAppraiser] for the composite form's
// per-request quote.
//
// The order is: read the quote's own structure, refuse a platform outside the
// coverage, obtain and authenticate the token, hold the token's registers
// against the quote's, then complete the appraisal locally. Reading the
// structure first is what lets a refusal name the platform it is refusing;
// authenticating the token before anything is read out of it is what keeps an
// unsigned token from choosing the registers.
func (a *DelegatedQuoteAppraiser) AppraiseQuote(ctx context.Context, quote Quote) (*QuoteAppraisal, error) {
	evidence, err := quote.Evidence()
	if err != nil {
		return nil, fmt.Errorf("the quote's evidence is not base64: %w", err)
	}
	structure, err := attestedroot.ReadQuote(evidence)
	if err != nil {
		return nil, err
	}
	platform, known := platformOf(structure.EvidenceType)
	if !known {
		return nil, errors.New("the quote carries a hardware branch this build does not know, " +
			"so the delegated appraiser cannot say what it would be delegating")
	}
	if denial := coverageDenial(platform); denial != nil {
		return nil, denial
	}
	if a.Tokens == nil {
		return nil, errors.New("no token source is configured, so there is no Verifier to delegate to")
	}

	token, err := a.Tokens.Token(ctx, evidence)
	if err != nil {
		return nil, fmt.Errorf("the configured Verifier did not appraise this quote: %w", err)
	}
	verified, err := verifyEAT(ctx, token, a.Token, a.now())
	if err != nil {
		return nil, fmt.Errorf("the attestation result token: %w", err)
	}

	logs := []string{
		fmt.Sprintf("appraisal delegated to %s; token signed with %s", a.Token.Issuer, verified.Algorithm),
	}
	measurements, err := a.Mapping.measurements(verified.Claims)
	if err != nil {
		return nil, err
	}
	if err := registersAgree(measurements, structure.Measurements); err != nil {
		return nil, err
	}
	logs = append(logs, "the token's measurement registers are the ones this quote carries")

	if err := a.checkTokenReportData(verified.Claims, structure, &logs); err != nil {
		return nil, err
	}
	if svn, ok := a.Mapping.seamSVN(verified.Claims); ok {
		// Reported, not enforced. The register cross-check above already ties
		// the token to this quote, and where the SEAM SVN sits inside
		// TEE_TCB_SVN is a platform detail an incorrect assumption would turn
		// into a false denial on live hardware.
		logs = append(logs, fmt.Sprintf("the Verifier reports SEAM SVN %s against the quote's TEE_TCB_SVN %x",
			svn, structure.TeeTCBSVN))
	}

	mrEnclave, err := attestedroot.TDXMrEnclave(measurements, structure.EventLog)
	if err != nil {
		return nil, err
	}
	logs = append(logs, "RTMR0 replayed and normalised locally; image identity "+hex.EncodeToString(mrEnclave))

	appraisal := &QuoteAppraisal{
		Platform:          platform,
		QuoteVerified:     true,
		BindingData:       structure.ReportData,
		BindingDataSource: bindingDataSourceOf(structure.ReportDataSource),
		Measurements:      measurementsOf(measurements),
		MrEnclave:         hex.EncodeToString(mrEnclave),
		Logs:              logs,
	}
	if status, ok := a.Mapping.tcbStatus(verified.Claims); ok {
		appraisal.TCBStatus = TCBStatus(status)
		appraisal.CollateralChecked = true
	}
	if err := a.admit(ctx, appraisal, structure.EvidenceType, mrEnclave); err != nil {
		return nil, err
	}
	return appraisal, nil
}

// checkTokenReportData holds a relayed token to the quote beside it.
//
// See [TokenSource.SubmitsEvidence] for what this is defending. When the
// token's report data is configured it is compared whatever the source, since
// a Verifier that reports a different one than the quote carries is appraising
// something else; when it is not configured, only a source that submitted
// these octets itself may proceed.
func (a *DelegatedQuoteAppraiser) checkTokenReportData(
	claims map[string]any, structure *attestedroot.QuoteStructure, logs *[]string,
) error {
	reported, present, err := a.Mapping.bindingData(claims)
	if err != nil {
		return err
	}
	if !present {
		if len(a.Mapping.BindingData) > 0 {
			return errors.New("the token carries no value at the configured report-data claim, " +
				"so nothing ties it to the quote it was presented with")
		}
		if !a.Tokens.SubmitsEvidence() {
			return errors.New("this token source relays a token rather than submitting the quote to " +
				"the Verifier, so ClaimMapping.BindingData must name the token's report-data claim; " +
				"without it a genuine token for one VM could be presented beside another quote")
		}
		*logs = append(*logs, "the token was obtained by submitting this quote to the Verifier")
		return nil
	}
	if subtle.ConstantTimeCompare(reported, structure.ReportData) != 1 {
		return fmt.Errorf("the Verifier reports report data %x and the quote carries %x, so the token "+
			"appraises a different quote", reported, structure.ReportData)
	}
	*logs = append(*logs, "the token's report data is the one this quote carries")
	return nil
}

// admit asks who vouches for the image identity, through the same code the
// offline path uses, so the two cannot drift in what they accept.
func (a *DelegatedQuoteAppraiser) admit(
	ctx context.Context, appraisal *QuoteAppraisal, evidence attestedroot.EvidenceType, mrEnclave []byte,
) error {
	a.once.Do(func() {
		a.admitter = &attestedroot.Verifier{
			Registry:            a.Registry,
			TrustedMeasurements: a.ReferenceValues.MrEnclaves,
			Now:                 a.Now,
		}
	})
	verifier := a.admitter
	result := &attestedroot.Result{Measurement: mrEnclave}
	switch {
	case verifier.AdmitMeasurement(ctx, result, evidence):
		appraisal.MrEnclaveApproved = true
		appraisal.MrEnclaveSource = sourceOf(result.MeasurementSource)
	case result.MeasurementUnknown:
		// The registry answered "not one of ours". That is a claim the policy
		// decides on, exactly as on the offline path.
	default:
		return errors.New("the image identity could not be appraised: " + result.Reason)
	}
	appraisal.Logs = append(appraisal.Logs, result.Logs...)
	return nil
}

// coverageDenial refuses a platform the delegated path cannot honestly
// complete, with the reason that platform fails for.
//
// It is a refusal rather than a thinner claim set on purpose: a relying party
// that received `quote_verified: true` with no image identity would have to
// know, from somewhere else, that this platform never produces one.
func coverageDenial(platform Platform) *Denial {
	switch platform {
	case PlatformTDXQemu, PlatformTDXGCP:
		return nil
	case PlatformSNPQemu:
		return denyf(StageCoverage,
			"%s is outside the delegated path's coverage: a SEV-SNP launch measurement is rebuilt "+
				"from the published firmware of the build the VM booted, which no quote-only Verifier "+
				"reports — and the stand-in Verifier appraises Intel TEEs only. Appraise SEV-SNP nodes "+
				"with the built-in offline appraiser",
			platform)
	case PlatformTDXAzure, PlatformSNPAzure:
		return denyf(StageCoverage,
			"%s is outside the delegated path's coverage: on the Azure nested form the hardware "+
				"measurement describes Microsoft's paravisor and the image identity lives in vTPM PCR4 "+
				"and PCR9 (sp-vm/docs/08-azure-attestation.md), so a quote-only Verifier cannot appraise "+
				"the image at all. Appraise Azure nodes with the built-in offline appraiser",
			platform)
	default:
		return denyf(StageCoverage, "%q is not a platform this build appraises", platform)
	}
}

// registersAgree holds the token's registers against the ones the quote
// carries.
//
// Every register the mrEnclave formula consumes is checked, which is what
// binds the token to this quote: a token appraising some other TD disagrees
// about at least one of them. It is also the check that catches a claim
// mapping pointed at the wrong claim, which would otherwise surface as an
// image identity nothing vouches for.
func registersAgree(reported, carried attestedroot.RawMeasurements) error {
	for _, register := range []struct {
		name              string
		reported, carried string
	}{
		{"tdattributes", reported.TDAttributes, carried.TDAttributes},
		{"mrtd", reported.MRTD, carried.MRTD},
		{"rtmr0", reported.RTMR0, carried.RTMR0},
		{"rtmr1", reported.RTMR1, carried.RTMR1},
		{"rtmr2", reported.RTMR2, carried.RTMR2},
		{"rtmr3", reported.RTMR3, carried.RTMR3},
	} {
		if !strings.EqualFold(register.reported, register.carried) {
			return fmt.Errorf("the Verifier reports %s %s and the quote carries %s, so the token "+
				"appraises a different TD", register.name, orNone(register.reported), orNone(register.carried))
		}
	}
	return nil
}

func orNone(value string) string {
	if value == "" {
		return "(nothing)"
	}
	return value
}

// ClaimEncoding is how a token spells an octet string.
type ClaimEncoding string

// The spellings a claim mapping can declare. Hex is the default because it is
// what the claim set itself uses and what Intel Trust Authority emits.
const (
	EncodingHex       ClaimEncoding = "hex"
	EncodingBase64    ClaimEncoding = "base64"
	EncodingBase64URL ClaimEncoding = "base64url"
)

// ClaimPath locates one claim inside a token, as a sequence of JSON object
// members.
//
// It is a sequence rather than a dotted string because claim *names* contain
// dots: a Veraison EAR nests `tdx.mrtd` inside an annotated-evidence object,
// and splitting that on "." would look for a member named "tdx". JSON and YAML
// configuration may still write a path as a plain string when no name in it
// contains a dot, which is the common case.
type ClaimPath []string

// UnmarshalJSON accepts either a dotted string or an array of member names.
func (p *ClaimPath) UnmarshalJSON(octets []byte) error {
	var segments []string
	if err := json.Unmarshal(octets, &segments); err == nil {
		*p = segments
		return nil
	}
	var dotted string
	if err := json.Unmarshal(octets, &dotted); err != nil {
		return errors.New("a claim path is either a dotted string or an array of member names")
	}
	if dotted == "" {
		*p = nil
		return nil
	}
	*p = strings.Split(dotted, ".")
	return nil
}

// MarshalJSON writes the array form, which is the one that round-trips every
// path.
func (p ClaimPath) MarshalJSON() ([]byte, error) { return json.Marshal([]string(p)) }

// String renders the path for an error message.
func (p ClaimPath) String() string { return strings.Join(p, " → ") }

// lookup walks the path, and reports whether it reached a value.
func (p ClaimPath) lookup(claims map[string]any) (any, bool) {
	if len(p) == 0 {
		return nil, false
	}
	var current any = claims
	for _, step := range p {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[step]
		if !ok {
			return nil, false
		}
	}
	if current == nil {
		return nil, false
	}
	return current, true
}

// ClaimMapping says where, in a Verifier's token, the values this appraisal
// needs live — and how that Verifier spells them.
//
// It is the whole of what makes one Verifier different from another here.
// Every measurement path is required: they are the registers the image
// identity is computed from and the ones the token is held against, and a
// mapping missing one would produce an identity derived from a register
// nothing checked.
//
// The JSON names are part of it: a mapping is written by hand, in a Vault
// plug-in's configuration or a deployment's values file, so the member names
// are the claim-set spelling rather than Go's.
type ClaimMapping struct {
	TDAttributes ClaimPath `json:"tdattributes,omitempty"`
	MRTD         ClaimPath `json:"mrtd,omitempty"`
	RTMR0        ClaimPath `json:"rtmr0,omitempty"`
	RTMR1        ClaimPath `json:"rtmr1,omitempty"`
	RTMR2        ClaimPath `json:"rtmr2,omitempty"`
	RTMR3        ClaimPath `json:"rtmr3,omitempty"`

	// SeamSVN is the TDX module security version the Verifier reports. It is
	// recorded in the appraisal log beside the quote's own TEE_TCB_SVN.
	SeamSVN ClaimPath `json:"seamsvn,omitempty"`
	// TCBStatus is the Verifier's verdict about the platform TCB, reported
	// verbatim as the `tcb_status` claim in that Verifier's own vocabulary.
	TCBStatus ClaimPath `json:"tcb_status,omitempty"`
	// BindingData is the quote's report data as the Verifier surfaces it —
	// `attester_held_data`, `report_data`, an EAT nonce. It is never the
	// source of the binding comparison, which reads the quote itself; it is
	// what ties a relayed token to the quote beside it, and
	// [TokenSource.SubmitsEvidence] says when configuring it is mandatory.
	BindingData ClaimPath `json:"binding_data,omitempty"`

	// Encoding is how measurement claims spell their octets; empty means
	// [EncodingHex].
	Encoding ClaimEncoding `json:"encoding,omitempty"`
	// BindingDataEncoding is the same for BindingData, which a Verifier
	// commonly spells differently from the registers; empty means Encoding.
	BindingDataEncoding ClaimEncoding `json:"binding_data_encoding,omitempty"`
}

// ITAClaimMapping is the mapping for Intel Trust Authority, the stand-in
// Verifier on the demonstration stand.
//
// It is a *value*, not a code path: nothing in this package treats it
// specially, and a second Verifier is a second value of the same shape. It
// lives here so the demo stand's configuration is reviewable beside the
// claim names it depends on rather than buried in a deployment.
func ITAClaimMapping() ClaimMapping {
	return ClaimMapping{
		TDAttributes:        ClaimPath{"tdx", "tdx_tdattributes"},
		MRTD:                ClaimPath{"tdx", "tdx_mrtd"},
		RTMR0:               ClaimPath{"tdx", "tdx_rtmr0"},
		RTMR1:               ClaimPath{"tdx", "tdx_rtmr1"},
		RTMR2:               ClaimPath{"tdx", "tdx_rtmr2"},
		RTMR3:               ClaimPath{"tdx", "tdx_rtmr3"},
		SeamSVN:             ClaimPath{"tdx", "tdx_seamsvn"},
		TCBStatus:           ClaimPath{"tdx", "tdx_tcb_status"},
		BindingData:         ClaimPath{"tdx", "attester_held_data"},
		Encoding:            EncodingHex,
		BindingDataEncoding: EncodingBase64URL,
	}
}

// measurements reads the registers the formula consumes.
func (m ClaimMapping) measurements(claims map[string]any) (attestedroot.RawMeasurements, error) {
	var out attestedroot.RawMeasurements
	for _, register := range []struct {
		name   string
		path   ClaimPath
		target *string
	}{
		{"tdattributes", m.TDAttributes, &out.TDAttributes},
		{"mrtd", m.MRTD, &out.MRTD},
		{"rtmr0", m.RTMR0, &out.RTMR0},
		{"rtmr1", m.RTMR1, &out.RTMR1},
		{"rtmr2", m.RTMR2, &out.RTMR2},
		{"rtmr3", m.RTMR3, &out.RTMR3},
	} {
		if len(register.path) == 0 {
			return out, fmt.Errorf("the claim mapping does not say where this Verifier reports %s, "+
				"which the image identity is computed from", register.name)
		}
		octets, err := m.octets(claims, register.path, m.Encoding)
		if err != nil {
			return out, fmt.Errorf("the token's %s claim (%s): %w", register.name, register.path, err)
		}
		if len(octets) == 0 {
			return out, fmt.Errorf("the token carries no %s at %s", register.name, register.path)
		}
		*register.target = hex.EncodeToString(octets)
	}
	return out, nil
}

// bindingData reads the report data the Verifier surfaced, when the mapping
// names one and the token carries it.
func (m ClaimMapping) bindingData(claims map[string]any) ([]byte, bool, error) {
	if len(m.BindingData) == 0 {
		return nil, false, nil
	}
	encoding := m.BindingDataEncoding
	if encoding == "" {
		encoding = m.Encoding
	}
	octets, err := m.octets(claims, m.BindingData, encoding)
	if err != nil {
		return nil, false, fmt.Errorf("the token's report-data claim (%s): %w", m.BindingData, err)
	}
	if len(octets) == 0 {
		return nil, false, nil
	}
	return octets, true, nil
}

// tcbStatus reads the Verifier's TCB verdict as the string it wrote.
func (m ClaimMapping) tcbStatus(claims map[string]any) (string, bool) {
	value, ok := m.TCBStatus.lookup(claims)
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	if !ok || text == "" {
		return "", false
	}
	return text, true
}

// seamSVN reads the SEAM security version, which Verifiers spell as a number
// and occasionally as a string.
func (m ClaimMapping) seamSVN(claims map[string]any) (string, bool) {
	value, ok := m.SeamSVN.lookup(claims)
	if !ok {
		return "", false
	}
	switch svn := value.(type) {
	case string:
		return svn, svn != ""
	case float64:
		return strconv.FormatInt(int64(svn), 10), true
	default:
		return "", false
	}
}

// octets reads one claim and decodes it in the declared encoding.
//
// The encoding is declared rather than sniffed: a 48-octet register is valid
// hex and valid base64 at different lengths, and guessing would make a
// mis-configured mapping produce a plausible wrong answer instead of an
// error.
func (m ClaimMapping) octets(claims map[string]any, path ClaimPath, encoding ClaimEncoding) ([]byte, error) {
	value, ok := path.lookup(claims)
	if !ok {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, fmt.Errorf("is %T, expected a string", value)
	}
	if text == "" {
		return nil, nil
	}
	switch encoding {
	case "", EncodingHex:
		return hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(text), "0x"))
	case EncodingBase64:
		return base64.StdEncoding.DecodeString(text)
	case EncodingBase64URL:
		return base64.RawURLEncoding.DecodeString(strings.TrimRight(text, "="))
	default:
		return nil, fmt.Errorf("unknown claim encoding %q", encoding)
	}
}
