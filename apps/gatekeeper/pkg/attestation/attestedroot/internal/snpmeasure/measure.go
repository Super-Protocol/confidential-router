package snpmeasure

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

// CPUSig encodes a family/model/stepping triple the way CPUID leaf 1 does
// (AMD publication 25481). It is the value QEMU leaves in RDX at reset, so it
// is measured — and it is why the same image on two CPU models does not
// produce the same launch digest.
func CPUSig(family, model, stepping int) uint32 {
	familyLow, familyHigh := family, 0
	if family > 0xf {
		familyLow = 0xf
		familyHigh = (family - 0xf) & 0xff
	}
	return uint32(familyHigh<<20 |
		((model>>4)&0xf)<<16 |
		(familyLow&0xf)<<8 |
		(model&0xf)<<4 |
		stepping&0xf)
}

// MilanCPUSig is the canonical CPU the normalised measurement is computed for:
// AMD EPYC Milan, family 25, model 1, stepping 1 (sp-vm/docs/04-vm-measurements.md
// §"Normalization"). Together with a single vCPU it is what makes one published
// reference value cover every VM size of the same image.
var MilanCPUSig = CPUSig(25, 1, 1)

// The vMPL and guest policy the normalised measurement is wrapped with. They
// are constants of the normalisation, not of the VM: the running VM's own
// values are only used to check the report against itself.
const (
	normalizedVMPL   uint32 = 0
	normalizedPolicy uint64 = 0x30000
)

// LaunchDigest reproduces the 48-byte SEV-SNP launch measurement of a VM
// booted from fw with the given kernel artefacts, CPU signature and vCPU count.
//
// The order of operations is fixed by the firmware: the OVMF image, then each
// metadata section in the order the image lists them, then one VMSA page per
// vCPU.
func LaunchDigest(fw *Firmware, hashes Hashes, cpuSig uint32, vcpus int) ([]byte, error) {
	if fw == nil {
		return nil, errors.New("snpmeasure: no firmware")
	}
	if vcpus < 1 {
		return nil, fmt.Errorf("snpmeasure: vcpu count is %d, expected at least 1", vcpus)
	}

	d := newDigest(fw.Seed)
	sawKernelHashes := false
	for i, section := range fw.Sections {
		if err := section.validate(i); err != nil {
			return nil, err
		}
		gpa := uint64(section.GPA)
		var err error
		switch section.Type {
		case SectionSNPSecMemory, SectionSVSMCaa:
			err = d.emptyPages(pageZero, gpa, int(section.Size))
		case SectionSNPSecrets:
			err = d.emptyPages(pageSecrets, gpa, pageSize)
		case SectionCPUID:
			err = d.emptyPages(pageCPUID, gpa, pageSize)
		case SectionSNPKernelHashes:
			sawKernelHashes = true
			if section.Size != pageSize {
				err = fmt.Errorf("snpmeasure: kernel hashes section is %d bytes, expected one page", section.Size)
				break
			}
			var page []byte
			if page, err = hashes.hashesPage(fw.HashesTableGPA); err == nil {
				err = d.normalPages(gpa, page)
			}
		}
		if err != nil {
			return nil, err
		}
	}
	if !sawKernelHashes {
		// Measuring the artefact hashes is the whole reason a build identifier
		// is enough to re-derive the digest. A firmware without the section
		// boots kernels nothing vouches for, so it is rejected rather than
		// measured as if the hashes had been checked.
		return nil, errors.New("snpmeasure: firmware has no SNP_KERNEL_HASHES section")
	}

	bsp := saveArea(bspEIP, GuestFeaturesSNPActive, cpuSig)
	ap := saveArea(fw.ResetEIP, GuestFeaturesSNPActive, cpuSig)
	for i := 0; i < vcpus; i++ {
		page := ap
		if i == 0 {
			page = bsp
		}
		if err := d.vmsaPage(page); err != nil {
			return nil, err
		}
	}
	return d.value(), nil
}

// Wrap turns a 48-byte launch measurement into the 32-byte identifier the rest
// of the platform calls `mrEnclave`: SHA-256(measurement ‖ vmpl ‖ policy), with
// vmpl a little-endian uint32 and policy a little-endian uint64.
func Wrap(measurement []byte, vmpl uint32, policy uint64) []byte {
	buf := make([]byte, 0, len(measurement)+12)
	buf = append(buf, measurement...)
	buf = binary.LittleEndian.AppendUint32(buf, vmpl)
	buf = binary.LittleEndian.AppendUint64(buf, policy)
	sum := sha256.Sum256(buf)
	return sum[:]
}

// Normalize is the whole SEV-SNP measurement flow of
// sp-vm/docs/04-vm-measurements.md §5, in one call.
//
// It first reproduces the launch digest of the VM as it actually ran and
// requires it to equal the hardware MEASUREMENT — without that check a build
// identifier would be an unverified claim about which artefacts booted. Only
// then does it recompute the digest for the canonical single-Milan-core
// configuration and return its wrapped form, which is what the signed-measurement
// registry indexes.
func Normalize(fw *Firmware, hashes Hashes, report Report) ([]byte, error) {
	actual, err := LaunchDigest(fw, hashes, report.CPUSig, report.Cores)
	if err != nil {
		return nil, err
	}
	if len(report.Measurement) != len(actual) || !equal(actual, report.Measurement) {
		return nil, fmt.Errorf(
			"snpmeasure: the launch digest of build %q (%x) does not match the attestation report's MEASUREMENT (%x)",
			report.Build, actual, report.Measurement)
	}

	single, err := LaunchDigest(fw, hashes, MilanCPUSig, 1)
	if err != nil {
		return nil, err
	}
	return Wrap(single, normalizedVMPL, normalizedPolicy), nil
}

// Report is the part of a SEV-SNP attestation report, plus the supporting
// fields published alongside it, that the measurement needs.
type Report struct {
	// Measurement is the 48-byte hardware launch measurement.
	Measurement []byte
	// CPUSig and Cores are what the VM was launched with. They are supporting
	// evidence, not report fields, so they only ever serve to check the report
	// against itself.
	CPUSig uint32
	Cores  int
	// Build identifies the sp-vm release the firmware and kernel came from.
	Build string
}

func equal(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
