package conformance

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
)

// NewAppraiser builds the quote appraiser one profile describes for one case.
//
// Every profile is built from the manifest and the case fixture alone: no
// Verifier is named in this file, and adding a third profile is a change to
// the vectors, not to any code. That is the property SUP-648's swap
// acceptance rests on, and it is checked here rather than asserted in a
// document.
func NewAppraiser(profile AppraiserProfile, file AppraisalFile, now time.Time) (swarmevidence.QuoteAppraiser, error) {
	switch profile.Kind {
	case "recorded":
		return &recordedAppraiser{name: profile.Name, root: file.Root, quote: file.Quote}, nil
	case "eat":
		tokens, ok := file.EAT[profile.Name]
		if !ok {
			// The profile records nothing for this case at all, which is how
			// a corpus states that it covers none of it. A Verifier that
			// cannot appraise the evidence must say so; a partial verdict
			// would be worse than nothing.
			refusal := profile.OutsideCoverage
			if refusal == nil {
				return nil, fmt.Errorf("profile %q records no token for this case and declares no outsideCoverage",
					profile.Name)
			}
			return &refusingAppraiser{name: profile.Name, reason: refusal.Reason}, nil
		}
		if profile.VerificationKey == nil {
			return nil, fmt.Errorf("profile %q has no verification key", profile.Name)
		}
		if len(profile.Platforms) == 0 {
			// Coverage is not optional: it is what a case's expectation is
			// written against, and a profile that declared none would be
			// read as "covers nothing" by the generator and as "covers
			// everything" by any appraiser that defaulted the other way.
			return nil, fmt.Errorf("profile %q declares no platforms", profile.Name)
		}
		key, err := parseRSAPublicKey(profile.VerificationKey.PEM)
		if err != nil {
			return nil, fmt.Errorf("profile %q verification key: %w", profile.Name, err)
		}
		return &eatAppraiser{profile: profile, key: key, tokens: tokens, now: now}, nil
	default:
		return nil, fmt.Errorf("profile %q has unknown kind %q", profile.Name, profile.Kind)
	}
}

// recordedAppraiser replays the appraisal the fixture records, in the neutral
// spelling. It stands for the offline built-in appraiser: everything the
// corpus pins is downstream of this answer, so holding the answer fixed is
// what makes the rest of the appraisal comparable across paths.
type recordedAppraiser struct {
	name        string
	root, quote RecordedAppraisal
}

func (a *recordedAppraiser) Name() string { return a.name }

func (a *recordedAppraiser) AppraiseRootQuote(
	context.Context, *x509.Certificate,
) (*swarmevidence.QuoteAppraisal, error) {
	return a.root.appraisal()
}

func (a *recordedAppraiser) AppraiseQuote(
	context.Context, swarmevidence.Quote,
) (*swarmevidence.QuoteAppraisal, error) {
	return a.quote.appraisal()
}

// refusingAppraiser is a Verifier asked for evidence outside its coverage.
type refusingAppraiser struct{ name, reason string }

func (a *refusingAppraiser) Name() string { return a.name }

func (a *refusingAppraiser) AppraiseRootQuote(
	context.Context, *x509.Certificate,
) (*swarmevidence.QuoteAppraisal, error) {
	return nil, errors.New(a.reason)
}

func (a *refusingAppraiser) AppraiseQuote(
	context.Context, swarmevidence.Quote,
) (*swarmevidence.QuoteAppraisal, error) {
	return nil, errors.New(a.reason)
}

// eatAppraiser consumes the recorded Entity Attestation Tokens of one
// profile.
//
// It is the corpus's own appraiser, not the production adapter of SUP-648:
// what it exists to demonstrate is that two profiles whose claim names,
// octet encodings and signing keys all differ appraise the corpus into the
// same claim sets. The production adapter is held to the same vectors.
type eatAppraiser struct {
	profile AppraiserProfile
	key     *rsa.PublicKey
	tokens  RecordedTokens
	now     time.Time
}

func (a *eatAppraiser) Name() string { return a.profile.Name }

func (a *eatAppraiser) AppraiseRootQuote(
	context.Context, *x509.Certificate,
) (*swarmevidence.QuoteAppraisal, error) {
	return a.appraise(a.tokens.Root)
}

func (a *eatAppraiser) AppraiseQuote(
	context.Context, swarmevidence.Quote,
) (*swarmevidence.QuoteAppraisal, error) {
	return a.appraise(a.tokens.Quote)
}

