package swarmevidence_test

import (
	"context"
	"crypto/x509"
	"testing"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/internal/testca"
)

// TestCompositeReportsTheStatementSignerBinding is the claim a relying party
// writes the "hardware-bound signer" policy against.
//
// The appraisal finds the statement's signer by trying every certificate in
// the membership bag, and the authority marks a per-leader signer leaf with
// nothing a node leaf does not also carry (SUP-696) — so `statement_ok` true
// says only that some leaf of the pinned PKI signed. What this claim adds is
// *how the authority was persuaded to issue that leaf*, which is the
// difference between a quote over the signing key and a bearer token every
// node of the swarm holds.
func TestCompositeReportsTheStatementSignerBinding(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name             string
		challenge        string
		subtype          string
		embeddedEvidence bool
		want             swarmevidence.SignerBindingKind
	}{{
		name:             "a hardware-challenged signer",
		challenge:        "tdx",
		embeddedEvidence: true,
		want:             swarmevidence.SignerBindingQuote,
	}, {
		name:      "a token-challenged signer",
		challenge: "token",
		want:      swarmevidence.SignerBindingSecret,
	}, {
		name:      "a certificate-challenged signer with a hardware subtype",
		challenge: "certificate",
		subtype:   "sev-snp",
		want:      swarmevidence.SignerBindingAttestedCertificate,
	}, {
		// Only as strong as the certificate presented, and nothing says what
		// that was. Reporting `attested-certificate` here would let a policy
		// read a chain of unknown origin as hardware-bound.
		name:      "a certificate-challenged signer without a hardware subtype",
		challenge: "certificate",
		want:      swarmevidence.SignerBindingUnknown,
	}, {
		// A leaf from outside this PKI, or one issued before the authority
		// recorded the challenge. It is the fail-closed case and the reason
		// the claim is reported even when it says nothing: a policy has to be
		// able to tell "the leaf is unlabelled" from "this build does not
		// produce the claim".
		name: "an unlabelled signer leaf",
		want: swarmevidence.SignerBindingUnknown,
	}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c := newComposite(t)
			template := statementSignerTemplate(t)
			template.ChallengeType = tc.challenge
			template.ChallengeSubtype = tc.subtype
			if tc.embeddedEvidence {
				template.TEEEvidence = []byte("serialised TeeEvidence")
			}
			c.useStatementSigner(issue(t, template, testca.RSA, c.f.inter))

			claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
			if err != nil {
				t.Fatalf("appraise: %v", err)
			}
			if claims.StatementOK == nil || !*claims.StatementOK {
				t.Fatalf("statement_ok = %v, want true: the case is about a statement that verified",
					claims.StatementOK)
			}
			if claims.StatementSignerBinding != tc.want {
				t.Errorf("statement_signer_binding = %q, want %q",
					claims.StatementSignerBinding, tc.want)
			}
			if claims.StatementSignerFingerprint != c.signer.Fingerprint() {
				t.Errorf("statement_signer_fingerprint = %q, want the signer's %q",
					claims.StatementSignerFingerprint, c.signer.Fingerprint())
			}
		})
	}
}

// TestCompositeReportsTheSignerBindingOfWhoeverSigned makes the documented
// footgun visible rather than leaving it to the prose.
//
// A statement signed by the node's own certificate verifies: the certificate
// is in the bag and chains to the pinned root, and nothing in the PKI says it
// is not a signer. The claim set then reports *that* leaf — its fingerprint
// and its binding — which is exactly what a policy needs in order to notice.
func TestCompositeReportsTheSignerBindingOfWhoeverSigned(t *testing.T) {
	t.Parallel()
	c := newComposite(t)
	c.useStatementSigner(c.node)

	claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}
	if claims.StatementSignerFingerprint != c.node.Fingerprint() {
		t.Errorf("statement_signer_fingerprint = %q, want the node's %q",
			claims.StatementSignerFingerprint, c.node.Fingerprint())
	}
	// The node leaf is device-enrolled against a quote like the leader's, so
	// the binding alone does not tell the two apart — which is why
	// `statement_signer_fingerprint` is published beside it.
	if claims.StatementSignerBinding != swarmevidence.SignerBindingQuote {
		t.Errorf("statement_signer_binding = %q, want %q: the node leaf is hardware-challenged too",
			claims.StatementSignerBinding, swarmevidence.SignerBindingQuote)
	}
}

