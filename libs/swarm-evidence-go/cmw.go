package swarmevidence

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime"
	"sort"
	"strings"
)

// The element type identifiers of the Super Swarm Evidence collection, and the
// media type each element is carried under. Both are fixed by the TACRA Vault
// profile, §"Evidence Format", and pinned by
// `swarm-cloud/testdata/tacra-v1/evidence/collection-v1.json`.
const (
	// ElementQuote is the hardware quote, with the measurement-register event
	// log where the platform has one. REQUIRED.
	ElementQuote = "swarm-quote"
	// ElementMembership is the PKI membership chain. REQUIRED.
	ElementMembership = "swarm-pki-membership"
	// ElementStatement is the leader's workload attestation statement, as a
	// compact JWS. OPTIONAL in the encoding; an appraisal policy decides
	// whether it requires one.
	ElementStatement = "swarm-workload-statement"
	// ElementEnvelope is the node's request envelope, as a compact JWS.
	// OPTIONAL in the encoding and unavoidable in practice on a GPU node,
	// whose token hash has no other binding.
	ElementEnvelope = "swarm-node-request-envelope"
)

const (
	mediaTypeQuote      = "application/vnd.super-protocol.swarm-quote+json"
	mediaTypeMembership = "application/x-pem-file"
	mediaTypeJOSE       = "application/jose"
	// collectionMediaType is the media type of the collection itself. Its `v`
	// parameter is the profile version of the collection, and a `v` this build
	// does not implement is refused rather than parsed leniently.
	collectionMediaType = "application/vnd.super-protocol.swarm-evidence+json"
	// collectionName is the value of the collection type indicator, in both
	// the profile's spelling (`collection`) and the standard wrapper's
	// (`__cmwc_t`).
	collectionName = "swarm-evidence"
	// collectionVersion is the only collection version this build implements.
	collectionVersion = 1
)

// elementMediaTypes is the media type each element type must be carried under.
// An element labelled with another one is refused: the type identifier and the
// media type are two statements about the same octets, and a producer whose
// two statements disagree is one whose output cannot be read with confidence.
var elementMediaTypes = map[string]string{
	ElementQuote:      mediaTypeQuote,
	ElementMembership: mediaTypeMembership,
	ElementStatement:  mediaTypeJOSE,
	ElementEnvelope:   mediaTypeJOSE,
}

// collection is a parsed RATS Conceptual Message Wrapper collection: the
// octets of each element, keyed by the element's type identifier.
//
// The parse is of the collection *as such*. Two serialisations reach this
// type, and an appraisal cannot tell afterwards which one it came from:
//
//   - the profile's own spelling, `{collection, v, elements[]}`, which is what
//     the Super Swarm CAI emits and what the shared TACRA fixtures pin; and
//   - the standard CMW JSON collection of draft-ietf-rats-msg-wrap — a JSON
//     object whose `__cmwc_t` member carries the collection type and whose
//     other members are CMW records, `[media-type, base64url-value]`, keyed by
//     the element type identifier.
//
// Accepting both is the point: the bank deploys one Verifier of its own
// choosing, and a collection that carries the same parts under the standard
// wrapper has to appraise the same whoever produced or forwarded it.
type collection struct {
	elements map[string][]byte
}

// octets returns an element's decoded content and whether it was present.
func (c *collection) octets(elementType string) ([]byte, bool) {
	value, ok := c.elements[elementType]
	return value, ok
}

// looksLikeCollection reports whether a blob is a CMW collection at all, by the
// member that announces one in either serialisation. It is deliberately a
// shallow test: everything beyond it is a malformed collection, which is worth
// a denial that says so rather than one that says "this is some other form".
func looksLikeCollection(blob []byte) bool {
	var probe struct {
		Collection json.RawMessage `json:"collection"`
		CMWCT      json.RawMessage `json:"__cmwc_t"`
	}
	if err := json.Unmarshal(blob, &probe); err != nil {
		return false
	}
	return len(probe.Collection) > 0 || len(probe.CMWCT) > 0
}

