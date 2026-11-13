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
	"strings"
	"time"

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
const (
	profileRecorded       = "recorded-offline"
	profileITA            = "ita-stand-in"
	profileSecondVerifier = "second-verifier"
)

// itaClaimNames is the flat, Intel-flavoured spelling: a quote-shaped result
// with one claim per measurement register.
var itaClaimNames = map[string]string{
	"error":               "appraisal_error",
	"platform":            "attester_type",
	"quote_verified":      "attester_evidence_verified",
	"tcb_status":          "attester_tcb_status",
	"collateral_checked":  "attester_collateral_checked",
	"key_binding":         "attester_held_data_binds_key",
	"network_type":        "sp_network_type",
	"binding_data":        "attester_held_data",
	"binding_data_source": "attester_held_data_source",
	"tdattributes":        "tdx_tdattributes",
	"mrtd":                "tdx_mrtd",
	"rtmr0":               "tdx_rtmr0",
	"rtmr1":               "tdx_rtmr1",
	"rtmr2":               "tdx_rtmr2",
	"rtmr3":               "tdx_rtmr3",
	"launch_digest":       "snp_measurement",
	"vmpl":                "snp_vmpl",
	"debug_allowed":       "snp_debug_allowed",
	"ciphertext_hiding":   "snp_ciphertext_hiding",
	"page_swap_disabled":  "snp_page_swap_disabled",
	"snp_firmware_tcb":    "snp_firmware_tcb",
	"report_version":      "report_version",
	"cpu_generation":      "cpu_generation",
	"mrenclave":           "sp_mrenclave",
	"mrenclave_approved":  "sp_mrenclave_approved",
	"mrenclave_source":    "sp_mrenclave_source",
	"spvm_build":          "sp_vm_build",
}

// secondVerifierClaimNames is a nested spelling under different names, the
// shape a Verifier that groups its findings would emit.
var secondVerifierClaimNames = map[string]string{
	"error":               "appraisal.error",
	"platform":            "appraisal.tee.kind",
	"quote_verified":      "appraisal.tee.verified",
	"tcb_status":          "appraisal.tee.tcb",
	"collateral_checked":  "appraisal.tee.collateral_checked",
	"key_binding":         "appraisal.binding.commits_to_key",
	"network_type":        "appraisal.pki.network",
	"binding_data":        "appraisal.binding.held_data",
	"binding_data_source": "appraisal.binding.source",
	"tdattributes":        "appraisal.measurement.td_attributes",
	"mrtd":                "appraisal.measurement.mrtd",
	"rtmr0":               "appraisal.measurement.rtmr.0",
	"rtmr1":               "appraisal.measurement.rtmr.1",
	"rtmr2":               "appraisal.measurement.rtmr.2",
	"rtmr3":               "appraisal.measurement.rtmr.3",
	"launch_digest":       "appraisal.measurement.launch_digest",
	"vmpl":                "appraisal.platform.vmpl",
	"debug_allowed":       "appraisal.platform.debug",
	"ciphertext_hiding":   "appraisal.platform.ciphertext_hiding",
	"page_swap_disabled":  "appraisal.platform.page_swap_disabled",
	"snp_firmware_tcb":    "appraisal.platform.firmware_tcb",
	"report_version":      "appraisal.platform.report_version",
	"cpu_generation":      "appraisal.platform.cpu",
	"mrenclave":           "appraisal.image.identity",
	"mrenclave_approved":  "appraisal.image.approved",
	"mrenclave_source":    "appraisal.image.source",
	"spvm_build":          "appraisal.image.build",
}

// tdxOnly is the honest coverage of a Verifier that appraises Intel TEEs:
// SEV-SNP has no stage 1 at all, and on either Azure branch the hardware
// registers describe Microsoft's paravisor rather than our image.
var tdxOnly = []string{"tdx-qemu", "tdx-gcp"}

func (m *material) profiles() ([]conformance.AppraiserProfile, error) {
	itaPEM, err := publicKeyPEM(m.itaKey)
	if err != nil {
		return nil, err
	}
	secondPEM, err := publicKeyPEM(m.secondVerifierKey)
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
		Platforms: []string{"tdx-qemu", "tdx-gcp", "tdx-azure", "snp-qemu", "snp-azure"},
	}, {
		Name: profileITA,
		Kind: "eat",
		Description: "The stand-in Verifier on the demonstration stand, consumed as an EAT. Flat " +
			"claim names, hex octets, Intel TEEs on bare metal and GCP only — outside that it " +
			"returns a typed denial rather than a partial verdict.",
		TokenFormat:     "jwt",
		Issuer:          "https://portal.trustauthority.intel.com",
		VerificationKey: &conformance.EATKey{KID: "ita-stand-in-1", PEM: itaPEM},
		OctetEncoding:   "hex",
		ClaimNames:      itaClaimNames,
		Platforms:       tdxOnly,
		OutsideCoverage: &conformance.CoverageRefusal{
			Stage: "root-quote",
			Reason: "ita-stand-in appraises Intel TDX quotes on bare metal and GCP only, and this " +
				"evidence is outside that coverage",
		},
	}, {
		Name: profileSecondVerifier,
		Kind: "eat",
		Description: "A second EAT-emitting Verifier, with different claim names, nested claims, " +
			"base64url octets, a different issuer and a different signing key. Nothing about it is " +
			"named in any implementation: it is configuration, and it must appraise this corpus " +
			"into the same claim sets as the other two profiles.",
		TokenFormat:     "jwt",
		Issuer:          "https://verifier.bank.example/eat",
		VerificationKey: &conformance.EATKey{KID: "bank-verifier-2026", PEM: secondPEM},
		OctetEncoding:   "base64url",
		ClaimNames:      secondVerifierClaimNames,
		Platforms:       []string{"tdx-qemu", "tdx-gcp", "tdx-azure", "snp-qemu", "snp-azure"},
	}}, nil
}

