package sshtest

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The fake ssh and sftp are POSIX shell scripts (tests that use them skip
// on Windows). Their behaviour is set by environment variables:
//
//	FAKE_SSH_DIR            where every run writes argv.<seq> (one argument per
//	                        line) and env.<seq>; sftp also writes batch.<seq>
//	FAKE_SSH_HOSTKEY=1      ask OpenSSH's unknown-host question through
//	                        SSH_ASKPASS first; anything but "yes" fails
//	FAKE_SSH_PASSWORD=pw    ask "<user>@<host>'s password: " through SSH_ASKPASS
//	                        (3 tries, as OpenSSH)
//	FAKE_SSH_IGNORE_ASKPASS=1  behave like Windows' ssh.exe that ignores
//	                        SSH_ASKPASS: print the password prompt and
//	                        "Permission denied" on stderr, exit 255
//	FAKE_SSH_NO_GZIP=1      the host has no gzip (`command -v gzip` fails)
//	FAKE_SFTP_LS=file       what sftp prints for `ls -ln ...`
//	FAKE_SSH_SLOW=seconds   the remote output goes out one line per interval
//
// ssh runs the remote command with the local sh; sftp echoes each batch
// command as "sftp> cmd" like OpenSSH's sftp -b.

const fakeAsk = `
if [ -n "$FAKE_SSH_HOSTKEY" ]; then
  a=$("$SSH_ASKPASS" "The authenticity of host '[$host]:$port ([127.0.0.1]:$port)' can't be established.
ED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  [ "$a" = yes ] || { echo "Host key verification failed." >&2; exit 255; }
fi
if [ -n "$FAKE_SSH_IGNORE_ASKPASS" ]; then
  printf "%s@%s's password: \nPermission denied, please try again.\n" "$user" "$host" >&2
  exit 255
fi
if [ -n "$FAKE_SSH_PASSWORD" ]; then
  ok=
  for i in 1 2 3; do
    a=$("$SSH_ASKPASS" "$user@$host's password: ") || break
    if [ "$a" = "$FAKE_SSH_PASSWORD" ]; then ok=1; break; fi
    echo "Permission denied, please try again." >&2
  done
  [ -n "$ok" ] || { echo "$user@$host: Permission denied (publickey,password)." >&2; exit 255; }
fi
`

const fakeSSH = `#!/bin/sh
seq=$(date +%s%N)-$$
[ -n "$FAKE_SSH_DIR" ] && { printf '%s\n' "$@" > "$FAKE_SSH_DIR/argv.$seq"; env > "$FAKE_SSH_DIR/env.$seq"; }
user=$USER; port=22; control=
while [ $# -gt 0 ]; do
  case "$1" in
    -l) user=$2; shift 2 ;;
    -p) port=$2; shift 2 ;;
    -O) control=$2; shift 2 ;;
    -o) case "$2" in User=*) user=${2#User=} ;; Port=*) port=${2#Port=} ;; esac; shift 2 ;;
    -F|-i|-S|-J|-E|-b|-c|-m|-D|-L|-R|-W|-w|-e|-I|-Q|-B) shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
host=$1; shift
[ -n "$control" ] && exit 0
` + fakeAsk + `
cmd="$*"
case "$cmd" in
  *"command -v gzip"*) [ -n "$FAKE_SSH_NO_GZIP" ] && exit 1 ;;
esac
if [ -n "$FAKE_SSH_SLOW" ]; then
  sh -c "$cmd" | while IFS= read -r l; do printf '%s\n' "$l"; sleep "$FAKE_SSH_SLOW"; done
  exit 0
fi
exec sh -c "$cmd"
`

const fakeSFTP = `#!/bin/sh
seq=$(date +%s%N)-$$
[ -n "$FAKE_SSH_DIR" ] && { printf '%s\n' "$@" > "$FAKE_SSH_DIR/argv.$seq"; env > "$FAKE_SSH_DIR/env.$seq"; }
user=$USER; port=22
while [ $# -gt 0 ]; do
  case "$1" in
    -P) port=$2; shift 2 ;;
    -o) case "$2" in User=*) user=${2#User=} ;; Port=*) port=${2#Port=} ;; esac; shift 2 ;;
    -b|-F|-i|-S|-B|-D|-l|-R|-s|-J|-X) shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
host=$1
case "$host" in *@*) user=${host%%@*}; host=${host#*@} ;; esac
host=${host#\[}; host=${host%\]}
` + fakeAsk + `
while IFS= read -r line; do
  [ -n "$FAKE_SSH_DIR" ] && echo "$line" >> "$FAKE_SSH_DIR/batch.$seq"
  echo "sftp> $line"
  case "$line" in
    ls\ *) if [ -n "$FAKE_SFTP_LS" ]; then cat "$FAKE_SFTP_LS"; else echo "Can't ls: not found" >&2; exit 1; fi ;;
    *) echo "Invalid command." >&2; exit 1 ;;
  esac
done
exit 0
`

// WriteFakes writes the fake ssh and sftp into dir (put it first on PATH).
func WriteFakes(dir string) error {
	for name, body := range map[string]string{"ssh": fakeSSH, "sftp": fakeSFTP} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
			return err
		}
	}
	return nil
}

// Call is one recorded run of a fake.
type Call struct {
	Args  []string
	Env   map[string]string
	Batch []string // sftp: the batch commands read
}

// Calls reads the runs recorded in dir (FAKE_SSH_DIR), oldest first.
func Calls(dir string) []Call {
	names, _ := filepath.Glob(filepath.Join(dir, "argv.*"))
	sort.Strings(names)
	var out []Call
	for _, n := range names {
		seq := strings.TrimPrefix(filepath.Base(n), "argv.")
		var c Call
		if b, err := os.ReadFile(n); err == nil {
			c.Args = strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
		}
		c.Env = map[string]string{}
		if b, err := os.ReadFile(filepath.Join(dir, "env."+seq)); err == nil {
			for _, l := range strings.Split(string(b), "\n") {
				if k, v, ok := strings.Cut(l, "="); ok {
					c.Env[k] = v
				}
			}
		}
		if b, err := os.ReadFile(filepath.Join(dir, "batch."+seq)); err == nil {
			c.Batch = strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
		}
		out = append(out, c)
	}
	return out
}
