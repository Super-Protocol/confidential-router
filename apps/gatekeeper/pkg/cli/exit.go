package cli

import (
	"errors"
	"fmt"
)

// Exit codes. They are part of the interface: `gatekeeper verify` in a
// deployment script needs to tell "this endpoint is not trustworthy" from "I
// could not read your config".
const (
	// ExitOK is success.
	ExitOK = 0
	// ExitError is any failure that is not one of the specific cases below.
	ExitError = 1
	// ExitUsage is a malformed command line.
	ExitUsage = 2
	// ExitDenied means the command ran and the answer was no: an endpoint that
	// failed verification, a bundle the policies rejected.
	ExitDenied = 3
	// ExitConfig means the configuration is missing or invalid.
	ExitConfig = 4
	// ExitUnavailable means the command needs a capability this build does not
	// have wired in (sysexits.h EX_UNAVAILABLE).
	ExitUnavailable = 69
)

// exitError carries the exit code a failure should produce. Every command
// returns errors; only this type changes the code away from ExitError.
type exitError struct {
	code int
	err  error
}

func (e *exitError) Error() string { return e.err.Error() }
func (e *exitError) Unwrap() error { return e.err }

// failf builds an error that exits with a specific code.
func failf(code int, format string, args ...any) error {
	return &exitError{code: code, err: fmt.Errorf(format, args...)}
}

// silent is the error a command returns when it has already printed the whole
// story and only needs to set the exit status — a denied verification, a config
// whose problems were just listed. Printing "gatekeeper: denied" underneath a
// full report would only add noise.
var errSilent = errors.New("")

// silentf returns a code-carrying error with nothing left to say.
func silentf(code int) error { return &exitError{code: code, err: errSilent} }

// wrap attaches an exit code to an existing error.
func wrap(code int, err error) error {
	if err == nil {
		return nil
	}
	return &exitError{code: code, err: err}
}

// codeOf maps an error to the process exit status.
func codeOf(err error) int {
	if err == nil {
		return ExitOK
	}
	var exit *exitError
	if errors.As(err, &exit) {
		return exit.code
	}
	return ExitError
}
