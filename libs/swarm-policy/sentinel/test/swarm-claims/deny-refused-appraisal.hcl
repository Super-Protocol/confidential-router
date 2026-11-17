# A refused appraisal carries nothing but the denial. It is never a partial pass.

param "claims" {
  value = {
    "schema_version": "1",
    "freshness_input": "5a5a5a5a",
    "denial": {
      "stage": "coverage",
      "reason": "snp-azure is outside the delegated path's coverage",
    },
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
    appraisal_succeeded = false
  }
}
