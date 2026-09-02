// Package snpmeasure reproduces the AMD SEV-SNP launch measurement of a
// Super Protocol VM image, which is what turns a hardware attestation report
// into the normalised `mrEnclave` the signed-measurement registry indexes
// (sp-vm/docs/04-vm-measurements.md §"AMD SEV-SNP").
//
// It is a port of the two functions the platform's own verifier calls:
// `snp_calc_launch_digest_with_hashes_from_bytes` from Super-Protocol/sp-sev
// (itself a fork of virtee/sev), and the `mrEnclave` wrapping applied on top of
// it by @super-protocol/attestation-common. The algorithm is fixed by the
// hardware — the digest either reproduces the report's own MEASUREMENT or it
// does not — so the port is verified end to end against a real report rather
// than against unit-level expectations.
//
// Nothing here touches the network: the firmware image is passed in as bytes.
package snpmeasure

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// SectionType is the kind of one OVMF SEV metadata section. The values are
// the ones QEMU and OVMF agree on; an unknown value is a hard error, because
// silently skipping a section would silently change the measurement.
type SectionType uint32

// The metadata section types this build understands. SVSM_CAA is measured as a
// zero page, exactly as in sp-sev; SNPKernelHashes is where the kernel/initrd/
// cmdline hashes page is placed.
const (
	SectionSNPSecMemory    SectionType = 1
	SectionSNPSecrets      SectionType = 2
	SectionCPUID           SectionType = 3
	SectionSVSMCaa         SectionType = 4
	SectionSNPKernelHashes SectionType = 0x10
)

// fourGB is the top of the 32-bit address space; OVMF is mapped so that its
// last byte sits just below it.
const fourGB = 0x1_0000_0000

// The GUIDs of the OVMF footer table entries the measurement needs. They are
// written little-endian in the image (RFC 4122 mixed-endian), which is what
// guidLE below produces.
const (
	guidOVMFTableFooter = "96b582de-1fb2-45f7-baea-a366c55a082d"
	guidSEVHashTableRV  = "7255371f-3a3b-4b04-927b-1da6efa8d454"
	guidSEVESResetBlock = "00f771de-1a7e-4fcb-890e-68c77e2fb44e"
	guidOVMFSEVMetadata = "dc886566-984a-4798-a75e-5585a7bf67cc"
)

// footerEntrySize is the size of one footer table entry header: uint16 length
// followed by a 16-byte GUID.
const footerEntrySize = 18

// Section is one OVMF SEV metadata section: a guest physical address, a size,
// and what the hardware should be told the pages are.
type Section struct {
	GPA  uint32      `json:"gpa"`
	Size uint32      `json:"size"`
	Type SectionType `json:"type"`
}

// Firmware is everything the launch measurement needs to know about an OVMF
// image. It is deliberately small and serialisable: the 4 MiB image itself is
// only needed to derive the seed digest, so a verifier that has already done
// that once can cache this instead of the firmware.
type Firmware struct {
	// Seed is the launch digest after the firmware's own pages have been
	// measured — sp-sev's `ovmf_hash_str` shortcut, 48 bytes.
	Seed []byte `json:"seed"`
	// ResetEIP is the SEV-ES AP reset vector, which lands in the AP save area.
	ResetEIP uint32 `json:"resetEip"`
	// HashesTableGPA is where QEMU writes the kernel/initrd/cmdline hash table.
	// Only its offset within the page matters to the measurement.
	HashesTableGPA uint32 `json:"hashesTableGpa"`
	// Sections are the metadata sections in the order the image lists them.
	// Order is part of the measurement.
	Sections []Section `json:"sections"`
}

// ParseFirmware reads an OVMF image and reduces it to a [Firmware].
//
// The image is measured here and then dropped: everything downstream works
// from Seed, so nothing else ever needs the 4 MiB again.
func ParseFirmware(image []byte) (*Firmware, error) {
	if len(image) < footerEntrySize+32 {
		return nil, errors.New("ovmf image is too small to hold a footer table")
	}
	if len(image)%pageSize != 0 {
		return nil, fmt.Errorf("ovmf image length %d is not a multiple of the 4096-byte page size", len(image))
	}

	table, err := parseFooterTable(image)
	if err != nil {
		return nil, err
	}

	resetEIP, err := tableUint32(table, guidSEVESResetBlock, "SEV_ES_RESET_BLOCK")
	if err != nil {
		return nil, err
	}
	hashesGPA, err := tableUint32(table, guidSEVHashTableRV, "SEV_HASH_TABLE_RV")
	if err != nil {
		return nil, err
	}
	sections, err := parseMetadata(image, table)
	if err != nil {
		return nil, err
	}

	// The seed is the launch digest of the firmware pages alone, mapped so the
	// image ends at 4 GiB.
	seed := newDigest(nil)
	if err := seed.normalPages(uint64(fourGB-len(image)), image); err != nil {
		return nil, err
	}

	return &Firmware{
		Seed:           seed.value(),
		ResetEIP:       resetEIP,
		HashesTableGPA: hashesGPA,
		Sections:       sections,
	}, nil
}

