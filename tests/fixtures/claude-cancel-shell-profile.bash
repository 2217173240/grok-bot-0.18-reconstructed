printf '%s\n' "$$" > "$CLAUDE_SHELL_TEST_DIR/snapshot-shell.pid.tmp"
mv "$CLAUDE_SHELL_TEST_DIR/snapshot-shell.pid.tmp" "$CLAUDE_SHELL_TEST_DIR/snapshot-shell.pid"
sleep 30
printf 'completed\n' > "$CLAUDE_SHELL_TEST_DIR/snapshot-shell.completed"
