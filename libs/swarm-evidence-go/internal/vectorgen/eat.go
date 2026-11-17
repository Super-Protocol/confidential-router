package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/conformance"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/internal/testca"
)

// The two appraiser profiles the corpus records tokens for, beside the
// recorded neutral appraisal.
//
// They are deliberately unlike each other in every dimension a Verifier can
// differ in — claim names, nesting, octet encoding, issuer and signing key —
// because that difference is the evidence for the swap acceptance. Two
// profiles that shared a spelling would prove only that the same decoder runs
// twice.
//
// Neither is named after a real Verifier, and that is a rule rather than a
// preference: these tokens are this repository's invention, and a profile
// carrying a vendor's name would publish claim names that vendor does not
// emit. The adapter's configuration for a real Verifier lives beside the
// adapter — see [swarmevidence.ITAClaimMapping], written against Intel's
// published token reference.
const (
	profileRecorded  = "recorded-offline"
	profileVerifierA = "verifier-a"
	profileVerifierB = "verifier-b"
)

// verifierAMapping is a flat spelling with hex octets: one claim per
// measurement register, at the top level of the token.
func verifierAMapping() swarmevidence.ClaimMapping {
	return swarmevidence.ClaimMapping{
		TDAttributes:        swarmevidence.ClaimPath{"td_attributes"},
		MRTD:                swarmevidence.ClaimPath{"mrtd"},
		RTMR0:               swarmevidence.ClaimPath{"rtmr0"},
		RTMR1:               swarmevidence.ClaimPath{"rtmr1"},
		RTMR2:               swarmevidence.ClaimPath{"rtmr2"},
		RTMR3:               swarmevidence.ClaimPath{"rtmr3"},
		SeamSVN:             swarmevidence.ClaimPath{"seam_svn"},
		TCBStatus:           swarmevidence.ClaimPath{"tcb_status"},
		BindingData:         swarmevidence.ClaimPath{"report_data"},
		Encoding:            swarmevidence.EncodingHex,
		BindingDataEncoding: swarmevidence.EncodingHex,
	}
}

// verifierBMapping is the shape a Verifier that groups its findings emits:
// nested claims, one of whose member names contains dots — which is why a
// claim path is a sequence of member names and not a dotted string — base64url
// registers, and a report data spelled in standard base64 rather than in the
// registers' own encoding.
func verifierBMapping() swarmevidence.ClaimMapping {
	const annotated = "ear.veraison.annotated-evidence"
	return swarmevidence.ClaimMapping{
		TDAttributes:        swarmevidence.ClaimPath{annotated, "tdx", "attributes"},
		MRTD:                swarmevidence.ClaimPath{annotated, "tdx", "measurement"},
		RTMR0:               swarmevidence.ClaimPath{annotated, "tdx", "rtmr", "0"},
		RTMR1:               swarmevidence.ClaimPath{annotated, "tdx", "rtmr", "1"},
		RTMR2:               swarmevidence.ClaimPath{annotated, "tdx", "rtmr", "2"},
		RTMR3:               swarmevidence.ClaimPath{annotated, "tdx", "rtmr", "3"},
		TCBStatus:           swarmevidence.ClaimPath{"ear.status"},
		BindingData:         swarmevidence.ClaimPath{annotated, "tdx", "held_data"},
		Encoding:            swarmevidence.EncodingBase64URL,
		BindingDataEncoding: swarmevidence.EncodingBase64,
	}
}

// delegatedCoverage is what the delegated path appraises, and it is the
// production coverage rather than a profile's own invention: everything else
// is denied at the `coverage` stage with the reason that platform fails for
// (see DelegatedQuoteAppraiser.AppraiseQuote). A profile that claimed more
// would be contradicted by the first case that used it.
var delegatedCoverage = []string{
	string(swarmevidence.PlatformTDXQemu), string(swarmevidence.PlatformTDXGCP),
}

// allPlatforms is the offline appraiser's coverage: the whole fleet.
var allPlatforms = []string{
	string(swarmevidence.PlatformTDXQemu), string(swarmevidence.PlatformTDXGCP),
	string(swarmevidence.PlatformTDXAzure),
	string(swarmevidence.PlatformSNPQemu), string(swarmevidence.PlatformSNPAzure),
}

