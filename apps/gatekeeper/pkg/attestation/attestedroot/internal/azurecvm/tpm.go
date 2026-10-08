package azurecvm

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

const (
	tpmGeneratedValue = 0xff544347
	tpmSTAttestQuote  = 0x8018
	tpmAlgSHA256      = 0x000b
	tpmAlgRSASSA      = 0x0014
)

// quotedPCRs are the PCRs the TPM quote must cover, in the order their values
// are hashed into pcrDigest.
var quotedPCRs = []uint32{4, 9}

type tpmQuote struct {
	extraData []byte
	pcrDigest []byte
}

// parseTPMSAttest parses a TPMS_ATTEST of type TPM_ST_ATTEST_QUOTE that selects
// exactly the SHA-256 bank of quotedPCRs.
func parseTPMSAttest(raw []byte) (tpmQuote, error) {
	r := tpmReader{data: raw}
	magic := r.uint32()
	attestType := r.uint16()
	r.sized() // qualifiedSigner
	extraData := r.sized()
	r.skip(8 + 4 + 4 + 1) // clockInfo
	r.skip(8)             // firmwareVersion
	selectionCount := r.uint32()
	var selections [][]byte
	var hashAlgs []uint16
	for i := uint32(0); i < selectionCount && r.err == nil; i++ {
		hashAlgs = append(hashAlgs, r.uint16())
		size := r.uint8()
		selections = append(selections, r.bytes(int(size)))
	}
	pcrDigest := r.sized()
	if r.err != nil {
		return tpmQuote{}, fmt.Errorf("TPMS_ATTEST is malformed: %w", r.err)
	}
	if r.remaining() != 0 {
		return tpmQuote{}, fmt.Errorf("TPMS_ATTEST has %d trailing bytes", r.remaining())
	}

	if magic != tpmGeneratedValue {
		return tpmQuote{}, fmt.Errorf("TPMS_ATTEST magic is %#x, expected %#x", magic, tpmGeneratedValue)
	}
	if attestType != tpmSTAttestQuote {
		return tpmQuote{}, fmt.Errorf("TPMS_ATTEST type is %#x, expected quote (%#x)", attestType, tpmSTAttestQuote)
	}
	if len(selections) != 1 || hashAlgs[0] != tpmAlgSHA256 {
		return tpmQuote{}, fmt.Errorf("TPM quote must select exactly the SHA-256 PCR bank")
	}
	if !selectsExactly(selections[0], quotedPCRs) {
		return tpmQuote{}, fmt.Errorf("TPM quote must select exactly PCRs %v", quotedPCRs)
	}
	return tpmQuote{extraData: extraData, pcrDigest: pcrDigest}, nil
}

func selectsExactly(bitmap []byte, pcrs []uint32) bool {
	want := make([]byte, len(bitmap))
	for _, pcr := range pcrs {
		if int(pcr/8) >= len(want) {
			return false
		}
		want[pcr/8] |= 1 << (pcr % 8)
	}
	return bytes.Equal(bitmap, want)
}

// verifyTPMSignature verifies a TPMT_SIGNATURE (RSASSA, SHA-256) over attest.
func verifyTPMSignature(attest []byte, signature []byte, key *rsa.PublicKey) error {
	r := tpmReader{data: signature}
	sigAlg := r.uint16()
	hashAlg := r.uint16()
	sig := r.sized()
	if r.err != nil {
		return fmt.Errorf("TPMT_SIGNATURE is malformed: %w", r.err)
	}
	if r.remaining() != 0 {
		return fmt.Errorf("TPMT_SIGNATURE has %d trailing bytes", r.remaining())
	}
	if sigAlg != tpmAlgRSASSA || hashAlg != tpmAlgSHA256 {
		return fmt.Errorf("TPM quote signature scheme is %#x/%#x, expected RSASSA/SHA-256", sigAlg, hashAlg)
	}
	digest := sha256.Sum256(attest)
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig); err != nil {
		return fmt.Errorf("TPM quote signature is invalid: %w", err)
	}
	return nil
}

// tpmReader reads big-endian TPM structures and records the first error.
type tpmReader struct {
	data []byte
	pos  int
	err  error
}

func (r *tpmReader) bytes(n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || r.pos+n > len(r.data) {
		r.err = fmt.Errorf("truncated at offset %d", r.pos)
		return nil
	}
	b := r.data[r.pos : r.pos+n]
	r.pos += n
	return b
}

func (r *tpmReader) skip(n int) { r.bytes(n) }

func (r *tpmReader) uint8() uint8 {
	if b := r.bytes(1); b != nil {
		return b[0]
	}
	return 0
}

func (r *tpmReader) uint16() uint16 {
	if b := r.bytes(2); b != nil {
		return binary.BigEndian.Uint16(b)
	}
	return 0
}

func (r *tpmReader) uint32() uint32 {
	if b := r.bytes(4); b != nil {
		return binary.BigEndian.Uint32(b)
	}
	return 0
}

// sized reads a TPM2B: a 16-bit length followed by that many bytes.
func (r *tpmReader) sized() []byte {
	return r.bytes(int(r.uint16()))
}

func (r *tpmReader) remaining() int {
	return len(r.data) - r.pos
}
