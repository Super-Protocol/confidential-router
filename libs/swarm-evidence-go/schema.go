package swarmevidence

import _ "embed"

// Schema is the JSON Schema of [SwarmClaims] v1.
//
// It ships inside the module because it is the contract, not documentation
// about it: the relying party's policy, the EAR mapping of the Veraison scheme
// and the conformance vectors are all written against this file, and a copy
// that travelled separately would be a second contract. TestClaimsMatchSchema
// holds it and the Go struct to each other in both directions, so neither can
// gain a member the other does not have.
//
//go:embed schema/swarmclaims.v1.schema.json
var Schema []byte
