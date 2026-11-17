package azurecvm

import (
	"bytes"
	"crypto/sha256"
)

// calculateMrEnclave computes
//
//	mrEnclave = SHA-256(vmConfigFlags ‖ PCR4′ ‖ PCR9′)
//
// PCRn′ replays the PCRn events like the TPM did, except for the informational
// events the paravisor firmware adds around boot applications (EV_EFI_ACTION
// and EV_SEPARATOR). An event is dropped only if its digest is the SHA-256 of
// its own data: the event type is not covered by any digest, so the type alone
// cannot be trusted, but a self-describing event cannot hide a measured binary.
//
// The result covers the boot chain the image controls (the bootloader, the
// kernel and the kernel command line, which pins the dm-verity root hash) and
// the VM configuration flags, but not the Microsoft paravisor (MRTD, PCR0-3) or
// the VM size.
func calculateMrEnclave(vmConfigFlags []byte, events []tcgEvent) []byte {
	measured := func(event tcgEvent) bool {
		if event.eventType != evEFIAction && event.eventType != evSeparator {
			return true
		}
		selfDigest := sha256.Sum256(event.data)
		return !bytes.Equal(event.digest, selfDigest[:])
	}

	input := append([]byte{}, vmConfigFlags...)
	for _, pcr := range quotedPCRs {
		input = append(input, extendPCR(events, pcr, measured)...)
	}
	sum := sha256.Sum256(input)
	return sum[:]
}