// parseCollection reads either serialisation into a collection.
func parseCollection(blob []byte) (*collection, *Denial) {
	var probe struct {
		CMWCT json.RawMessage `json:"__cmwc_t"`
	}
	if err := json.Unmarshal(blob, &probe); err != nil {
		return nil, denyf(StageBlob, "the evidence collection is not a JSON document: %v", err)
	}
	if len(probe.CMWCT) > 0 {
		return parseStandardCollection(blob)
	}
	return parseProfileCollection(blob)
}

// profileCollection is the collection in the spelling the TACRA Vault profile
// writes it in.
type profileCollection struct {
	Collection string `json:"collection"`
	V          *int   `json:"v"`
	Elements   []struct {
		Type      string          `json:"type"`
		MediaType string          `json:"media_type"`
		Encoding  string          `json:"encoding"`
		Value     json.RawMessage `json:"value"`
	} `json:"elements"`
}

func parseProfileCollection(blob []byte) (*collection, *Denial) {
	var parsed profileCollection
	if err := json.Unmarshal(blob, &parsed); err != nil {
		return nil, denyf(StageBlob, "the evidence collection is malformed: %v", err)
	}
	if parsed.Collection != collectionName {
		return nil, denyf(StageBlob, "collection is %q, expected %q", parsed.Collection, collectionName)
	}
	if parsed.V == nil {
		return nil, denyf(StageBlob, "the collection declares no version")
	}
	if *parsed.V != collectionVersion {
		return nil, denyf(StageBlob,
			"collection version %d is not implemented by this build (it implements %d)", *parsed.V, collectionVersion)
	}

	out := &collection{elements: map[string][]byte{}}
	for i, element := range parsed.Elements {
		if element.Type == "" {
			return nil, denyf(StageBlob, "the element at index %d declares no type", i)
		}
		if _, known := elementMediaTypes[element.Type]; !known {
			// Additive extension: an element this build does not know is not an
			// error, because the profile reserves adding one within a version.
			// A policy that needs it will find it absent and say so itself.
			continue
		}
		if _, duplicate := out.elements[element.Type]; duplicate {
			return nil, denyf(StageBlob, "the collection carries %q twice", element.Type)
		}
		if denial := checkElementMediaType(element.Type, element.MediaType); denial != nil {
			return nil, denial
		}
		octets, denial := decodeElementValue(element.Type, element.Encoding, element.Value)
		if denial != nil {
			return nil, denial
		}
		out.elements[element.Type] = octets
	}
	return out, nil
}

// decodeElementValue renders one element's value as the octets it stands for.
//
// `base64url` is the unpadded form of the element's own octets. `json` is the
// element as a JSON value, and a compact JWS is therefore a JSON *string* —
// a JWS is already a text serialization and is not base64url-wrapped a second
// time — whose octets are its UTF-8 bytes. Anything else under `json` is a
// JSON document whose octets are the document.
func decodeElementValue(elementType, encoding string, value json.RawMessage) ([]byte, *Denial) {
	if len(value) == 0 {
		return nil, denyf(StageBlob, "element %q carries no value", elementType)
	}
	switch encoding {
	case "base64url":
		var encoded string
		if err := json.Unmarshal(value, &encoded); err != nil {
			return nil, denyf(StageBlob, "element %q is encoded base64url but its value is not a string", elementType)
		}
		octets, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			return nil, denyf(StageBlob, "element %q is not unpadded base64url: %v", elementType, err)
		}
		return octets, nil
	case "json":
		var text string
		if err := json.Unmarshal(value, &text); err == nil {
			return []byte(text), nil
		}
		return value, nil
	default:
		return nil, denyf(StageBlob, "element %q declares encoding %q, expected base64url or json",
			elementType, encoding)
	}
}