// outsideCoverage is the refusal both delegated profiles answer with for a
// platform the delegated path does not cover. The stage is `coverage` and not
// `root-quote`: it says nothing about the evidence, and what clears it is a
// different appraiser rather than a different attester (DENIAL-STAGES.md).
func outsideCoverage() *conformance.CoverageRefusal {
	return &conformance.CoverageRefusal{
		Stage: string(swarmevidence.StageCoverage),
		Reason: "the attester's platform is outside the delegated path's coverage: a quote-only " +
			"Verifier reports no image identity for it, and this corpus records a typed denial " +
			"rather than a partial verdict",
	}
}

func (m *material) profiles() ([]conformance.AppraiserProfile, error) {
	keyA, err := publicKeyPEM(m.verifierAKey)
	if err != nil {
		return nil, err
	}
	keyB, err := publicKeyPEM(m.verifierBKey)
	if err != nil {
		return nil, err
	}

	return []conformance.AppraiserProfile{{
		Name: profileRecorded,
		Kind: "recorded",
		Description: "The quote appraisal as the fixture records it, in the claim set's own spelling. " +
			"It stands for the built-in offline appraiser: no fixture can carry a hardware signature " +
			"over a request this repository invented, so the corpus holds the quote appraisal fixed " +
			"and pins everything downstream of it.",
		Platforms: allPlatforms,
	}, {
		Name: profileVerifierA,
		Kind: "eat",
		Description: "A Verifier consumed as an EAT, through the production delegated appraiser: " +
			"flat claim names, hex octets, its own issuer and signing key. It appraises the quote's " +
			"signature and reports the registers; the image identity is derived locally from the " +
			"RTMR0 event list, which no quote-only Verifier consumes.",
		TokenFormat:     string(swarmevidence.TokenJWT),
		Issuer:          "https://verifier-a.example/attestation",
		VerificationKey: &conformance.EATKey{KID: "verifier-a-2026", PEM: keyA},
		ClaimMapping:    verifierAMapping(),
		Platforms:       delegatedCoverage,
		OutsideCoverage: outsideCoverage(),
	}, {
		Name: profileVerifierB,
		Kind: "eat",
		Description: "A second EAT-emitting Verifier, with nested claim names that share none of " +
			"the first's, base64url registers, a base64 report data, a different issuer and a " +
			"different signing key. Nothing about it is named in any implementation: it is " +
			"configuration, and it must appraise this corpus into the same claim sets as the other " +
			"two profiles.",
		TokenFormat:     string(swarmevidence.TokenJWT),
		Issuer:          "https://verifier.bank.example/eat",
		VerificationKey: &conformance.EATKey{KID: "bank-verifier-2026", PEM: keyB},
		ClaimMapping:    verifierBMapping(),
		Platforms:       delegatedCoverage,
		OutsideCoverage: outsideCoverage(),
	}}, nil
}

// recordTokens records what each Verifier answered about this case's quote.
//
// A profile that does not cover the quote's platform records no token at all,
// which is how the corpus states a coverage limit: the delegated appraiser
// denies at `coverage` before it asks a Verifier anything, so a token for
// that case would be a fixture nothing reads.
func (m *material) recordTokens(
	profiles []conformance.AppraiserProfile, quote *tdxQuote, tcbStatus swarmevidence.TCBStatus,
) (map[string]conformance.RecordedTokens, error) {
	out := map[string]conformance.RecordedTokens{}
	for _, profile := range profiles {
		if profile.Kind != "eat" {
			continue
		}
		tokens := conformance.RecordedTokens{Tokens: map[string]string{}}
		if quote != nil && profile.Covers(string(quote.platform)) {
			evidence, err := quote.evidence()
			if err != nil {
				return nil, err
			}
			token, err := mintToken(profile, m.signingKey(profile.Name), quote, tcbStatus)
			if err != nil {
				return nil, err
			}
			digest := sha256.Sum256(evidence)
			tokens.Tokens[hexOf(digest[:])] = token
		}
		out[profile.Name] = tokens
	}
	return out, nil
}

func (m *material) signingKey(profile string) *testca.Key {
	if profile == profileVerifierB {
		return m.verifierBKey
	}
	return m.verifierAKey
}

