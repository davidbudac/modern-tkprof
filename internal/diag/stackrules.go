package diag

import "strings"

// The dump's own frames. A diagnostic dump is written by a function of the instance that was asked to
// write it, so the first frames of its call stack are the dump's machinery and not what the process was
// doing; a client folds them. The rule, derived from the stacks of the fixtures:
//
//	the dump's own frames are the leading frames whose function starts with one of ownPrefixes
//	(the first frame that does not, and everything after it, is the process's)
//
//	prefix    what it is                                          fixture (frame numbers, innermost first)
//	ksedst    ksedst1, ksedst: print the stack                    every stack: frames 1-2
//	ksedmp    ksedmp: the dump entry                              every stack: frame 4
//	dbkedDef  dbkedDefDump: the diagnostic dump itself            every stack: frame 3
//	dbk, dbg  the diagnostic framework that runs the request:     diag_errorstack_l2: frames 5-10 (dbkdaKsdActDriver,
//	          dbkda*, dbgda*, dbgd*, dbkd* (an errorstack,         dbgdaExecuteAction, dbgdaRunAction, dbgdRunActions,
//	          an event action), dbgex*, dbge* (an incident)        dbgdParseCmd, dbkdParseCmd) then kkyase, the
//	                                                              statement that asked; diag_in_10046: frames 5-11
//	                                                              (... dbgdProcessEventActions, dbgdChkEventKgErr,
//	                                                              dbkdChkEventRdbmsErr) then qcsprfro, where the error
//	                                                              was raised; big/diag_oom_incident: frames 5-8
//	                                                              (dbgexPhaseII, dbgexProcessError,
//	                                                              dbgePostErrorDirectVaList_int, dbgePostErrorDirect)
//	                                                              then pevm_peruws_callback, which raised it
//
// A function that asked for the dump from the instance's own code stays the process's: diag_deadlock frame 5
// is ksqdld_hdr_dump, which wrote the deadlock graph and asked for the dump, and it is not folded.
//
// The short stack that a system state or hang analysis prints per process (ksedsts()+426<-ksdxfstk()+63<-
// ksdxcb()+872<-sspuser()+223<-__sighandler()<-semtimedop()+14<-...) has its own prefix too, of the signal
// handler that took it (big/diag_sysstate_l266:50318): the functions up to and including __sighandler.
var ownPrefixes = []string{"ksedst", "ksedmp", "dbkedDef", "dbk", "dbg"}

// ownStackFunctions are the functions of the signal handler path that opens the short stack of a process
// in a system state or hang analysis, in order.
var ownStackFunctions = []string{"ksedsts", "ksdxfstk", "ksdxcb", "sspuser", "__sighandler"}

// ownFrame: the frame of this function (no parentheses, no offset) is the dump's own.
func ownFrame(fn string) bool {
	for _, p := range ownPrefixes {
		if strings.HasPrefix(fn, p) {
			return true
		}
	}
	return false
}

// leadingOwn counts the leading functions of a stack that are the dump's own.
func leadingOwn(fns []string) int {
	n := 0
	for n < len(fns) && ownFrame(fns[n]) {
		n++
	}
	return n
}

// ownShortStack counts the leading entries of a process's short stack (function names without offsets) that
// belong to the signal handler: through __sighandler when it is there, else the leading run of
// ownStackFunctions.
func ownShortStack(fns []string) int {
	for i, f := range fns {
		if f == "__sighandler" && i < 8 {
			return i + 1
		}
	}
	n := 0
	for n < len(fns) && n < len(ownStackFunctions) && fns[n] == ownStackFunctions[n] {
		n++
	}
	return n
}
