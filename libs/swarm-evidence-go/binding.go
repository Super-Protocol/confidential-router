package swarmevidence

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"fmt"
	"hash"
	"math"
)

// BindingInput renders the TACRA binding preimage:
//
//	len32(freshness) ‖ freshness ‖ len32(target) ‖ target ‖ len32(subject) ‖ subject
//
// where len32 is the value's octet length as a 32-bit big-endian unsigned
// integer (draft-novak-rats-tacra, §"Binding Credential Keys to Evidence").
//
// The three values are used **verbatim**. The Target is never re-prepared and
// the subject is never re-encoded, not even to a byte-identical DER form: both
// the attester and the verifier hash the octets they were given, and a
// verifier that normalised either would compute a digest no conformant
// attester produces.
//
// A value whose length len32 cannot express has no binding input at all,
// which is an error rather than a truncation: silently wrapping the length
// would produce a preimage that two implementations could disagree about.
func BindingInput(freshness, target, subject []byte) ([]byte, error) {
	out := make([]byte, 0, 12+len(freshness)+len(target)+len(subject))
	for _, value := range [][]byte{freshness, target, subject} {
		length := uint64(len(value))
		if length > math.MaxUint32 {
			return nil, fmt.Errorf("a binding input value of %d octets cannot be length-prefixed by len32",
				length)
		}
		out = binary.BigEndian.AppendUint32(out, uint32(length))
		out = append(out, value...)
	}
	return out, nil
}

// BindingDigest is the value an attester writes into its platform's
// guest-chosen field, and the value a relying party recomputes from the
// request it is holding.
//
// The hash is the one whose output is the size of that field, as the TACRA
// Vault profile's hook table fixes it: SHA-512 for 64 octets, SHA-384 for 48,
// SHA-256 for 32. Every platform this module appraises has a 64-octet field,
// so the hash is SHA-512 on all of them; the other two exist so that a
// platform with a smaller field is a configuration rather than a code change,
// and a field of any other size is refused rather than truncated into.
func BindingDigest(freshness, target, subject []byte, fieldOctets int) ([]byte, error) {
	hasher, err := bindingHash(fieldOctets)
	if err != nil {
		return nil, err
	}
	preimage, err := BindingInput(freshness, target, subject)
	if err != nil {
		return nil, err
	}
	hasher.Write(preimage)
	return hasher.Sum(nil), nil
}

func bindingHash(fieldOctets int) (hash.Hash, error) {
	switch fieldOctets {
	case sha512.Size:
		return sha512.New(), nil
	case sha512.Size384:
		return sha512.New384(), nil
	case sha256.Size:
		return sha256.New(), nil
	default:
		return nil, fmt.Errorf(
			"this profile names no hash for a %d-octet freshness input field; only 64, 48 and 32 are defined",
			fieldOctets)
	}
}
