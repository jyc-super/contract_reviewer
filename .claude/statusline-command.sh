#!/usr/bin/env bash
# Claude Code status line script

input=$(cat)

# Current directory (basename only)
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
dir=$(basename "$cwd")

# Git branch (skip lock to avoid conflicts)
branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)

# Claude model display name
model=$(echo "$input" | jq -r '.model.display_name // ""')

# Context window usage
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Build the status line with ANSI colors
# Colors: cyan for dir, green for branch, blue for model, yellow for context
printf "\033[36m%s\033[0m" "$dir"

if [ -n "$branch" ]; then
  printf " \033[32m(%s)\033[0m" "$branch"
fi

if [ -n "$model" ]; then
  printf " \033[34m%s\033[0m" "$model"
fi

if [ -n "$used" ]; then
  # Pick color based on usage: green < 50, yellow < 80, red >= 80
  used_int=${used%.*}
  if [ "$used_int" -ge 80 ] 2>/dev/null; then
    printf " \033[31mctx:%s%%\033[0m" "$used_int"
  elif [ "$used_int" -ge 50 ] 2>/dev/null; then
    printf " \033[33mctx:%s%%\033[0m" "$used_int"
  else
    printf " \033[32mctx:%s%%\033[0m" "$used_int"
  fi
fi