func (a *eatAppraiser) appraise(token string) (*swarmevidence.QuoteAppraisal, error) {
	if token == "" {
		// No result was recorded for this half of the appraisal, because this
		// profile does not cover its platform. The refusal is per appraisal
		// rather than per case: a Verifier may well be able to appraise the
		// membership root's own quote and not the per-request one beside it.
		if a.profile.OutsideCoverage == nil {
			return nil, fmt.Errorf("%s recorded no result and declares no outsideCoverage", a.profile.Name)
		}
		return nil, errors.New(a.profile.OutsideCoverage.Reason)
	}
	claims, err := a.verify(token)
	if err != nil {
		return nil, fmt.Errorf("the attestation result from %s could not be read: %w", a.profile.Name, err)
	}
	recorded, err := a.decode(claims)
	if err != nil {
		return nil, err
	}
	appraisal, err := recorded.appraisal()
	if err != nil {
		return nil, err
	}
	if !a.profile.Covers(string(recorded.Platform)) {
		// A token for a platform the profile does not cover is a
		// configuration mistake rather than evidence: refuse it here instead
		// of reporting claims nobody appraised.
		return nil, fmt.Errorf("%s does not appraise %s quotes", a.profile.Name, recorded.Platform)
	}
	return appraisal, nil
}

// verify checks the token the way the adapter is configured to: the format,
// the pinned key, the issuer and the validity window. All four are
// configuration.
func (a *eatAppraiser) verify(token string) (map[string]any, error) {
	if a.profile.TokenFormat != "" && a.profile.TokenFormat != "jwt" {
		return nil, fmt.Errorf("unsupported token format %q", a.profile.TokenFormat)
	}
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		return nil, errors.New("not a compact JWS")
	}
	var header struct {
		Alg string `json:"alg"`
		KID string `json:"kid"`
	}
	if err := decodeSegment(segments[0], &header); err != nil {
		return nil, fmt.Errorf("header: %w", err)
	}
	if header.Alg != "RS256" {
		return nil, fmt.Errorf("unsupported algorithm %q", header.Alg)
	}
	if want := a.profile.VerificationKey.KID; want != "" && header.KID != want {
		return nil, fmt.Errorf("signed by key %q, the profile pins %q", header.KID, want)
	}
	signature, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil {
		return nil, fmt.Errorf("signature: %w", err)
	}
	digest := sha256.Sum256([]byte(segments[0] + "." + segments[1]))
	if err := rsa.VerifyPKCS1v15(a.key, crypto.SHA256, digest[:], signature); err != nil {
		return nil, fmt.Errorf("signature does not verify under the pinned key: %w", err)
	}

	var claims map[string]any
	if err := decodeSegment(segments[1], &claims); err != nil {
		return nil, fmt.Errorf("claims: %w", err)
	}
	if issuer, _ := claims["iss"].(string); a.profile.Issuer != "" && issuer != a.profile.Issuer {
		return nil, fmt.Errorf("issued by %q, the profile pins %q", issuer, a.profile.Issuer)
	}
	if err := a.checkValidity(claims); err != nil {
		return nil, err
	}
	return claims, nil
}

func (a *eatAppraiser) checkValidity(claims map[string]any) error {
	if a.now.IsZero() {
		return nil
	}
	if nbf, ok := claims["nbf"].(float64); ok && a.now.Before(time.Unix(int64(nbf), 0)) {
		return errors.New("the attestation result is not valid yet")
	}
	if exp, ok := claims["exp"].(float64); ok && a.now.After(time.Unix(int64(exp), 0)) {
		return errors.New("the attestation result has expired")
	}
	return nil
}

