package snpmeasure

import (
	"encoding/binary"
	"strings"
	"testing"
)

// buildImage assembles a minimal OVMF image with a GUIDed footer table and an
// "ASEV" metadata block, so the parser can be exercised without a 4 MiB
// firmware. The layout mirrors what OVMF emits: the table grows downwards from
// 32 bytes below the end of the image, and each entry is preceded by the ones
// that follow it.
func buildImage(t *testing.T, sections []Section, entries map[string][]byte) []byte {
	t.Helper()
	const pages = 8
	image := make([]byte, pages*pageSize)

	// The metadata block sits at a fixed offset that the footer entry points at.
	metadataOffset := 3 * pageSize
	block := image[metadataOffset:]
	copy(block, "ASEV")
	binary.LittleEndian.PutUint32(block[4:], uint32(16+len(sections)*12))
	binary.LittleEndian.PutUint32(block[8:], 1)
	binary.LittleEndian.PutUint32(block[12:], uint32(len(sections)))
	for i, s := range sections {
		item := block[16+i*12:]
		binary.LittleEndian.PutUint32(item, s.GPA)
		binary.LittleEndian.PutUint32(item[4:], s.Size)
		binary.LittleEndian.PutUint32(item[8:], uint32(s.Type))
	}

	all := map[string][]byte{
		guidOVMFSEVMetadata: le32(uint32(len(image) - metadataOffset)),
	}
	for guid, value := range entries {
		all[guid] = value
	}

	// Entries are written low-to-high; the footer entry follows them and covers
	// the whole table.
	var table []byte
	for guid, value := range all {
		raw, err := guidLE(guid)
		if err != nil {
			t.Fatal(err)
		}
		entry := make([]byte, 0, len(value)+footerEntrySize)
		entry = append(entry, value...)
		entry = binary.LittleEndian.AppendUint16(entry, uint16(len(value)+footerEntrySize))
		entry = append(entry, raw[:]...)
		table = append(table, entry...)
	}
	footer, err := guidLE(guidOVMFTableFooter)
	if err != nil {
		t.Fatal(err)
	}
	table = binary.LittleEndian.AppendUint16(table, uint16(len(table)+footerEntrySize))
	table = append(table, footer[:]...)

	copy(image[len(image)-32-len(table):], table)
	return image
}

func le32(v uint32) []byte {
	out := make([]byte, 4)
	binary.LittleEndian.PutUint32(out, v)
	return out
}

func defaultSections() []Section {
	return []Section{
		{GPA: 0x800000, Size: pageSize, Type: SectionSNPSecMemory},
		{GPA: 0x801000, Size: pageSize, Type: SectionSNPSecrets},
		{GPA: 0x802000, Size: pageSize, Type: SectionCPUID},
		{GPA: 0x803000, Size: pageSize, Type: SectionSNPKernelHashes},
	}
}

func defaultEntries() map[string][]byte {
	return map[string][]byte{
		guidSEVESResetBlock: le32(0x80b004),
		guidSEVHashTableRV:  le32(0x810c00),
	}
}

func TestParseFirmware(t *testing.T) {
	image := buildImage(t, defaultSections(), defaultEntries())

	firmware, err := ParseFirmware(image)
	if err != nil {
		t.Fatalf("ParseFirmware: %v", err)
	}
	if got, want := firmware.ResetEIP, uint32(0x80b004); got != want {
		t.Errorf("reset EIP = %#x, want %#x", got, want)
	}
	if got, want := firmware.HashesTableGPA, uint32(0x810c00); got != want {
		t.Errorf("hashes table GPA = %#x, want %#x", got, want)
	}
	if got, want := len(firmware.Sections), len(defaultSections()); got != want {
		t.Fatalf("read %d sections, want %d", got, want)
	}
	if got, want := len(firmware.Seed), 48; got != want {
		t.Errorf("seed is %d bytes, want %d", got, want)
	}

	// The seed must depend on the image: it is the digest of its pages.
	other := buildImage(t, defaultSections(), defaultEntries())
	other[0] ^= 0xff
	changed, err := ParseFirmware(other)
	if err != nil {
		t.Fatal(err)
	}
	if string(changed.Seed) == string(firmware.Seed) {
		t.Error("changing a firmware byte did not change the seed")
	}
}

