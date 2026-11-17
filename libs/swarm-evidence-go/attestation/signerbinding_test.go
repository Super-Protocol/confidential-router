package attestation_test

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"testing"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/internal/testca"
)

// TestReadSignerBinding is the matrix of what a signer's certificate can say
// about the key that signed with it.
//
// It is the one reading in this package that an enterprise policy turns into a
// yes or a no — "the key that signed this statement was certified against
// measured hardware" — so each case names the leaf the authority would have
// issued and the word the claim set must carry for it. The unrecognised and
// unlabelled cases are the load-bearing ones: both must fail closed.
func TestReadSignerBinding(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name            string
		leaf            func(base testca.Template) testca.Template
		wantKind        attestation.SignerBindingKind
		wantChallenge   attestation.SignerChallengeType
		wantSubtype     attestation.SignerChallengeType
		wantEmbeddedTEE bool
	}{{
		name: "a key certified against a bare-metal TDX quote",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "tdx"
			return base
		},
		wantKind:      attestation.SignerBindingQuote,
		wantChallenge: attestation.ChallengeTDX,
	}, {
		name: "a key certified against an Azure SEV-SNP quote",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "sev-snp-azure"
			return base
		},
		wantKind:      attestation.SignerBindingQuote,
		wantChallenge: attestation.ChallengeSNPAzure,
	}, {
		name: "a hardware-challenged leaf that embeds its own quote",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "tdx-google"
			base.TEEEvidence = []byte("serialised TeeEvidence")
			return base
		},
		wantKind:        attestation.SignerBindingQuote,
		wantChallenge:   attestation.ChallengeTDXGoogle,
		wantEmbeddedTEE: true,
	}, {
		name: "a key certified against a certificate that was itself hardware-challenged",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "certificate"
			base.ChallengeSubtype = "tdx"
			return base
		},
		wantKind:      attestation.SignerBindingAttestedCertificate,
		wantChallenge: attestation.ChallengeCertificate,
		wantSubtype:   attestation.ChallengeTDX,
	}, {
		// A certificate challenge is only as strong as the certificate
		// presented. With no hardware subtype the chain behind it is unknown,
		// and reporting `attested-certificate` would overstate it.
		name: "a certificate challenge with no hardware subtype",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "certificate"
			return base
		},
		wantKind:      attestation.SignerBindingUnknown,
		wantChallenge: attestation.ChallengeCertificate,
	}, {
		name: "a certificate challenge whose subtype is a bearer token",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "certificate"
			base.ChallengeSubtype = "token"
			return base
		},
		wantKind:      attestation.SignerBindingUnknown,
		wantChallenge: attestation.ChallengeCertificate,
		wantSubtype:   attestation.ChallengeToken,
	}, {
		name: "a key certified against a bearer token every node holds",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "token"
			return base
		},
		wantKind:      attestation.SignerBindingSecret,
		wantChallenge: attestation.ChallengeToken,
	}, {
		name: "a key certified against no proof at all",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "untrusted"
			return base
		},
		wantKind:      attestation.SignerBindingSecret,
		wantChallenge: attestation.ChallengeUntrusted,
	}, {
		// A leaf from outside this PKI, or one issued before the authority
		// recorded the challenge. Guessing hardware here is the one mistake
		// that would make the whole reading worse than useless.
		name:     "an unlabelled leaf, carrying no challenge extension",
		leaf:     func(base testca.Template) testca.Template { return base },
		wantKind: attestation.SignerBindingUnknown,
	}, {
		// Matched exactly, never scanned: a simulator, a debug mode or a
		// platform nobody has evaluated whose name contains `tdx` must not
		// read as a genuine Intel TDX quote.
		name: "a challenge type outside the closed set, whose name contains a hardware one",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "tdx-simulator"
			return base
		},
		wantKind: attestation.SignerBindingUnknown,
	}, {
		name: "a challenge type in the wrong case",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = "TDX"
			return base
		},
		wantKind: attestation.SignerBindingUnknown,
	}, {
		// The authority writes the value as bare ASCII, and a generator that
		// wrapped it in a DER string denotes the same extension. Reading one
		// spelling and not the other would refuse leaves the platform's own
		// verifier accepts.
		name: "a challenge type a generator wrapped in a DER UTF8String",
		leaf: func(base testca.Template) testca.Template {
			base.ExtraExtensions = []pkix.Extension{{
				Id:    testca.OIDChallengeType,
				Value: mustMarshalASN1(t, "tdx"),
			}}
			return base
		},
		wantKind:      attestation.SignerBindingQuote,
		wantChallenge: attestation.ChallengeTDX,
	}, {
		name: "a challenge type padded with whitespace and a trailing NUL",
		leaf: func(base testca.Template) testca.Template {
			base.ChallengeType = " sev-snp\x00"
			return base
		},
		wantKind:      attestation.SignerBindingQuote,
		wantChallenge: attestation.ChallengeSNP,
	}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			kit := testKitFor(t)
			leaf := issue(t, tc.leaf(signerTemplate(t)), testca.RSA, kit.rsaInter)

			chain, err := attestation.ValidateChain(
				[]string{leaf.PEM, kit.rsaInter.PEM, kit.rsaRoot.PEM}, mustTime(t, testNow))
			if err != nil {
				t.Fatalf("validate the chain the binding is read off: %v", err)
			}

			binding := attestation.ReadSignerBinding(chain)
			if binding.Kind != tc.wantKind {
				t.Errorf("kind = %q, want %q", binding.Kind, tc.wantKind)
			}
			if binding.ChallengeType != tc.wantChallenge {
				t.Errorf("challenge type = %q, want %q", binding.ChallengeType, tc.wantChallenge)
			}
			if binding.ChallengeSubtype != tc.wantSubtype {
				t.Errorf("challenge subtype = %q, want %q", binding.ChallengeSubtype, tc.wantSubtype)
			}
			if binding.TEEEvidenceEmbedded != tc.wantEmbeddedTEE {
				t.Errorf("tee evidence embedded = %v, want %v",
					binding.TEEEvidenceEmbedded, tc.wantEmbeddedTEE)
			}

			// HardwareBound is stated once so no caller re-derives it, which
			// means it may never disagree with the kind beside it.
			wantHardware := tc.wantKind == attestation.SignerBindingQuote ||
				tc.wantKind == attestation.SignerBindingAttestedCertificate
			if binding.HardwareBound != wantHardware {
				t.Errorf("hardware bound = %v for kind %q, want %v",
					binding.HardwareBound, binding.Kind, wantHardware)
			}
		})
	}
}

