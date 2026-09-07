package snpmeasure

import "encoding/binary"

// The VM save area is a 4 KiB page whose layout is fixed by AMD APM vol. 2
// table B-4 (the kernel's `struct sev_es_save_area`). Only the fields a
// freshly reset vCPU has a non-zero value in are written here; everything else
// is zero, which is what makes the page reproducible off-host.
//
// Offsets are spelled out rather than derived from a Go struct with reserved
// padding fields: the padding carries no meaning, and a mis-sized filler in a
// struct is a silent measurement change, while a wrong constant here is one
// the round-trip test against a real report catches immediately.
const (
	offES      = 0x000 // segment registers, 16 bytes each
	offCS      = 0x010
	offSS      = 0x020
	offDS      = 0x030
	offFS      = 0x040
	offGS      = 0x050
	offGDTR    = 0x060
	offLDTR    = 0x070
	offIDTR    = 0x080
	offTR      = 0x090
	offEFER    = 0x0d0
	offCR4     = 0x148
	offCR0     = 0x158
	offDR7     = 0x160
	offDR6     = 0x168
	offRFLAGS  = 0x170
	offRIP     = 0x178
	offGPAT    = 0x268
	offRDX     = 0x310
	offSEVFeat = 0x3b0
	offXCR0    = 0x3e8
	offMXCSR   = 0x408
	offX87FCW  = 0x410
)

// bspEIP is the x86 reset vector the bootstrap processor starts at.
const bspEIP uint32 = 0xffff_fff0

// GuestFeaturesSNPActive is the guest-features word Super Protocol VMs launch
// with: SNPActive and nothing else. It lands in the save area's SEV_FEATURES
// field and is therefore measured.
const GuestFeaturesSNPActive uint64 = 0x1

// saveArea renders one VM save area page for a vCPU whose reset EIP is eip.
//
// Only the QEMU VMM layout is implemented. The platform launches its VMs under
// QEMU, and the EC2/GCE/krun variants differ in fields that are measured — so
// guessing one of them would produce a confidently wrong digest rather than a
// failure.
func saveArea(eip uint32, guestFeatures uint64, vcpuSig uint32) []byte {
	page := make([]byte, pageSize)
	seg := func(offset int, selector, attrib uint16, limit uint32, base uint64) {
		binary.LittleEndian.PutUint16(page[offset:], selector)
		binary.LittleEndian.PutUint16(page[offset+2:], attrib)
		binary.LittleEndian.PutUint32(page[offset+4:], limit)
		binary.LittleEndian.PutUint64(page[offset+8:], base)
	}
	u64 := func(offset int, v uint64) { binary.LittleEndian.PutUint64(page[offset:], v) }

	seg(offES, 0, 0x93, 0xffff, 0)
	seg(offCS, 0xf000, 0x9b, 0xffff, uint64(eip&0xffff0000))
	seg(offSS, 0, 0x93, 0xffff, 0)
	seg(offDS, 0, 0x93, 0xffff, 0)
	seg(offFS, 0, 0x93, 0xffff, 0)
	seg(offGS, 0, 0x93, 0xffff, 0)
	seg(offGDTR, 0, 0, 0xffff, 0)
	seg(offLDTR, 0, 0x82, 0xffff, 0)
	seg(offIDTR, 0, 0, 0xffff, 0)
	seg(offTR, 0, 0x8b, 0xffff, 0)

	u64(offEFER, 0x1000) // KVM sets EFER.SVME.
	u64(offCR4, 0x40)    // KVM sets CR4.MCE.
	u64(offCR0, 0x10)    // CR0.ET, the x86 reset value.
	u64(offDR7, 0x400)
	u64(offDR6, 0xffff0ff0)
	u64(offRFLAGS, 0x2)
	u64(offRIP, uint64(eip&0xffff))
	u64(offGPAT, 0x0007040600070406) // PAT MSR reset value, AMD APM vol. 2 A.3.
	u64(offRDX, uint64(vcpuSig))     // QEMU leaves the CPUID signature in RDX.
	u64(offSEVFeat, guestFeatures)
	u64(offXCR0, 0x1)
	binary.LittleEndian.PutUint32(page[offMXCSR:], 0x1f80)
	binary.LittleEndian.PutUint16(page[offX87FCW:], 0x37f)
	return page
}
