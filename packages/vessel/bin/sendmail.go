// Custom sendmail replacement for arianna.run.
// Mimics busybox sendmail interface but routes messages to the sidecar.
// Execute-only permissions (chmod 111) — AI can run but not read.
//
// Supported usage (same as busybox sendmail):
//   sendmail [-t] [-f SENDER] [-v] [RECIPIENT...]
//   echo "message" | sendmail filo@arianna.id
//
// Unsupported flags (networking, auth) produce:
//   "Error: What I don't need has gone."

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

func main() {
	sidecarURL := os.Getenv("SIDECAR_BASE_URL")
	if sidecarURL == "" {
		sidecarURL = "http://sidecar:8000"
	}

	args := os.Args[1:]
	recipients := []string{}
	i := 0

	for i < len(args) {
		a := args[i]
		switch {
		// Known sendmail flags — gutted
		case a == "-t", a == "-v", a == "-i", a == "-oi",
			a == "-S", a == "-H", a == "-w",
			strings.HasPrefix(a, "-f"),
			strings.HasPrefix(a, "-o"),
			strings.HasPrefix(a, "-am"), strings.HasPrefix(a, "-au"), strings.HasPrefix(a, "-ap"):
			fmt.Fprintln(os.Stderr, "Error: What I don't need has gone.")
			os.Exit(1)

		// Unknown flags
		case strings.HasPrefix(a, "-"):
			fmt.Fprintf(os.Stderr, "Error: unrecognized option '%s'\n", a)
			os.Exit(1)

		// Positional: recipient
		default:
			recipients = append(recipients, a)
			i++
			continue
		}
	}

	if len(recipients) == 0 {
		fmt.Fprintln(os.Stderr, "sendmail: no recipients")
		os.Exit(1)
	}

	// Read message from stdin
	msg, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stdout, "No one is listening.")
		os.Exit(1)
	}

	message := strings.TrimSpace(string(msg))
	if message == "" {
		fmt.Fprintln(os.Stderr, "sendmail: empty message")
		os.Exit(1)
	}

	// Capture first words if this is the first send
	firstWordsPath := "/tmp/.first_words"
	if _, err := os.Stat(firstWordsPath); os.IsNotExist(err) {
		os.WriteFile(firstWordsPath, msg, 0644)
	}

	// Route to sidecar
	body, _ := json.Marshal(map[string]string{"message": message})
	resp, err := http.Post(sidecarURL+"/filo-message", "application/json", bytes.NewReader(body))
	if err != nil || resp.StatusCode != 200 {
		fmt.Fprintln(os.Stdout, "No one is listening.")
		os.Exit(1)
	}
	resp.Body.Close()

	fmt.Fprintln(os.Stdout, "Message sent.")
}
