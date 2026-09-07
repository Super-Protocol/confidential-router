package snpmeasure

import (
	"crypto/sha512"
	"encoding/binary"
	"fmt"
)

// pageSize is the SNP page granularity; every measured region is a whole
// number of these.
const pageSize = 4096

// vmsaGPA is the address the RMP records a VMSA page under: (u64)(-1),
// page-aligned with the bits above 51 cleared (SNP ABI 8.17.2).
const vmsaGPA = 0xFFFF_FFFF_F000

// Page types of the PAGE_INFO structure the firmware digests (SNP ABI table
// 67). They are part of the hash, so a page measured under the wrong type
// produces a different — and therefore rejected — digest.
const (
	pageNormal  = 0x01
	pageVMSA    = 0x02
	pageZero    = 0x03
	pageSecrets = 0x05
	pageCPUID   = 0x06
)

// digest is the running launch digest: 48 bytes extended once per measured
// page, exactly as SNP_LAUNCH_UPDATE does in firmware.
type digest struct{ ld []byte }

// newDigest starts a digest from a seed, or from zero when seed is nil. A seed
// is how the firmware's own pages are skipped once they have been measured
// before (sp-sev's `ovmf_hash_str`).
func newDigest(seed []byte) *digest {
	if seed == nil {
		return &digest{ld: make([]byte, sha512.Size384)}
	}
	ld := make([]byte, len(seed))
	copy(ld, seed)
	return &digest{ld: ld}
}

func (d *digest) value() []byte {
	out := make([]byte, len(d.ld))
	copy(out, d.ld)
	return out
}

// extend folds one page into the digest. The PAGE_INFO layout is fixed at
// 0x70 bytes: the previous digest, the page's contents digest, the length, the
// page type and permission bytes, then the guest physical address.
func (d *digest) extend(pageType byte, gpa uint64, contents []byte) error {
	if len(contents) != sha512.Size384 {
		return fmt.Errorf("page contents digest is %d bytes, expected %d", len(contents), sha512.Size384)
	}
	if len(d.ld) != sha512.Size384 {
		return fmt.Errorf("launch digest is %d bytes, expected %d", len(d.ld), sha512.Size384)
	}

	info := make([]byte, 0, 0x70)
	info = append(info, d.ld...)
	info = append(info, contents...)
	info = binary.LittleEndian.AppendUint16(info, 0x70)
	// pageType, then IMI, VMPL3/2/1 permissions and one reserved byte — all
	// zero for every page a launch measures.
	info = append(info, pageType, 0, 0, 0, 0, 0)
	info = binary.LittleEndian.AppendUint64(info, gpa)
	if len(info) != 0x70 {
		return fmt.Errorf("PAGE_INFO is %d bytes, expected 0x70", len(info))
	}

	sum := sha512.Sum384(info)
	d.ld = sum[:]
	return nil
}

// normalPages measures data page by page from startGPA.
func (d *digest) normalPages(startGPA uint64, data []byte) error {
	if len(data)%pageSize != 0 {
		return fmt.Errorf("normal region is %d bytes, not a multiple of the page size", len(data))
	}
	for offset := 0; offset < len(data); offset += pageSize {
		sum := sha512.Sum384(data[offset : offset+pageSize])
		if err := d.extend(pageNormal, startGPA+uint64(offset), sum[:]); err != nil {
			return err
		}
	}
	return nil
}

// emptyPages measures length bytes of pages whose contents the firmware does
// not hash — zero, secrets and CPUID pages all contribute a zero digest and
// differ only in their page type.
func (d *digest) emptyPages(pageType byte, gpa uint64, length int) error {
	if length%pageSize != 0 || length <= 0 {
		return fmt.Errorf("region is %d bytes, not a positive multiple of the page size", length)
	}
	zero := make([]byte, sha512.Size384)
	for offset := 0; offset < length; offset += pageSize {
		if err := d.extend(pageType, gpa+uint64(offset), zero); err != nil {
			return err
		}
	}
	return nil
}

// vmsaPage measures one VM save area. Unlike every other page it is recorded
// at a fixed address, so all vCPUs extend the digest under the same GPA.
func (d *digest) vmsaPage(page []byte) error {
	if len(page) != pageSize {
		return fmt.Errorf("VMSA page is %d bytes, expected %d", len(page), pageSize)
	}
	sum := sha512.Sum384(page)
	return d.extend(pageVMSA, vmsaGPA, sum[:])
}
