# `binding_ok` is false.

param "claims" {
  value = {
    "schema_version": "1",
    "freshness_input": "5a5a5a5a",
    "binding_ok": false,
    "platform": "tdx-gcp",
    "quote_verified": true,
    "quote_appraiser": "intel-trust-authority",
    "tcb_status": "OK",
    "collateral_checked": true,
    "mrenclave_approved": true,
    "mrenclave_source": "registry",
    "spvm_build": "build-448-release",
    "pki_chain_ok": true,
    "root_quote_ok": true,
    "network_type": "trusted",
    "statement_ok": true,
    "envelope_ok": true,
    "pod_uid": "pod-7f3a",
    "namespace": "tenant-acme",
    "cluster_space_id": "space-42",
    "image_digests": ["sha256:a1a1", "sha256:b2b2"],
    "locked": true,
    "pss_enforce": "restricted",
  }
}

param "approved_images" {
  value = ["sha256:a1a1", "sha256:b2b2"]
}

param "reference_builds" {
  value = ["build-448-release"]
}

test {
  rules = {
    main = false
    request_bound = false
  }
}
