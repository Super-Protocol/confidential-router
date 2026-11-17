package snpmeasure

import (
	"encoding/binary"
	"fmt"
)

// The GUIDs QEMU writes into the kernel hashes table. Order matters: cmdline,
// initrd, kernel, in that sequence, because the page is compared byte for byte
// against what QEMU built.
const (
	guidHashTableHeader = "9438d606-4f22-4cc9-b479-a793d411fd21"
	guidKernelEntry     = "4de79437-abd2-427f-b835-d5b172d2045b"
	guidInitrdEntry     = "44baf731-3a2f-4bd7-9af1-41e29169781d"
	guidCmdlineEntry    = "97d02dd8-bd20-4c94-aa78-e7714d36ab2a"
)

// hashEntrySize is one table entry: a 16-byte GUID, a uint16 length and a
// 32-byte SHA-256. hashTableSize is the header plus the three entries, and
// paddedTableSize rounds that up to 16 bytes the way QEMU does.
const (
	hashEntrySize   = 16 + 2 + 32
	hashTableSize   = 16 + 2 + 3*hashEntrySize
	paddedTableSize = (hashTableSize + 15) &^ 15
)

// Hashes are the SHA-256 digests of the kernel, the initrd and the kernel
// command line that the VM was launched with. They reach the guest through a
// page QEMU writes at the firmware's SEV_HASH_TABLE_RV address, and they are
// measured, so they pin the boot artefacts without the verifier ever
// downloading them.
type Hashes struct {
	Kernel  [32]byte
	Initrd  [32]byte
	Cmdline [32]byte
}

// hashesPage renders the page exactly as QEMU builds it: the table written at
// the table address's offset within its page, zero everywhere else.
func (h Hashes) hashesPage(tableGPA uint32) ([]byte, error) {
	offset := int(tableGPA % pageSize)
	if offset+paddedTableSize > pageSize {
		return nil, fmt.Errorf("kernel hashes table at offset %d does not fit in a page", offset)
	}

	header, err := guidLE(guidHashTableHeader)
	if err != nil {
		return nil, err
	}

	page := make([]byte, pageSize)
	table := page[offset:]
	copy(table, header[:])
	binary.LittleEndian.PutUint16(table[16:], hashTableSize)

	next := 18
	for _, entry := range []struct {
		guid string
		hash [32]byte
	}{
		{guidCmdlineEntry, h.Cmdline},
		{guidInitrdEntry, h.Initrd},
		{guidKernelEntry, h.Kernel},
	} {
		guid, err := guidLE(entry.guid)
		if err != nil {
			return nil, err
		}
		copy(table[next:], guid[:])
		binary.LittleEndian.PutUint16(table[next+16:], hashEntrySize)
		copy(table[next+18:], entry.hash[:])
		next += hashEntrySize
	}
	return page, nil
}