// recordTokens re-encodes a case's two recorded appraisals as a token per
// profile. A profile that does not cover an appraisal's platform records an
// empty token for it, which is how the corpus states a coverage limit: the
// appraiser then refuses, and the case says what the refusal must be.
func (m *material) recordTokens(
	profiles []conformance.AppraiserProfile, root, quote conformance.RecordedAppraisal,
) (map[string]conformance.RecordedTokens, error) {
	out := map[string]conformance.RecordedTokens{}
	for _, profile := range profiles {
		if profile.Kind != "eat" {
			continue
		}
		key := m.itaKey
		if profile.Name == profileSecondVerifier {
			key = m.secondVerifierKey
		}

		// An appraisal that is itself a refusal carries no platform, and
		// every profile records it: "I could not reach an answer" is an
		// answer a Verifier gives whatever it covers.
		var tokens conformance.RecordedTokens
		var err error
		if root.Error != "" || profile.Covers(string(root.Platform)) {
			if tokens.Root, err = mintToken(profile, key, root); err != nil {
				return nil, err
			}
		}
		if quote.Error != "" || profile.Covers(string(quote.Platform)) {
			if tokens.Quote, err = mintToken(profile, key, quote); err != nil {
				return nil, err
			}
		}
		out[profile.Name] = tokens
	}
	return out, nil
}

// mintToken writes one recorded appraisal in one profile's spelling and signs
// it. What is recorded is the EAT shape the adapter consumes, not any one
// Verifier's wire format: the stand-in may be replaced, and a corpus written
// against its wire format would have to be rebuilt when it is.
func mintToken(
	profile conformance.AppraiserProfile, key *testca.Key, appraisal conformance.RecordedAppraisal,
) (string, error) {
	claims := map[string]any{
		"iss": profile.Issuer,
		"iat": tokenInstant(issuedAt),
		"nbf": tokenInstant(issuedAt),
		"exp": tokenInstant(notAfter),
	}

	put := func(field string, value any) {
		path, ok := profile.ClaimNames[field]
		if !ok {
			return
		}
		if text, isText := value.(string); isText && text == "" {
			return
		}
		setClaim(claims, path, value)
	}
	putOctets := func(field, hexValue string) error {
		if hexValue == "" {
			return nil
		}
		octets, err := hex.DecodeString(hexValue)
		if err != nil {
			return fmt.Errorf("%s is not hex: %w", field, err)
		}
		switch profile.OctetEncoding {
		case "base64url":
			put(field, base64.RawURLEncoding.EncodeToString(octets))
		default:
			put(field, hexValue)
		}
		return nil
	}

	if appraisal.Error != "" {
		put("error", appraisal.Error)
		return signToken(profile, key, claims)
	}

	put("platform", string(appraisal.Platform))
	put("quote_verified", appraisal.QuoteVerified)
	put("tcb_status", string(appraisal.TCBStatus))
	put("collateral_checked", appraisal.CollateralChecked)
	put("key_binding", appraisal.KeyBinding)
	put("network_type", string(appraisal.NetworkType))
	put("binding_data_source", string(appraisal.BindingDataSource))
	put("vmpl", appraisal.PlatformSecurity.VMPL)
	put("debug_allowed", appraisal.PlatformSecurity.DebugAllowed)
	put("ciphertext_hiding", appraisal.PlatformSecurity.CiphertextHiding)
	put("page_swap_disabled", appraisal.PlatformSecurity.PageSwapDisabled)
	put("snp_firmware_tcb", appraisal.PlatformSecurity.SnpFirmwareTCB)
	put("report_version", appraisal.PlatformSecurity.ReportVersion)
	put("cpu_generation", appraisal.PlatformSecurity.CPUGeneration)
	put("mrenclave_approved", appraisal.MrEnclaveApproved)
	put("mrenclave_source", string(appraisal.MrEnclaveSource))
	put("spvm_build", appraisal.SpvmBuild)

	for field, value := range map[string]string{
		"binding_data":  appraisal.BindingData,
		"mrenclave":     appraisal.MrEnclave,
		"tdattributes":  appraisal.Measurements.TDAttributes,
		"mrtd":          appraisal.Measurements.MRTD,
		"rtmr0":         appraisal.Measurements.RTMR0,
		"rtmr1":         appraisal.Measurements.RTMR1,
		"rtmr2":         appraisal.Measurements.RTMR2,
		"rtmr3":         appraisal.Measurements.RTMR3,
		"launch_digest": appraisal.Measurements.LaunchDigest,
	} {
		if err := putOctets(field, value); err != nil {
			return "", err
		}
	}
	return signToken(profile, key, claims)
}

func setClaim(claims map[string]any, path string, value any) {
	segments := strings.Split(path, ".")
	current := claims
	for _, segment := range segments[:len(segments)-1] {
		nested, ok := current[segment].(map[string]any)
		if !ok {
			nested = map[string]any{}
			current[segment] = nested
		}
		current = nested
	}
	current[segments[len(segments)-1]] = value
}

// signToken produces the compact JWS. RS256 is deterministic — PKCS#1 v1.5 is
// a function of the message and the key — so re-running the generator
// produces the same token, which is what makes a diff in the corpus mean a
// change to the contract.
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
