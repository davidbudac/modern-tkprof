package remote

import (
	"regexp"
	"strings"
)

var fingerprintRe = regexp.MustCompile(`\b(SHA256:[A-Za-z0-9+/]{43}=?|MD5(?::[0-9a-f]{2}){16})`)

// ClassifyPrompt maps the text of an OpenSSH prompt (SSH_ASKPASS argument
// or keyboard-interactive question) to a prompt kind, with the host key
// fingerprint for KindHostKey:
//
//	"...Are you sure you want to continue connecting (yes/no/[fingerprint])?"  hostkey
//	"Enter passphrase for key '/home/u/.ssh/id_ed25519': ", "Enter PIN for ..."  passphrase
//	"Verification code: ", "One-time password (OATH) for ...", "OTP: "          otp
//	"oracle@dbmint's password: ", "(oracle@dbmint) Password: "                  password
//	anything else                                                                confirm
func ClassifyPrompt(text string) (kind, fingerprint string) {
	t := strings.ToLower(text)
	switch {
	case strings.Contains(t, "continue connecting") || strings.Contains(t, "authenticity of host"):
		return KindHostKey, fingerprintRe.FindString(text)
	case strings.Contains(t, "passphrase") || strings.Contains(t, "enter pin"):
		return KindPassphrase, ""
	case strings.Contains(t, "verification code") || strings.Contains(t, "one-time") || strings.Contains(t, "otp") ||
		strings.Contains(t, "passcode") || strings.Contains(t, "token code") || strings.Contains(t, "authenticator"):
		return KindOTP, ""
	case strings.Contains(t, "password"):
		return KindPassword, ""
	}
	return KindConfirm, ""
}