func TestParseFirmwareRejectsMalformedImages(t *testing.T) {
	t.Run("no footer GUID", func(t *testing.T) {
		image := buildImage(t, defaultSections(), defaultEntries())
		image[len(image)-32-footerEntrySize+2] ^= 0xff
		if _, err := ParseFirmware(image); err == nil {
			t.Fatal("an image with a wrong footer GUID was accepted")
		}
	})

	t.Run("no reset block", func(t *testing.T) {
		entries := defaultEntries()
		delete(entries, guidSEVESResetBlock)
		if _, err := ParseFirmware(buildImage(t, defaultSections(), entries)); err == nil {
			t.Fatal("an image with no SEV-ES reset block was accepted")
		}
	})

	t.Run("an unknown section type", func(t *testing.T) {
		sections := append(defaultSections(), Section{GPA: 0x804000, Size: pageSize, Type: 0x99})
		_, err := ParseFirmware(buildImage(t, sections, defaultEntries()))
		if err == nil {
			t.Fatal("an unknown metadata section type was accepted")
		}
		if !strings.Contains(err.Error(), "unknown type") {
			t.Errorf("error = %v, want it to name the unknown type", err)
		}
	})

	t.Run("a partial page", func(t *testing.T) {
		image := buildImage(t, defaultSections(), defaultEntries())
		if _, err := ParseFirmware(image[:len(image)-1]); err == nil {
			t.Fatal("an image that is not a whole number of pages was accepted")
		}
	})
}

// TestLaunchDigestRequiresKernelHashes guards the property that makes a build
// identifier meaningful: an image with no hashes section boots artefacts the
// measurement never covers.
func TestLaunchDigestRequiresKernelHashes(t *testing.T) {
	sections := defaultSections()[:3]
	firmware, err := ParseFirmware(buildImage(t, sections, defaultEntries()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LaunchDigest(firmware, Hashes{}, MilanCPUSig, 1); err == nil {
		t.Fatal("a firmware with no SNP_KERNEL_HASHES section was measured")
	}
}

// TestLaunchDigestDependsOnItsInputs is a change-detector in the useful sense:
// every input the specification says is measured has to move the digest.
func TestLaunchDigestDependsOnItsInputs(t *testing.T) {
	firmware, err := ParseFirmware(buildImage(t, defaultSections(), defaultEntries()))
	if err != nil {
		t.Fatal(err)
	}
	base, err := LaunchDigest(firmware, Hashes{}, MilanCPUSig, 1)
	if err != nil {
		t.Fatal(err)
	}

	other := Hashes{}
	other.Kernel[0] = 1
	for _, tc := range []struct {
		name   string
		hashes Hashes
		cpuSig uint32
		vcpus  int
	}{
		{name: "a different kernel hash", hashes: other, cpuSig: MilanCPUSig, vcpus: 1},
		{name: "a different CPU signature", hashes: Hashes{}, cpuSig: CPUSig(23, 1, 2), vcpus: 1},
		{name: "a second vCPU", hashes: Hashes{}, cpuSig: MilanCPUSig, vcpus: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := LaunchDigest(firmware, tc.hashes, tc.cpuSig, tc.vcpus)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) == string(base) {
				t.Error("the launch digest did not change")
			}
		})
	}
}

// TestCPUSig pins the CPUID encoding against the values the platform's own
// tables use.
func TestCPUSig(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		family, model, stepping int
		want                    uint32
	}{
		{name: "EPYC (Naples)", family: 23, model: 1, stepping: 2, want: 0x800f12},
		{name: "EPYC-Rome", family: 23, model: 49, stepping: 0, want: 0x830f10},
		{name: "EPYC-Milan", family: 25, model: 1, stepping: 1, want: 0xa00f11},
		{name: "EPYC-Genoa", family: 25, model: 17, stepping: 0, want: 0xa10f10},
	} {
		if got := CPUSig(tc.family, tc.model, tc.stepping); got != tc.want {
			t.Errorf("%s: CPUSig = %#x, want %#x", tc.name, got, tc.want)
		}
	}
	if MilanCPUSig != 0xa00f11 {
		t.Errorf("MilanCPUSig = %#x, want 0xa00f11", MilanCPUSig)
	}
}

// TestWrap pins the mrEnclave wrapping: SHA-256 over the measurement, the vMPL
// and the policy, both little-endian.
func TestWrap(t *testing.T) {
	measurement := make([]byte, 48)
	first := Wrap(measurement, 0, 0x30000)
	if len(first) != 32 {
		t.Fatalf("wrapped measurement is %d bytes, want 32", len(first))
	}
	if string(Wrap(measurement, 1, 0x30000)) == string(first) {
		t.Error("the vMPL is not part of the wrapping")
	}
	if string(Wrap(measurement, 0, 0x30001)) == string(first) {
		t.Error("the policy is not part of the wrapping")
	}
}