// parseFooterTable walks the GUIDed table that OVMF places just below the
// reset vector, from the footer entry backwards.
func parseFooterTable(image []byte) (map[string][]byte, error) {
	start := len(image) - 32 - footerEntrySize
	size := binary.LittleEndian.Uint16(image[start:])
	var guid [16]byte
	copy(guid[:], image[start+2:start+footerEntrySize])

	want, err := guidLE(guidOVMFTableFooter)
	if err != nil {
		return nil, err
	}
	if guid != want {
		return nil, fmt.Errorf("ovmf footer GUID is %x, expected %x", guid, want)
	}
	if int(size) < footerEntrySize || int(size) > start {
		return nil, fmt.Errorf("ovmf footer table size %d is out of range", size)
	}

	table := make(map[string][]byte)
	entries := image[start-(int(size)-footerEntrySize) : start]
	for len(entries) >= footerEntrySize {
		head := entries[len(entries)-footerEntrySize:]
		entrySize := int(binary.LittleEndian.Uint16(head))
		if entrySize < footerEntrySize || entrySize > len(entries) {
			return nil, fmt.Errorf("ovmf footer entry size %d is out of range", entrySize)
		}
		var entryGUID [16]byte
		copy(entryGUID[:], head[2:])
		table[guidString(entryGUID)] = entries[len(entries)-entrySize : len(entries)-footerEntrySize]
		entries = entries[:len(entries)-entrySize]
	}
	return table, nil
}

// parseMetadata reads the "ASEV" metadata block the footer table points at.
func parseMetadata(image []byte, table map[string][]byte) ([]Section, error) {
	entry, ok := table[guidOVMFSEVMetadata]
	if !ok || len(entry) < 4 {
		return nil, errors.New("ovmf image has no OVMF_SEV_META_DATA table entry")
	}
	offsetFromEnd := int(binary.LittleEndian.Uint32(entry))
	if offsetFromEnd <= 0 || offsetFromEnd > len(image) {
		return nil, fmt.Errorf("ovmf metadata offset %d is out of range", offsetFromEnd)
	}
	head := image[len(image)-offsetFromEnd:]
	if len(head) < 16 {
		return nil, errors.New("ovmf metadata header is truncated")
	}
	if string(head[:4]) != "ASEV" {
		return nil, fmt.Errorf("ovmf metadata signature is %q, expected \"ASEV\"", head[:4])
	}
	size := binary.LittleEndian.Uint32(head[4:])
	if version := binary.LittleEndian.Uint32(head[8:]); version != 1 {
		return nil, fmt.Errorf("ovmf metadata version is %d, expected 1", version)
	}
	count := binary.LittleEndian.Uint32(head[12:])
	if int(size) > len(head) || int(size) < 16+int(count)*12 {
		return nil, fmt.Errorf("ovmf metadata block of %d bytes cannot hold %d items", size, count)
	}

	sections := make([]Section, 0, count)
	items := head[16:size]
	for i := 0; i < int(count); i++ {
		item := items[i*12:]
		section := Section{
			GPA:  binary.LittleEndian.Uint32(item),
			Size: binary.LittleEndian.Uint32(item[4:]),
			Type: SectionType(binary.LittleEndian.Uint32(item[8:])),
		}
		if err := section.validate(i); err != nil {
			return nil, err
		}
		sections = append(sections, section)
	}
	return sections, nil
}

func (s Section) validate(index int) error {
	switch s.Type {
	case SectionSNPSecMemory, SectionSNPSecrets, SectionCPUID, SectionSVSMCaa, SectionSNPKernelHashes:
	default:
		return fmt.Errorf("ovmf metadata section %d has unknown type %d", index, s.Type)
	}
	if s.Size%pageSize != 0 {
		return fmt.Errorf("ovmf metadata section %d has size %d, not a multiple of the page size", index, s.Size)
	}
	if s.GPA%pageSize != 0 {
		return fmt.Errorf("ovmf metadata section %d has unaligned GPA %#x", index, s.GPA)
	}
	return nil
}

func tableUint32(table map[string][]byte, guid, name string) (uint32, error) {
	entry, ok := table[guid]
	if !ok {
		return 0, fmt.Errorf("ovmf image has no %s table entry", name)
	}
	if len(entry) < 4 {
		return 0, fmt.Errorf("ovmf %s table entry is %d bytes, expected at least 4", name, len(entry))
	}
	return binary.LittleEndian.Uint32(entry), nil
}

// guidLE renders a textual UUID the way it is stored in the image: the first
// three fields little-endian, the last two as written.
func guidLE(s string) ([16]byte, error) {
	var out [16]byte
	var be [16]byte
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return out, fmt.Errorf("malformed GUID %q", s)
	}
	hex := s[:8] + s[9:13] + s[14:18] + s[19:23] + s[24:]
	for i := 0; i < 16; i++ {
		var b byte
		for j := 0; j < 2; j++ {
			c := hex[i*2+j]
			var v byte
			switch {
			case c >= '0' && c <= '9':
				v = c - '0'
			case c >= 'a' && c <= 'f':
				v = c - 'a' + 10
			case c >= 'A' && c <= 'F':
				v = c - 'A' + 10
			default:
				return out, fmt.Errorf("malformed GUID %q", s)
			}
			b = b<<4 | v
		}
		be[i] = b
	}
	out[0], out[1], out[2], out[3] = be[3], be[2], be[1], be[0]
	out[4], out[5] = be[5], be[4]
	out[6], out[7] = be[7], be[6]
	copy(out[8:], be[8:])
	return out, nil
}

// guidString is the inverse of guidLE: the canonical text of a stored GUID.
func guidString(le [16]byte) string {
	be := [16]byte{le[3], le[2], le[1], le[0], le[5], le[4], le[7], le[6]}
	copy(be[8:], le[8:])
	const digits = "0123456789abcdef"
	out := make([]byte, 0, 36)
	for i, b := range be {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, digits[b>>4], digits[b&0xf])
	}
	return string(out)
}
