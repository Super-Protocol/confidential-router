# An explicit null is not an absent claim: `claim()` defaults only what is
# missing. Without the shape check this raises instead of denying.

param "claims" {
  value = {
    "schema_version": "1",
    "quote_verified": true,
    "binding_ok": true,
    "pki_chain_ok": true,
    "root_quote_ok": true,
    "envelope_ok": true,
    "statement_ok": true,
    "mrenclave_approved": true,
    "image_digests": null,
    "locked": true,
    "pss_enforce": "restricted",
    "network_type": "trusted",
    "spvm_build": "build-448-release",
  }
}
param "approved_images" { value = ["sha256:a1a1"] }
param "reference_builds" { value = ["build-448-release"] }
test {
  rules = {
    main = false
    images_approved = false
  }
}
