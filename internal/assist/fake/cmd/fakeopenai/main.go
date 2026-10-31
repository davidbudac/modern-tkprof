// Command fakeopenai serves the scripted OpenAI-compatible fake of package
// fake, to point an assistant provider at:
//
//	go run ./internal/assist/fake/cmd/fakeopenai [-listen 127.0.0.1:0] [-script file.json]
//
// It prints one line, {"ready":true,"addr":"127.0.0.1:N","baseUrl":"http://127.0.0.1:N/v1"},
// logs each request on stderr, serves GET /fake/requests (what it got), and
// runs until interrupted. Without -script it loops over a turn that calls
// overview and then answers.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/davidbudac/modern-tkprof/internal/assist/fake"
)

var demo = fake.Script{Loop: true, Steps: []fake.Step{
	{ToolCalls: []fake.ToolCall{{Name: "overview", Arguments: "{}"}}},
	{Text: "The fake model read the overview. See [the overview](mtkprof:#view=overview).", DeltaDelayMs: 20},
}}

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "address to listen on")
	script := flag.String("script", "", "script file (JSON, fake.Script); default: a demo turn, looped")
	flag.Parse()
	s := demo
	if *script != "" {
		var err error
		if s, err = fake.Load(*script); err != nil {
			fmt.Fprintf(os.Stderr, "fakeopenai: %v\n", err)
			os.Exit(2)
		}
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakeopenai: %v\n", err)
		os.Exit(1)
	}
	addr := ln.Addr().String()
	b, _ := json.Marshal(map[string]any{"ready": true, "addr": addr, "baseUrl": "http://" + addr + "/v1"})
	fmt.Println(string(b))
	srv := &http.Server{Handler: &fake.OpenAI{Script: s, Log: os.Stderr}}
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		srv.Close()
	}()
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "fakeopenai: %v\n", err)
		os.Exit(1)
	}
}
