//go:build race

package opt

// raceOn is set when the tests run under the race detector, which makes the throughput tests meaningless.
const raceOn = true