// TestReadSignerBindingWithoutAChain is the fail-closed default for a caller
// that has nothing validated to read: no chain cannot read as hardware-bound.
func TestReadSignerBindingWithoutAChain(t *testing.T) {
	t.Parallel()
	binding := attestation.ReadSignerBinding(nil)
	if binding.Kind != attestation.SignerBindingUnknown || binding.HardwareBound {
		t.Errorf("binding = %+v, want an unknown, not-hardware-bound default", binding)
	}
}

// TestReadSignerBindingReadsTheLeafNotTheRoot pins which certificate of a
// chain the binding describes. A reader that fell back to another certificate
// would answer about the CA's enrolment instead of the signing key's — and the
// platform's roots are hardware-enrolled, so the mistake would read as `quote`
// for every leaf in the fleet.
func TestReadSignerBindingReadsTheLeafNotTheRoot(t *testing.T) {
	t.Parallel()

	hardwareRoot := signerTemplate(t)
	hardwareRoot.CommonName = "Hardware-Enrolled Root"
	hardwareRoot.IsCA = true
	hardwareRoot.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageCRLSign
	hardwareRoot.ChallengeType = "tdx"
	root := issue(t, hardwareRoot, testca.RSA, nil)
	leaf := issue(t, signerTemplate(t), testca.RSA, root)

	chain, err := attestation.ValidateChain([]string{leaf.PEM, root.PEM}, mustTime(t, testNow))
	if err != nil {
		t.Fatalf("validate chain: %v", err)
	}
	if binding := attestation.ReadSignerBinding(chain); binding.Kind != attestation.SignerBindingUnknown {
		t.Errorf("kind = %q, want %q: the unlabelled leaf signed, not the hardware-enrolled root",
			binding.Kind, attestation.SignerBindingUnknown)
	}
}

// signerTemplate is the end-entity certificate the per-leader statement signer
// is issued as, before a case stamps a challenge onto it.
func signerTemplate(t *testing.T) testca.Template {
	t.Helper()
	return testca.Template{
		CommonName: "leader.swarm-cloud-test",
		NotBefore:  mustTime(t, "2026-08-01T00:00:00Z"),
		NotAfter:   mustTime(t, "2027-08-01T00:00:00Z"),
		MaxPathLen: -1,
		KeyUsage:   x509.KeyUsageDigitalSignature,
	}
}

func mustMarshalASN1(t *testing.T, value string) []byte {
	t.Helper()
	encoded, err := asn1.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %q as a DER string: %v", value, err)
	}
	return encoded
}
