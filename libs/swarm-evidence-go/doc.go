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
//	claims, err := swarmevidence.AppraiseComposite(ctx, collection, swarmevidence.Options{
//	    PKIRoots:       []attestation.TrustedRoot{{Name: "swarm-cloud-prod", PEM: rootPEM}},
//	    FreshnessInput: handle,
//	    RequestTarget:  target,
//	    RequestSubject: cekpub,
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
// # The two forms
//
// The **composite** form is a RATS Conceptual Message Wrapper collection
// holding the hardware quote, the PKI membership chain, the leader's workload
// attestation statement and the node's request envelope, as the TACRA Vault
// protocol profile fixes it. It is what a credential request presents, and the
// form the request binding, the envelope and the pod claims come from. Both
// its serialisations are read — the profile's own and the standard CMW JSON
// wrapper — because the relying party's single Verifier is the relying
// party's choice.
//
// The **evidence bundle** form is the /.well-known/swarm-evidence contract the
// fleet publishes about a served hostname.
//
// Which claims each establishes differs, and the claim set says so by leaving
// the others out: a bundle carries no request binding and a collection carries
// no channel binding.
//
// README.md walks both forms step by step, and DENIAL-STAGES.md is the
// contract for the stage a refusal names.
package swarmevidence