// mintToken writes one Verifier's answer about one quote, in that Verifier's
// spelling, and signs it.
//
// What a Verifier reports is what a Verifier can report: the registers it read
// out of the quote it appraised, the TCB verdict it reached, and the report
// data it saw. Nothing about the image — `mrenclave`, whether anybody vouches
// for it, which sp-vm release it is — is in a token, because a quote-only
// Verifier does not know any of it: the RTMR0 event list it never consumed is
// what the identity is derived from. A corpus whose tokens carried the
// finished answer would be a corpus the delegated appraiser could not be run
// against.
func mintToken(
	profile conformance.AppraiserProfile, key *testca.Key, quote *tdxQuote, tcbStatus swarmevidence.TCBStatus,
) (string, error) {
	claims := map[string]any{
		"iss": profile.Issuer,
		"iat": tokenInstant(issuedAt),
		"nbf": tokenInstant(issuedAt),
		"exp": tokenInstant(notAfter),
	}
	mapping := profile.ClaimMapping

	put := func(path swarmevidence.ClaimPath, value any) {
		if len(path) == 0 {
			return
		}
		setClaim(claims, path, value)
	}
	putOctets := func(path swarmevidence.ClaimPath, encoding swarmevidence.ClaimEncoding, hexValue string) error {
		if len(path) == 0 || hexValue == "" {
			return nil
		}
		octets, err := hex.DecodeString(hexValue)
		if err != nil {
			return fmt.Errorf("%s is not hex: %w", path, err)
		}
		switch encoding {
		case swarmevidence.EncodingBase64:
			put(path, base64.StdEncoding.EncodeToString(octets))
		case swarmevidence.EncodingBase64URL:
			put(path, base64.RawURLEncoding.EncodeToString(octets))
		default:
			put(path, hexValue)
		}
		return nil
	}

	for _, register := range []struct {
		path  swarmevidence.ClaimPath
		value string
	}{
		{mapping.TDAttributes, quote.tdAttributes},
		{mapping.MRTD, quote.mrtd},
		{mapping.RTMR0, quote.rtmr0},
		{mapping.RTMR1, quote.rtmr1},
		{mapping.RTMR2, quote.rtmr2},
		{mapping.RTMR3, quote.rtmr3},
	} {
		if err := putOctets(register.path, mapping.Encoding, register.value); err != nil {
			return "", err
		}
	}
	bindingEncoding := mapping.BindingDataEncoding
	if bindingEncoding == "" {
		bindingEncoding = mapping.Encoding
	}
	if err := putOctets(mapping.BindingData, bindingEncoding, quote.reportData); err != nil {
		return "", err
	}
	put(mapping.TCBStatus, string(tcbStatus))
	// The SEAM security version is reported beside the quote's own
	// TEE_TCB_SVN and never enforced, so one profile maps it and the other
	// does not: it is optional configuration, and the corpus says so by
	// exercising both.
	put(mapping.SeamSVN, seamSVN)

	return signToken(profile, key, claims)
}

// seamSVN is the TDX module security version the Verifier reports. It matches
// the first octet of the fixtures' TEE_TCB_SVN, which is what a reader
// comparing the two is checking.
const seamSVN = 5

func setClaim(claims map[string]any, path swarmevidence.ClaimPath, value any) {
	current := claims
	for _, segment := range path[:len(path)-1] {
		nested, ok := current[segment].(map[string]any)
		if !ok {
			nested = map[string]any{}
			current[segment] = nested
		}
		current = nested
	}
	current[path[len(path)-1]] = value
}

// signToken produces the compact JWS. RS256 is deterministic — PKCS#1 v1.5 is
// a function of the message and the key — so re-running the generator
// produces the same token, which is what makes a diff in the corpus mean a
// change to the contract. Both profiles sign with it for that reason and not
// because the adapter requires it: PS* and ES* are randomised, and a corpus
// signed with one of them could not be regenerated as a no-op.
func signToken(profile conformance.AppraiserProfile, key *testca.Key, claims map[string]any) (string, error) {
	header, err := json.Marshal(map[string]string{
		"alg": "RS256", "typ": "JWT", "kid": profile.VerificationKey.KID,
	})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := b64(header) + "." + b64(payload)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key.RSA, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + b64(signature), nil
}

func tokenInstant(value string) int64 {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		panic("vectorgen: " + value + " is not RFC 3339: " + err.Error())
	}
	return parsed.Unix()
}