// parseStandardCollection reads the CMW JSON collection of
// draft-ietf-rats-msg-wrap: an object whose `__cmwc_t` member carries the
// collection type and whose remaining members are CMW records keyed by the
// element type identifier.
//
// A CMW record is `[type, value]`, optionally with the draft's indicator as a
// third member; `type` is a media type string or a CoAP content-format number,
// and `value` is the element's octets in unpadded base64url. A member that is
// a nested collection or a monad is not one of our elements and is skipped,
// for the same reason an unknown element type is.
func parseStandardCollection(blob []byte) (*collection, *Denial) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(blob, &members); err != nil {
		return nil, denyf(StageBlob, "the CMW collection is malformed: %v", err)
	}

	var indicator string
	if err := json.Unmarshal(members["__cmwc_t"], &indicator); err != nil {
		return nil, denyf(StageBlob, "the CMW collection type indicator is not a string")
	}
	if denial := checkCollectionType(indicator); denial != nil {
		return nil, denial
	}

	out := &collection{elements: map[string][]byte{}}
	// Sorted so that a malformed record produces the same denial whichever
	// order the JSON object happened to be written in.
	labels := make([]string, 0, len(members))
	for label := range members {
		labels = append(labels, label)
	}
	sort.Strings(labels)

	for _, label := range labels {
		if label == "__cmwc_t" {
			continue
		}
		if _, known := elementMediaTypes[label]; !known {
			continue
		}
		var record []json.RawMessage
		if err := json.Unmarshal(members[label], &record); err != nil || len(record) < 2 {
			return nil, denyf(StageBlob,
				"the CMW collection member %q is not a CMW record [type, value]", label)
		}
		var mediaType string
		if err := json.Unmarshal(record[0], &mediaType); err != nil {
			return nil, denyf(StageBlob,
				"the CMW record %q declares a numeric content format; this build reads media types only", label)
		}
		if denial := checkElementMediaType(label, mediaType); denial != nil {
			return nil, denial
		}
		var encoded string
		if err := json.Unmarshal(record[1], &encoded); err != nil {
			return nil, denyf(StageBlob, "the CMW record %q carries a value that is not a string", label)
		}
		octets, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			return nil, denyf(StageBlob, "the CMW record %q is not unpadded base64url: %v", label, err)
		}
		out.elements[label] = octets
	}
	return out, nil
}

// checkCollectionType accepts the collection type indicator in either of the
// two spellings a producer may use: the collection's media type, whose `v`
// parameter this build must implement, or the bare collection name the
// profile's own serialisation carries.
func checkCollectionType(indicator string) *Denial {
	if indicator == collectionName {
		return nil
	}
	base, params, err := mime.ParseMediaType(indicator)
	if err != nil {
		return denyf(StageBlob, "the CMW collection type %q is neither %q nor a media type: %v",
			indicator, collectionName, err)
	}
	if base != collectionMediaType {
		return denyf(StageBlob, "the CMW collection type is %q, expected %q", base, collectionMediaType)
	}
	version, ok := params["v"]
	if !ok {
		return denyf(StageBlob, "the CMW collection media type declares no v parameter")
	}
	if version != fmt.Sprint(collectionVersion) {
		return denyf(StageBlob,
			"collection media type v=%s is not implemented by this build (it implements v=%d)",
			version, collectionVersion)
	}
	return nil
}

// checkElementMediaType holds an element's declared media type against the one
// its type identifier fixes, ignoring parameters a producer may add.
func checkElementMediaType(elementType, declared string) *Denial {
	want := elementMediaTypes[elementType]
	base := declared
	if parsed, _, err := mime.ParseMediaType(declared); err == nil {
		base = parsed
	}
	if !strings.EqualFold(base, want) {
		return denyf(StageBlob, "element %q declares media type %q, expected %q", elementType, declared, want)
	}
	return nil
}
