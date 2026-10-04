//go:build !linux

package qiyun

import (
	"context"
	"errors"
)

func Helper(context.Context, Config, string) error {
	return errors.New("privileged helper is Linux-only")
}
func lockState(dir string) (func(), error) { return func() {}, nil }