// TestCompositeWithoutAStatementReportsNoSignerBinding is the claim set's
// central rule applied here: an absent claim was not established, so a
// collection with no statement may not carry a binding — not even `unknown`,
// which would say a certificate was read.
func TestCompositeWithoutAStatementReportsNoSignerBinding(t *testing.T) {
	t.Parallel()
	c := newComposite(t)
	c.omitStatement = true

	claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}
	if claims.StatementSignerBinding != "" {
		t.Errorf("statement_signer_binding = %q, want none: no statement was appraised",
			claims.StatementSignerBinding)
	}
}

// TestBundleFormReportsNoSignerBinding pins the form boundary the claim
// reference states. The bundle form's signer is the served deployment's own
// leaf and its statement is a document about a hostname, so the claim is left
// absent rather than answered about a different certificate — and a policy
// requiring a binding refuses the form, which is the safe direction.
func TestBundleFormReportsNoSignerBinding(t *testing.T) {
	t.Parallel()
	f := newFixture(t)

	claims, err := swarmevidence.AppraiseComposite(context.Background(), f.bundle(t, nil), f.options())
	if err != nil {
		t.Fatalf("appraise: %v", err)
	}
	if claims.StatementOK == nil || !*claims.StatementOK {
		t.Fatalf("statement_ok = %v, want true", claims.StatementOK)
	}
	if claims.StatementSignerBinding != "" {
		t.Errorf("statement_signer_binding = %q, want none: the bundle form establishes none",
			claims.StatementSignerBinding)
	}
}

// useStatementSigner swaps the leaf that signs the leader's statement, and
// keeps the membership bag carrying it: the bag holds the chain material for
// every signed element present, so a signer missing from it is a different
// case (and a `statement`-stage denial).
func (c *composite) useStatementSigner(signer *testca.Cert) {
	c.signer = signer
	c.membership = []*testca.Cert{c.node, signer, c.f.inter, c.f.root}
}

// statementSignerTemplate is the end-entity certificate the per-leader signer
// is issued as, before a case stamps a challenge onto it.
func statementSignerTemplate(t *testing.T) testca.Template {
	t.Helper()
	return testca.Template{
		CommonName: "leader.swarm-cloud-test",
		NotBefore:  mustTime(t, "2026-08-01T00:00:00Z"),
		NotAfter:   mustTime(t, "2027-08-01T00:00:00Z"),
		MaxPathLen: -1,
		KeyUsage:   x509.KeyUsageDigitalSignature,
	}
}

// hardwareChallenged stamps the challenge a device-enrolled leaf of this PKI
// carries: the authority saw a quote from the measured image whose
// guest-chosen field is SHA-256(SPKI) of the key it was certifying, and
// embeds that quote in the leaf.
func hardwareChallenged(template testca.Template) testca.Template {
	template.ChallengeType = "tdx"
	template.TEEEvidence = []byte("serialised TeeEvidence")
	return template
}

// appraiseWithSignerChallenge appraises a sound composite collection whose
// statement signer was issued against the named challenge, and returns the
// claim set it produced.
func appraiseWithSignerChallenge(t *testing.T, challenge, subtype string) swarmevidence.SwarmClaims {
	t.Helper()
	c := newComposite(t)
	template := statementSignerTemplate(t)
	template.ChallengeType = challenge
	template.ChallengeSubtype = subtype
	c.useStatementSigner(issue(t, template, testca.RSA, c.f.inter))

	claims, err := swarmevidence.AppraiseComposite(context.Background(), c.blob(t), c.options())
	if err != nil {
		t.Fatalf("appraise a signer challenged with %q/%q: %v", challenge, subtype, err)
	}
	return claims
}
