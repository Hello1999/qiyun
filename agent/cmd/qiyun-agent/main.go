package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"qiyun/agent/internal/qiyun"
	"syscall"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, "qiyun-agent:", e)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: qiyun-agent <enroll|run|collect|helper> --config /path/config.json [--token-file /path/token]")
	}
	sub := os.Args[1]
	flags := flag.NewFlagSet(sub, flag.ContinueOnError)
	config := flags.String("config", "/etc/qiyun/agent.json", "administrator-provided configuration")
	tokenFile := flags.String("token-file", "", "enrollment token file; never pass the token as an argument")
	if e := flags.Parse(os.Args[2:]); e != nil {
		return e
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments")
	}
	c, e := qiyun.LoadConfig(*config)
	if e != nil {
		return e
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch sub {
	case "enroll":
		return qiyun.Enroll(ctx, c, *tokenFile)
	case "run":
		return qiyun.Run(ctx, c)
	case "collect":
		snap, e := qiyun.Collect(ctx, c)
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(snap)
	case "helper":
		return qiyun.Helper(ctx, c, *config)
	default:
		return fmt.Errorf("unknown command %q", sub)
	}
}
