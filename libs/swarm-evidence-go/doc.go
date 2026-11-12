// Package swarmevidence appraises Super Swarm Evidence and reports what it
// establishes as [SwarmClaims] — the normative claim set a relying party writes
// its policy against.
//
// It exists so that the verifier paths a bank can choose between are adapters
// over one implementation rather than two implementations that two test suites
// have to keep in agreement: the Intel Trust Authority and Vault path
// (SUP-648) and the Veraison `super-swarm` scheme (SUP-649) both call
// [AppraiseComposite], and so does the gatekeeper. The module is standalone and
// Apache-2.0 so a relying party can run it in production without the router.
//
//	claims, err := swarmevidence.AppraiseComposite(ctx, blob, swarmevidence.Options{
//	    Subject:        "llama-33-70b.tee.swarm.cloud",
//	    PKIRoots:       []attestation.TrustedRoot{{Name: "swarm-cloud-prod", PEM: rootPEM}},
//	    FreshnessInput: nonce,
//	})
//	var denial *swarmevidence.Denial
//	if errors.As(err, &denial) {
//	    return fmt.Errorf("not appraisable at %s: %s", denial.Stage, denial.Reason)
//	}
//
// # The core reports; the policy decides
//
// The predicates that actually gate a request — the image is in the approved
// set, the cluster space is locked, the Pod Security Standard is restricted,
// the network type is trusted, the sp-vm build is a reference value — are
// deliberately not here. They are the relying party's, which is the whole point
// of handing it a claim set instead of a verdict. What this module owes it in
// exchange is that a claim it did not establish is absent rather than false,
// and that evidence it could not appraise produces a [Denial] rather than a
// subset of claims that reads like a pass.
//
// # What it is built out of
//
// [AppraiseComposite] is a composition, not a reimplementation. The
// subpackages are the verifier the gatekeeper has shipped since SUP-68:
//
//   - [attestation] — the /.well-known/swarm-evidence pipeline: the certificate
//     chain, the compact JWS over the signed statement, the evidence digest and
//     the channel binding.
//   - [attestation/attestedroot] — whether a certificate authority is a Super
//     Swarm one at all, decided from the TEE evidence its root certificate
//     carries: the hardware quote against the CPU vendor's built-in root, the
//     report data's commitment to the certificate's own key, the launch
//     measurement rebuilt from published artefacts and normalised to
//     mrEnclave, and Super Protocol's signature over that measurement.
//   - [conformance] — the harness that replays the shared vectors of
//     libs/attestation-fixtures, which are the contract every implementation of
//     this appraisal must satisfy.
//
// # Status
//
// The bundle form of the evidence is appraised today. The composite form — a
// hardware quote beside a node-signed NodeRequestEnvelope and a control-plane
// statement — is refused at the blob stage until SUP-638 settles its encoding
// and SUP-636 the statement; the claims it will fill in (BindingOK, EnvelopeOK,
// the pod claims) are declared here and in the schema already, so a policy can
// be written against the whole of v1 before the second half lands.
package swarmevidence