// decode maps a token's claims onto the neutral appraisal, by the paths the
// profile configures. No claim name appears in this function.
func (a *eatAppraiser) decode(claims map[string]any) (RecordedAppraisal, error) {
	var out RecordedAppraisal
	text := func(field string) string { return claimString(claims, a.profile.ClaimNames[field]) }
	flag := func(field string) bool { return claimBool(claims, a.profile.ClaimNames[field]) }
	number := func(field string) uint64 { return claimUint(claims, a.profile.ClaimNames[field]) }
	octets := func(field string) (string, error) {
		return a.decodeOctets(claimString(claims, a.profile.ClaimNames[field]))
	}

	if reason := text("error"); reason != "" {
		out.Error = reason
		return out, nil
	}

	var err error
	out.Platform = swarmevidence.Platform(text("platform"))
	out.QuoteVerified = flag("quote_verified")
	out.TCBStatus = swarmevidence.TCBStatus(text("tcb_status"))
	out.CollateralChecked = flag("collateral_checked")
	out.KeyBinding = flag("key_binding")
	out.NetworkType = swarmevidence.NetworkType(text("network_type"))
	out.BindingDataSource = swarmevidence.BindingDataSource(text("binding_data_source"))
	out.MrEnclaveApproved = flag("mrenclave_approved")
	out.MrEnclaveSource = swarmevidence.MrEnclaveSource(text("mrenclave_source"))
	out.SpvmBuild = text("spvm_build")
	out.PlatformSecurity = swarmevidence.PlatformSecurity{
		VMPL:             uint32(number("vmpl")),
		DebugAllowed:     flag("debug_allowed"),
		CiphertextHiding: flag("ciphertext_hiding"),
		PageSwapDisabled: flag("page_swap_disabled"),
		SnpFirmwareTCB:   uint8(number("snp_firmware_tcb")),
		ReportVersion:    uint32(number("report_version")),
		CPUGeneration:    text("cpu_generation"),
	}

	for field, target := range map[string]*string{
		"binding_data":  &out.BindingData,
		"mrenclave":     &out.MrEnclave,
		"tdattributes":  &out.Measurements.TDAttributes,
		"mrtd":          &out.Measurements.MRTD,
		"rtmr0":         &out.Measurements.RTMR0,
		"rtmr1":         &out.Measurements.RTMR1,
		"rtmr2":         &out.Measurements.RTMR2,
		"rtmr3":         &out.Measurements.RTMR3,
		"launch_digest": &out.Measurements.LaunchDigest,
	} {
		if *target, err = octets(field); err != nil {
			return out, fmt.Errorf("%s claim of %s: %w", field, a.profile.Name, err)
		}
	}
	return out, nil
}

// decodeOctets re-spells an octet-valued claim as the hex the claim set
// publishes. Which spelling a Verifier emits is configuration, not a reason
// for a second code path.
func (a *eatAppraiser) decodeOctets(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	switch a.profile.OctetEncoding {
	case "", "hex":
		if _, err := hex.DecodeString(value); err != nil {
			return "", fmt.Errorf("not hex: %w", err)
		}
		return value, nil
	case "base64url":
		decoded, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil {
			return "", fmt.Errorf("not unpadded base64url: %w", err)
		}
		return hex.EncodeToString(decoded), nil
	default:
		return "", fmt.Errorf("unknown octet encoding %q", a.profile.OctetEncoding)
	}
}

// appraisal turns the neutral recorded form into what the claim core
// consumes, and keeps the one distinction the seam is about: an appraiser
// that could not reach an answer returns an error, never a populated
// appraisal.
func (r RecordedAppraisal) appraisal() (*swarmevidence.QuoteAppraisal, error) {
	if r.Error != "" {
		return nil, errors.New(r.Error)
	}
	binding, err := hex.DecodeString(r.BindingData)
	if err != nil {
		return nil, fmt.Errorf("the recorded binding data is not hex: %w", err)
	}
	return &swarmevidence.QuoteAppraisal{
		Platform:          r.Platform,
		QuoteVerified:     r.QuoteVerified,
		TCBStatus:         r.TCBStatus,
		CollateralChecked: r.CollateralChecked,
		KeyBinding:        r.KeyBinding,
		NetworkType:       r.NetworkType,
		BindingData:       binding,
		BindingDataSource: r.BindingDataSource,
		Measurements:      r.Measurements,
		PlatformSecurity:  r.PlatformSecurity,
		MrEnclave:         r.MrEnclave,
		MrEnclaveApproved: r.MrEnclaveApproved,
		MrEnclaveSource:   r.MrEnclaveSource,
		SpvmBuild:         r.SpvmBuild,
	}, nil
}

// claimAt walks a dotted claim path.
func claimAt(claims map[string]any, path string) any {
	if path == "" {
		return nil
	}
	var current any = claims
	for _, segment := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current, ok = object[segment]
		if !ok {
			return nil
		}
	}
	return current
}

func claimString(claims map[string]any, path string) string {
	value, _ := claimAt(claims, path).(string)
	return value
}

func claimBool(claims map[string]any, path string) bool {
	value, _ := claimAt(claims, path).(bool)
	return value
}

func claimUint(claims map[string]any, path string) uint64 {
	switch value := claimAt(claims, path).(type) {
	case float64:
		if value < 0 {
			return 0
		}
		return uint64(value)
	case string:
		parsed, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

func decodeSegment(segment string, into any) error {
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}

func parseRSAPublicKey(pemData string) (*rsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil {
		return nil, errors.New("no PEM block")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("%T is not an RSA public key", parsed)
	}
	return key, nil
}
